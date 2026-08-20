#!/usr/bin/env bash
# ============================================================================
# Self-hosted migration repair. Idempotent, ledger-backed, multi-pass.
#   bash deploy/repair-vps-migrations.sh
# Behaviour:
#   - public._applied_migrations is the ledger; listed files are skipped.
#   - every file is normalized (idempotent DDL) and applied in ONE transaction.
#   - benign "already exists"/"does not exist" failures mark the file applied.
#   - other failures are retried in later passes (max 5) before hard-failing.
# ============================================================================
set -Eeuo pipefail

REPO_DIR="${REPO_DIR:-/opt/smmpanel}"
SUPA_DIR="${SUPA_DIR:-/opt/supabase}"
BACKUP_DIR="${BACKUP_DIR:-/opt/backups/smmpanel}"
DB_USER="${DB_USER:-postgres}"
DB_NAME="${DB_NAME:-postgres}"
MAX_PASSES="${MAX_PASSES:-5}"
SKIP_FUNCTIONS="${SKIP_FUNCTIONS:-0}"

log() { printf '\n==> %s\n' "$*"; }
die() { printf '\n[FAIL] %s\n' "$*" >&2; exit 1; }
trap 'die "line $LINENO failed: $BASH_COMMAND"' ERR

[ "$(id -u)" -eq 0 ] || die "run as root"
[ -d "$REPO_DIR/supabase/migrations" ] || die "migrations missing in $REPO_DIR"
[ -f "$SUPA_DIR/docker-compose.yml" ] || die "backend stack missing in $SUPA_DIR"
command -v perl >/dev/null || die "perl is required for the migration normalizer"
cd "$SUPA_DIR"
psql_db() { docker compose exec -T db psql -X -U "$DB_USER" -d "$DB_NAME" -v ON_ERROR_STOP=1 "$@"; }
scalar() { psql_db -tAc "$1" | tr -d '[:space:]'; }
sqlq() { printf "%s" "${1//\'/\'\'}"; }

log "1/8 Database readiness + required extensions"
docker compose exec -T db pg_isready -U "$DB_USER" -d "$DB_NAME" >/dev/null
for ext in pg_cron pg_net pgcrypto; do
  [ "$(scalar "SELECT EXISTS(SELECT 1 FROM pg_extension WHERE extname='$ext');")" = "t" ] \
    || die "required extension $ext is absent; do not rerun its vendor after-create script"
done
echo "extensions: pg_cron pg_net pgcrypto"

log "2/8 Compressed pre-repair backup"
install -d -m 700 "$BACKUP_DIR"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
BACKUP="$BACKUP_DIR/postgres-before-migration-repair-$STAMP.sql.gz"
docker compose exec -T db pg_dump -U "$DB_USER" -d "$DB_NAME" --no-owner --no-privileges | gzip -9 > "$BACKUP"
gzip -t "$BACKUP"
[ -s "$BACKUP" ] || die "backup is empty"
chmod 600 "$BACKUP"
echo "backup: $BACKUP ($(du -h "$BACKUP" | awk '{print $1}'))"

log "3/8 Idempotent prerequisite repair (tables, functions, provider seeds)"
psql_db -f - < "$REPO_DIR/deploy/fix-missing-tables.sql"
psql_db -f - < "$REPO_DIR/deploy/selfhost-repair.sql"

