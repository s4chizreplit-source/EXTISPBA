#!/usr/bin/env bash
# ============================================================================
# PHASE 2 — 1:1 data transfer from Lovable Cloud into the self-hosted stack.
# No manual export: pulls NDJSON from the temporary `export-cloud-data`
# edge function (Bearer MIGRATION_TOKEN) and inserts FK-safe, idempotently.
#
#   CLOUD_URL=https://<ref>.supabase.co MIGRATION_TOKEN=xxxx \
#     bash deploy/import-data.sh
#
# Values can also live in /etc/smmpanel.migration (KEY=value lines).
# Re-runnable: every insert is ON CONFLICT DO NOTHING.
# ============================================================================
set -euo pipefail

INSTALL_DIR="${INSTALL_DIR:-/opt/supabase}"
CONF="${CONF:-/etc/smmpanel.migration}"
DUMP="${DUMP:-/root/cloud-data.ndjson}"

log()  { echo -e "\n\033[1;32m==>\033[0m $*"; }
warn() { echo -e "\033[1;33m[warn]\033[0m $*"; }
die()  { echo -e "\033[1;31m[error]\033[0m $*" >&2; exit 1; }

[ -f "$CONF" ] && . "$CONF"
CLOUD_URL="${CLOUD_URL:-https://xbxcjkypcgriiqsmhcjq.supabase.co}"
: "${MIGRATION_TOKEN:?MIGRATION_TOKEN required}"
CLOUD_URL="${CLOUD_URL%/}"

[ -d "$INSTALL_DIR" ] || die "Supabase stack not found at $INSTALL_DIR"
cd "$INSTALL_DIR"
docker compose exec -T db pg_isready -U postgres >/dev/null 2>&1 || die "Postgres not running"
psql_run() { docker compose exec -T db psql -U postgres -d postgres "$@"; }

log "1/5 Downloading data from Cloud"
if [ "${REUSE_DUMP:-0}" = "1" ] && [ -s "$DUMP" ]; then
  echo "   reusing $DUMP"
else
  curl -fsS --max-time 3600 "$CLOUD_URL/functions/v1/export-cloud-data" \
    -H "Authorization: Bearer $MIGRATION_TOKEN" -o "$DUMP" \
    || die "export-cloud-data call failed (token/url wrong, or function not deployed)"
fi
LINES=$(wc -l < "$DUMP")
echo "   $LINES ndjson lines -> $DUMP"
grep -q '"_type":"done"' "$DUMP" || warn "stream did not end with done marker — export may be partial"
if grep -q '"_type":"error"' "$DUMP"; then
  warn "export reported errors:"; grep '"_type":"error"' "$DUMP" | head -20
fi

log "2/5 Table list from dump"
TABLES=$(grep -o '"table":"[a-z_]*"' "$DUMP" | sed 's/.*:"//;s/"//' | awk '!seen[$0]++')
echo "$TABLES" | tr '\n' ' '; echo

log "3/5 Inserting (FKs relaxed, order preserved from export)"
psql_run -c "SET session_replication_role='replica';" >/dev/null
psql_run -v ON_ERROR_STOP=1 -c "CREATE TABLE IF NOT EXISTS public._import_stage(j jsonb);" >/dev/null

for t in $TABLES; do
  # NDJSON rows -> text COPY (backslashes doubled; JSON already escapes \n and \t)
  ROWS=$(grep -c "\"table\":\"$t\"," "$DUMP" || true)
  printf '  -> %-32s %s rows\n' "$t" "${ROWS:-0}"
  psql_run -c "TRUNCATE public._import_stage;" >/dev/null
  grep "\"table\":\"$t\"," "$DUMP" \
    | jq -c 'select(._type=="row") | .row' \
    | sed 's/\\/\\\\/g' \
    | docker compose exec -T db psql -U postgres -d postgres \
        -c "\copy public._import_stage(j) FROM STDIN" >/dev/null || {
          warn "$t staging failed"; continue; }
  psql_run -c "INSERT INTO public.$t SELECT r.* FROM public._import_stage s,
                 LATERAL jsonb_populate_record(NULL::public.$t, s.j) r
               ON CONFLICT DO NOTHING;" >/dev/null \
    || warn "$t insert had errors — continuing"
done

psql_run -c "DROP TABLE IF EXISTS public._import_stage;" >/dev/null
psql_run -c "SET session_replication_role='origin';" >/dev/null

log "4/5 Resetting sequences"
psql_run -v ON_ERROR_STOP=1 >/dev/null <<'SQL'
DO $$
DECLARE r record; maxv bigint;
BEGIN
  FOR r IN
    SELECT c.oid::regclass::text AS tbl, a.attname AS col,
           pg_get_serial_sequence(c.oid::regclass::text, a.attname) AS seq
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0
    WHERE n.nspname='public' AND c.relkind='r'
      AND pg_get_serial_sequence(c.oid::regclass::text, a.attname) IS NOT NULL
  LOOP
    EXECUTE format('SELECT COALESCE(MAX(%I),0) FROM %s', r.col, r.tbl) INTO maxv;
    EXECUTE format('SELECT setval(%L, GREATEST(%s,1))', r.seq, maxv);
  END LOOP;
END $$;
SQL

log "5/5 Row counts"
psql_run -c "
SELECT relname AS table, n_live_tup AS approx_rows
FROM pg_stat_user_tables
WHERE schemaname='public' AND n_live_tup > 0
ORDER BY n_live_tup DESC LIMIT 50;"

echo "[done] data imported. Next: bash deploy/import-auth-passwords.sh"