log "4/8 Migration ledger"
psql_db <<'SQL'
CREATE TABLE IF NOT EXISTS public._applied_migrations (
  name text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS public._migration_reconciliation (
  name text PRIMARY KEY,
  disposition text NOT NULL,
  reason text NOT NULL,
  reconciled_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT ON public._applied_migrations, public._migration_reconciliation TO service_role;
SQL

# Hosted-only or customer-specific migrations are never replayed on a VPS.
declare -A SPECIAL=(
  [20260327000000_fix_cron_jobs.sql]="reconciled|obsolete hosted cron replaced by local runtime registration"
  [20260405030811_5997936f-10d5-4ba7-b221-5a2e5313f67e.sql]="reconciled|non-idempotent legacy schema snapshot already represented by repaired live schema"
  [20260612095016_667f5de3-67bc-41e2-a1a8-5be47caa06c2.sql]="reconciled|hosted cron section replaced by local runtime registration"
  [20260609105116_c185e5e7-e9f5-43b7-a7fe-2723d229cc0e.sql]="quarantined|customer-specific Razorpay fee adjustment is not portable"
)
mark_applied() {
  psql_db >/dev/null <<SQL
INSERT INTO public._applied_migrations(name) VALUES ('$(sqlq "$1")') ON CONFLICT DO NOTHING;
SQL
}
mark_reconciled() {
  psql_db >/dev/null <<SQL
INSERT INTO public._migration_reconciliation(name, disposition, reason)
VALUES ('$(sqlq "$1")','$(sqlq "$2")','$(sqlq "$3")')
ON CONFLICT (name) DO UPDATE SET disposition=excluded.disposition, reason=excluded.reason, reconciled_at=now();
SQL
}
for name in "${!SPECIAL[@]}"; do
  IFS='|' read -r disposition reason <<< "${SPECIAL[$name]}"
  mark_reconciled "$name" "$disposition" "$reason"
  mark_applied "$name"
done

log "5/8 Apply migrations (normalized, ledger-backed, multi-pass)"
BENIGN='already exists|duplicate key value|duplicate object|duplicate_object|duplicate_table|duplicate_column|duplicate_function|does not exist, skipping|42710|42P07|42723|42P06|42701'
APPLIED_LIST=(); SKIPPED_LIST=(); BENIGN_LIST=(); FAILED_LIST=()
mapfile -t FILES < <(printf '%s\n' "$REPO_DIR"/supabase/migrations/*.sql | sort)
TMPDIR_MIG="$(mktemp -d)"
trap 'rm -rf "$TMPDIR_MIG"' EXIT

pending=()
for file in "${FILES[@]}"; do
  name="$(basename "$file")"
  if [ "$(scalar "SELECT EXISTS(SELECT 1 FROM public._applied_migrations WHERE name='$(sqlq "$name")');")" = "t" ]; then
    SKIPPED_LIST+=("$name"); continue
  fi
  pending+=("$file")
done
echo "pending files: ${#pending[@]} / ${#FILES[@]} (ledger skip: ${#SKIPPED_LIST[@]})"

pass=1
while [ "${#pending[@]}" -gt 0 ] && [ "$pass" -le "$MAX_PASSES" ]; do
  echo "--- pass $pass (${#pending[@]} pending) ---"
  next=(); progressed=0
  for file in "${pending[@]}"; do
    name="$(basename "$file")"
    norm="$TMPDIR_MIG/$name"
    perl "$REPO_DIR/deploy/normalize-migration.pl" < "$file" > "$norm"
    err="$TMPDIR_MIG/err.txt"
    if psql_db --single-transaction -f - < "$norm" >/dev/null 2>"$err"; then
      mark_applied "$name"; APPLIED_LIST+=("$name"); progressed=1
      echo "  [ok]     $name"
    elif grep -Eqi "$BENIGN" "$err"; then
      mark_applied "$name"
      mark_reconciled "$name" reconciled "benign duplicate-object error on replay: $(head -c 200 "$err" | tr '\n' ' ')"
      BENIGN_LIST+=("$name"); progressed=1
      echo "  [benign] $name -> $(grep -Ei 'ERROR' "$err" | head -1 | cut -c1-140)"
    else
      next+=("$file")
      echo "  [retry]  $name -> $(grep -Ei 'ERROR' "$err" | head -1 | cut -c1-140)"
      cp "$err" "$TMPDIR_MIG/last-error-$name.txt"
    fi
  done
  pending=("${next[@]+"${next[@]}"}")
  [ "$progressed" -eq 1 ] || break
  pass=$((pass+1))
done

if [ "${#pending[@]}" -gt 0 ]; then
  echo
  echo "HARD FAILURES:"
  for file in "${pending[@]}"; do
    name="$(basename "$file")"
    FAILED_LIST+=("$name")
    echo "  $name"
    sed -n '1,20p' "$TMPDIR_MIG/last-error-$name.txt" 2>/dev/null || true
  done
fi

log "6/8 Data API grants for every public table"
psql_db -f - < "$REPO_DIR/deploy/fix-grants.sql"

log "7/8 Edge functions + local cron"
if [ "$SKIP_FUNCTIONS" != "1" ]; then
  bash "$REPO_DIR/deploy/deploy-edge-functions.sh"
  bash "$REPO_DIR/deploy/schedule-cron.sh"
else
  echo "skipped (SKIP_FUNCTIONS=1)"
fi

log "8/8 Verification"
EXPECTED="$(find "$REPO_DIR/supabase/migrations" -maxdepth 1 -type f -name '*.sql' | wc -l | tr -d ' ')"
LEDGER="$(scalar 'SELECT count(*) FROM public._applied_migrations;')"
POLICIES="$(scalar "SELECT count(*) FROM pg_policies WHERE schemaname='public';")"
TABLES="$(scalar "SELECT count(*) FROM information_schema.tables WHERE table_schema='public';")"
NOGRANT="$(scalar "SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE c.relkind='r' AND n.nspname='public' AND NOT EXISTS (SELECT 1 FROM information_schema.role_table_grants g WHERE g.table_schema='public' AND g.table_name=c.relname AND g.grantee='authenticated');")"

echo
echo "SUMMARY"
echo "  applied     = ${#APPLIED_LIST[@]} ${APPLIED_LIST[*]+"${APPLIED_LIST[*]}"}"
echo "  benign-ok   = ${#BENIGN_LIST[@]} ${BENIGN_LIST[*]+"${BENIGN_LIST[*]}"}"
echo "  skipped     = ${#SKIPPED_LIST[@]} (already in ledger)"
echo "  hard-failed = ${#FAILED_LIST[@]} ${FAILED_LIST[*]+"${FAILED_LIST[*]}"}"
echo "  migration_files=$EXPECTED ledger_rows=$LEDGER public_policies=$POLICIES public_tables=$TABLES tables_without_grants=$NOGRANT"

[ "${#FAILED_LIST[@]}" -eq 0 ] || die "${#FAILED_LIST[@]} migrations hard-failed (see errors above)"
[ "$LEDGER" -ge "$EXPECTED" ] || die "migration ledger incomplete: files=$EXPECTED ledger=$LEDGER"
[ "$NOGRANT" = "0" ] || die "$NOGRANT public tables still lack Data API grants"

MISSING_TABLES="$(scalar "SELECT count(*) FROM (VALUES ('profiles'),('wallets'),('services'),('provider_accounts'),('service_provider_mapping'),('engagement_orders'),('engagement_order_items'),('organic_run_schedule'),('zapupi_deposits')) v(n) WHERE to_regclass('public.'||n) IS NULL;")"
[ "$MISSING_TABLES" = "0" ] || die "$MISSING_TABLES required tables are missing"
for fn in "public.set_referrer_by_code(text)" "public.credit_wallet_razorpay(uuid,text,numeric,numeric)" "public.apply_referral_bonus(uuid,numeric)"; do
  [ "$(scalar "SELECT to_regprocedure('$fn') IS NOT NULL;")" = "t" ] || die "$fn missing"
done
BAD_FK="$(scalar "SELECT count(*) FROM public.services s LEFT JOIN public.providers p ON p.id=s.provider_id WHERE s.provider_id IS NOT NULL AND p.id IS NULL;")"
[ "$BAD_FK" = "0" ] || die "$BAD_FK services have missing providers"
if [ "$SKIP_FUNCTIONS" != "1" ]; then
  HOSTED_JOBS="$(scalar "SELECT count(*) FROM cron.job WHERE command LIKE '%supabase.co%';")"
  [ "$HOSTED_JOBS" = "0" ] || die "$HOSTED_JOBS cron jobs still target hosted backend"
  BAD_JOBS="$(scalar "WITH expected(name) AS (VALUES ('execute-organic-runs-every-minute'),('execute-all-runs-every-minute'),('check-order-status-every-5-min'),('auto-refill-check-every-15-min'),('drip-feed-tick-every-5-min'),('snapshot-health-hourly'),('subscription-expiry-daily')) SELECT count(*) FROM expected e LEFT JOIN cron.job j ON j.jobname=e.name AND j.active WHERE j.jobid IS NULL;")"
  [ "$BAD_JOBS" = "0" ] || die "$BAD_JOBS required cron jobs are missing/inactive"
  psql_db -P pager=off -c "SELECT jobname,schedule,active FROM cron.job ORDER BY jobname;"
fi

echo
echo "PASS: migration repair complete (backup=$BACKUP)"
