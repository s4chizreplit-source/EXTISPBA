#!/usr/bin/env bash
# ============================================================================
# MERGE another Supabase project's data INTO this self-hosted stack.
#
# Non-destructive: existing rows are NEVER deleted or overwritten.
#   - users     : imported with their original UUID + bcrypt password hash
#                 (so login ID/password stay exactly the same).
#                 If the email already exists here, the existing account WINS
#                 and the source user is skipped (logged to the report).
#   - all rows  : ON CONFLICT DO NOTHING  -> re-runnable / idempotent
#   - orders    : order_number is re-numbered above the current max so it
#                 never collides with existing orders.
#
# Requires on the source project (read-only, via REST):
#   SRC_URL              https://<ref>.supabase.co
#   SRC_SERVICE_KEY      service_role key (or a key that can read the tables)
#   SRC_AUTH_TABLE       public table holding the password hashes
#                        (default: auth_mirror; needs user_id/email/encrypted_password)
#
# Usage on the VPS:
#   printf 'SRC_URL=https://xxx.supabase.co\nSRC_SERVICE_KEY=eyJ...\n' \
#     > /etc/smmpanel.merge && chmod 600 /etc/smmpanel.merge
#   bash deploy/merge-external-supabase.sh
#
# Dry run (download + report only, nothing written):
#   DRY_RUN=1 bash deploy/merge-external-supabase.sh
# ============================================================================
set -euo pipefail

INSTALL_DIR="${INSTALL_DIR:-/opt/supabase}"
CONF="${CONF:-/etc/smmpanel.merge}"
WORK="${WORK:-/root/merge-src}"
DRY_RUN="${DRY_RUN:-0}"
IMPORT_CATALOG="${IMPORT_CATALOG:-1}"   # services/providers/bundles (needed so old orders resolve)
PAGE="${PAGE:-1000}"

log()  { echo -e "\n\033[1;32m==>\033[0m $*"; }
warn() { echo -e "\033[1;33m[warn]\033[0m $*"; }
die()  { echo -e "\033[1;31m[error]\033[0m $*" >&2; exit 1; }

[ -f "$CONF" ] && . "$CONF"
: "${SRC_URL:?SRC_URL required (put it in $CONF)}"
: "${SRC_SERVICE_KEY:?SRC_SERVICE_KEY required (put it in $CONF)}"
SRC_AUTH_TABLE="${SRC_AUTH_TABLE:-auth_mirror}"
SRC_URL="${SRC_URL%/}"

command -v jq >/dev/null || { apt-get update -qq && apt-get install -y -qq jq; }

[ -d "$INSTALL_DIR" ] || die "Supabase stack not found at $INSTALL_DIR"
cd "$INSTALL_DIR"
docker compose exec -T db pg_isready -U postgres >/dev/null 2>&1 || die "Postgres not running"
psql_run() { docker compose exec -T db psql -U postgres -d postgres -v ON_ERROR_STOP=1 "$@"; }
psql_q()   { docker compose exec -T db psql -U postgres -d postgres -At -c "$1"; }

mkdir -p "$WORK"

# --- user-scoped tables, parents first ---------------------------------------
USER_TABLES=(
  profiles wallets user_roles subscriptions subscription_requests
  orders engagement_orders engagement_order_items organic_run_schedule
  engagement_health_history transactions deposits
  oxapay_deposits zapupi_deposits promo_redemptions
  instagram_accounts instagram_media instagram_poll_state instagram_link_events
  chat_conversations chat_messages support_tickets
  telegram_engagement_links engagement_presets drip_feed_campaigns
  mass_order_batches mass_order_batch_items
)
CATALOG_TABLES=( providers provider_accounts services service_provider_mapping engagement_bundles bundle_items promo_codes )

TABLES=()
[ "$IMPORT_CATALOG" = "1" ] && TABLES+=( "${CATALOG_TABLES[@]}" )
TABLES+=( "${USER_TABLES[@]}" )

# --- 1. download -------------------------------------------------------------
AUTH_FILE="$WORK/_auth.ndjson"

fetch() { # $1=table -> $WORK/$1.ndjson (one JSON object per line); prints row count
  local t="$1" from=0 out="$WORK/$t.ndjson" body n
  : > "$out" || return 1
  while :; do
    body=$(curl -sS --max-time 300 \
      -H "apikey: $SRC_SERVICE_KEY" -H "Authorization: Bearer $SRC_SERVICE_KEY" \
      -H "Range-Unit: items" -H "Range: ${from}-$((from+PAGE-1))" \
      "$SRC_URL/rest/v1/$t?select=*") || return 1
    echo "$body" | jq -e 'type=="array"' >/dev/null 2>&1 || { warn "$t: $(echo "$body" | head -c 160)"; return 1; }
    n=$(echo "$body" | jq 'length')
    [ "$n" -eq 0 ] && break
    echo "$body" | jq -c '.[]' >> "$out"
    [ "$n" -lt "$PAGE" ] && break
    from=$((from+PAGE))
  done
  wc -l < "$out"
}

# normalise any auth source into {user_id,email,encrypted_password,...}
norm_auth() { # stdin: ndjson -> $AUTH_FILE
  jq -c '{user_id: (.user_id // .id),
          email: .email,
          encrypted_password: (.encrypted_password // .password_hash // .hash),
          email_confirmed_at: .email_confirmed_at,
          created_at: .created_at,
          raw_user_meta_data: (.raw_user_meta_data // {})}
         | select(.user_id != null and .email != null and .encrypted_password != null)' \
    >> "$AUTH_FILE"
}

fetch_auth() {
  : > "$AUTH_FILE"
  local cands=( "$SRC_AUTH_TABLE" auth_mirror auth_hashes auth_users_mirror users_mirror user_hashes )
  local seen="" t rows
  for t in "${cands[@]}"; do
    case " $seen " in *" $t "*) continue ;; esac
    seen="$seen $t"
    if rows=$(fetch "$t" 2>/dev/null) && [ "${rows:-0}" -gt 0 ]; then
      norm_auth < "$WORK/$t.ndjson"
      if [ -s "$AUTH_FILE" ]; then
        echo "   auth source: table $t ($(wc -l < "$AUTH_FILE") usable rows)"
        return 0
      fi
    fi
  done
  # fallback: security-definer RPC that exports hashes
  local body
  body=$(curl -sS --max-time 300 -X POST \
    -H "apikey: $SRC_SERVICE_KEY" -H "Authorization: Bearer $SRC_SERVICE_KEY" \
    -H "Content-Type: application/json" -d '{}' \
    "$SRC_URL/rest/v1/rpc/export_auth_hashes" 2>/dev/null || true)
  if echo "$body" | jq -e 'type=="array" and length>0' >/dev/null 2>&1; then
    echo "$body" | jq -c '.[]' | norm_auth
    if [ -s "$AUTH_FILE" ]; then
      echo "   auth source: rpc export_auth_hashes ($(wc -l < "$AUTH_FILE") rows)"
      return 0
    fi
  fi
  return 1
}

log "1/6 Downloading from source project"
if [ "${REUSE_DUMP:-0}" = "1" ] && [ -s "$AUTH_FILE" ]; then
  echo "   reusing $WORK ($(wc -l < "$AUTH_FILE") users)"
else
  fetch_auth || die "could not read password hashes from source.
  Tried tables: $SRC_AUTH_TABLE auth_mirror auth_hashes auth_users_mirror users_mirror user_hashes
  and rpc export_auth_hashes.
  Fix: set SRC_AUTH_TABLE=<exact table name> in $CONF (table needs user_id/id, email, encrypted_password),
  or create it on the source project:
    create table public.auth_mirror as
      select id as user_id, email, encrypted_password, email_confirmed_at, created_at, raw_user_meta_data
      from auth.users where deleted_at is null;"
  for t in "${TABLES[@]}"; do
    printf '  -> %-30s %s rows\n' "$t" "$(fetch "$t" || echo 'SKIPPED')"
  done
fi

SRC_USERS=$(wc -l < "$AUTH_FILE")
[ "$SRC_USERS" -gt 0 ] || die "0 usable user rows (need user_id/email/encrypted_password)"


# --- 2. staging --------------------------------------------------------------
log "2/6 Staging"
psql_run <<'SQL' >/dev/null
CREATE SCHEMA IF NOT EXISTS merge_stage;
DROP TABLE IF EXISTS merge_stage.raw;
CREATE TABLE merge_stage.raw(tbl text, j jsonb);
DROP TABLE IF EXISTS merge_stage.raw_load;
CREATE TABLE merge_stage.raw_load(tbl text, payload text);
DROP TABLE IF EXISTS merge_stage.users;
CREATE TABLE merge_stage.users(j jsonb);
DROP TABLE IF EXISTS merge_stage.users_load;
CREATE TABLE merge_stage.users_load(payload text);
DROP TABLE IF EXISTS merge_stage.accepted;
CREATE TABLE merge_stage.accepted(user_id uuid PRIMARY KEY);
SQL

stage() { # $1=table $2=file $3=target(raw|users)
  local rows; rows=$(wc -l < "$2"); [ "$rows" -gt 0 ] || return 0
  if [ "$3" = "users" ]; then
    jq -Rr '@base64' "$2" | docker compose exec -T db psql -U postgres -d postgres \
      -c "\copy merge_stage.users_load(payload) FROM STDIN" >/dev/null
    psql_run -c "
      INSERT INTO merge_stage.users(j)
      SELECT convert_from(decode(payload, 'base64'), 'UTF8')::jsonb
      FROM merge_stage.users_load;
      TRUNCATE merge_stage.users_load;" >/dev/null
  else
    jq -Rr --arg t "$1" '[$t, @base64] | @tsv' "$2" \
      | docker compose exec -T db psql -U postgres -d postgres \
      -c "\copy merge_stage.raw_load(tbl,payload) FROM STDIN" >/dev/null
    psql_run -c "
      INSERT INTO merge_stage.raw(tbl,j)
      SELECT tbl, convert_from(decode(payload, 'base64'), 'UTF8')::jsonb
      FROM merge_stage.raw_load;
      TRUNCATE merge_stage.raw_load;" >/dev/null
  fi
}
stage "_auth" "$AUTH_FILE" users
for t in "${TABLES[@]}"; do
  [ -f "$WORK/$t.ndjson" ] && stage "$t" "$WORK/$t.ndjson" raw
done
echo "   staged: $(psql_q "SELECT count(*) FROM merge_stage.raw") data rows, $SRC_USERS users"

# --- 3. user merge plan ------------------------------------------------------
log "3/6 User merge plan (existing accounts win)"
psql_run <<'SQL'
CREATE TEMP VIEW _u AS
  SELECT (j->>'user_id')::uuid AS id,
         lower(j->>'email')    AS email,
         j->>'encrypted_password' AS pw,
         COALESCE((j->>'email_confirmed_at')::timestamptz, now()) AS confirmed,
         COALESCE((j->>'created_at')::timestamptz, now())         AS created,
         COALESCE(j->'raw_user_meta_data', '{}'::jsonb)           AS meta
  FROM merge_stage.users
  WHERE j->>'user_id' IS NOT NULL AND j->>'email' IS NOT NULL;

INSERT INTO merge_stage.accepted(user_id)
SELECT u.id FROM _u u
WHERE NOT EXISTS (SELECT 1 FROM auth.users a WHERE lower(a.email) = u.email)
  AND NOT EXISTS (SELECT 1 FROM auth.users a WHERE a.id = u.id)
ON CONFLICT DO NOTHING;

SELECT (SELECT count(*) FROM _u)                                        AS source_users,
       (SELECT count(*) FROM merge_stage.accepted)                      AS will_import,
       (SELECT count(*) FROM _u u JOIN auth.users a
          ON lower(a.email)=u.email)                                    AS email_already_here;
SQL

if [ "$DRY_RUN" = "1" ]; then
  log "DRY_RUN=1 — nothing written. Per-table source counts:"
  psql_q "SELECT tbl||' = '||count(*) FROM merge_stage.raw GROUP BY tbl ORDER BY tbl"
  exit 0
fi

# --- 4. insert users ---------------------------------------------------------
log "4/6 Importing users (same UUID, same password hash)"
psql_run <<'SQL'
CREATE TEMP VIEW _u AS
  SELECT (j->>'user_id')::uuid AS id, lower(j->>'email') AS email,
         j->>'encrypted_password' AS pw,
         COALESCE((j->>'email_confirmed_at')::timestamptz, now()) AS confirmed,
         COALESCE((j->>'created_at')::timestamptz, now()) AS created,
         COALESCE(j->'raw_user_meta_data','{}'::jsonb) AS meta
  FROM merge_stage.users
  WHERE j->>'user_id' IS NOT NULL AND j->>'email' IS NOT NULL;

INSERT INTO auth.users (
  instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
  created_at, updated_at, raw_app_meta_data, raw_user_meta_data
)
SELECT '00000000-0000-0000-0000-000000000000', u.id, 'authenticated', 'authenticated',
       u.email, u.pw, u.confirmed, u.created, now(),
       '{"provider":"email","providers":["email"]}'::jsonb, u.meta
FROM _u u JOIN merge_stage.accepted a ON a.user_id = u.id
ON CONFLICT (id) DO NOTHING;

INSERT INTO auth.identities (id, user_id, provider_id, identity_data, provider, created_at, updated_at)
SELECT gen_random_uuid(), u.id, u.id::text,
       jsonb_build_object('sub', u.id::text, 'email', u.email, 'email_verified', true),
       'email', u.created, now()
FROM _u u JOIN merge_stage.accepted a ON a.user_id = u.id
WHERE NOT EXISTS (
  SELECT 1 FROM auth.identities i WHERE i.user_id = u.id AND i.provider = 'email'
);

-- GoTrue cannot scan NULL token columns -> login fails with an empty {} 500 error.
DO $$
DECLARE
  c record;
  fix jsonb := jsonb_build_object(
    'confirmation_token', '''''', 'recovery_token', '''''',
    'email_change_token_new', '''''', 'email_change_token_current', '''''',
    'email_change', '''''', 'phone_change', '''''', 'phone_change_token', '''''',
    'reauthentication_token', '''''',
    'aud', '''authenticated''', 'role', '''authenticated''',
    'raw_app_meta_data', '''{"provider":"email","providers":["email"]}''::jsonb',
    'raw_user_meta_data', '''{}''::jsonb',
    'email_confirmed_at', 'now()',
    'is_sso_user', 'false', 'is_anonymous', 'false'
  );
BEGIN
  FOR c IN
    SELECT column_name, is_generated, identity_generation
    FROM information_schema.columns
    WHERE table_schema='auth' AND table_name='users'
      AND column_name IN (SELECT jsonb_object_keys(fix))
  LOOP
    IF c.is_generated = 'ALWAYS' THEN CONTINUE; END IF;
    EXECUTE format(
      'UPDATE auth.users SET %1$I = %2$s WHERE %1$I IS NULL',
      c.column_name, fix->>c.column_name
    );
  END LOOP;
  -- blank aud/role are equally fatal
  EXECUTE $q$UPDATE auth.users SET aud='authenticated' WHERE aud=''$q$;
  EXECUTE $q$UPDATE auth.users SET role='authenticated' WHERE role=''$q$;
END $$;


SELECT count(*) AS users_now FROM auth.users;

SQL

# --- 5. insert data ----------------------------------------------------------
log "5/6 Importing data rows"
psql_run -c "SET session_replication_role='replica';" >/dev/null

insert_table() { # $1=table
  local t="$1" has_user has_order
  psql_q "SELECT to_regclass('public.$t') IS NOT NULL" | grep -q t || { warn "$t not in target — skipped"; return 0; }
  has_user=$(psql_q "SELECT EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='$t' AND column_name='user_id')")
  has_order=$(psql_q "SELECT EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='$t' AND column_name='order_number')")

  local filter="TRUE"
  [ "$has_user" = "t" ] && filter="(s.j->>'user_id')::uuid IN (SELECT user_id FROM merge_stage.accepted)"

  local jexpr="s.j"
  if [ "$has_order" = "t" ]; then
    # shift imported order_number above the current max, keeping relative order
    jexpr="jsonb_set(s.j,'{order_number}', to_jsonb(
             (SELECT COALESCE(MAX(order_number),0) FROM public.$t)
             + row_number() OVER (ORDER BY (s.j->>'order_number')::bigint)))"
  fi

  local before after
  before=$(psql_q "SELECT count(*) FROM public.$t")
  docker compose exec -T db psql -U postgres -d postgres -q -c "
    INSERT INTO public.$t
    SELECT r.* FROM (
      SELECT $jexpr AS j FROM merge_stage.raw s WHERE s.tbl='$t' AND $filter
    ) z, LATERAL jsonb_populate_record(NULL::public.$t, z.j) r
    ON CONFLICT DO NOTHING;" >/dev/null 2>&1 \
    || warn "$t: insert reported errors (continuing)"
  after=$(psql_q "SELECT count(*) FROM public.$t")
  printf '  -> %-30s +%s rows (now %s)\n' "$t" "$((after-before))" "$after"
}

for t in "${TABLES[@]}"; do
  [ -f "$WORK/$t.ndjson" ] && [ -s "$WORK/$t.ndjson" ] && insert_table "$t"
done

# every imported user must have profile + wallet + role rows
psql_run <<'SQL' >/dev/null
INSERT INTO public.profiles (user_id, email, full_name)
SELECT a.user_id, u.email, COALESCE(u.raw_user_meta_data->>'full_name','')
FROM merge_stage.accepted a JOIN auth.users u ON u.id = a.user_id
WHERE NOT EXISTS (SELECT 1 FROM public.profiles p WHERE p.user_id = a.user_id);

INSERT INTO public.wallets (user_id, balance, total_deposited, total_spent)
SELECT a.user_id, 0, 0, 0 FROM merge_stage.accepted a
WHERE NOT EXISTS (SELECT 1 FROM public.wallets w WHERE w.user_id = a.user_id);

INSERT INTO public.user_roles (user_id, role)
SELECT a.user_id, 'user' FROM merge_stage.accepted a
WHERE NOT EXISTS (SELECT 1 FROM public.user_roles r WHERE r.user_id = a.user_id)
ON CONFLICT DO NOTHING;
SQL

psql_run -c "SET session_replication_role='origin';" >/dev/null

log "6/6 Sequences + report"
psql_run >/dev/null <<'SQL'
DO $$
DECLARE r record; maxv bigint;
BEGIN
  FOR r IN
    SELECT c.oid::regclass::text AS tbl, a.attname AS col,
           pg_get_serial_sequence(c.oid::regclass::text, a.attname) AS seq
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    JOIN pg_attribute a ON a.attrelid=c.oid AND a.attnum>0
    WHERE n.nspname='public' AND c.relkind='r'
      AND pg_get_serial_sequence(c.oid::regclass::text, a.attname) IS NOT NULL
  LOOP
    EXECUTE format('SELECT COALESCE(MAX(%I),0) FROM %s', r.col, r.tbl) INTO maxv;
    EXECUTE format('SELECT setval(%L, GREATEST(%s,1))', r.seq, maxv);
  END LOOP;
END $$;
SQL

psql_run -c "
SELECT (SELECT count(*) FROM auth.users)                AS total_users,
       (SELECT count(*) FROM merge_stage.accepted)      AS imported_users,
       (SELECT count(*) FROM public.orders)             AS orders,
       (SELECT count(*) FROM public.engagement_orders)  AS engagement_orders,
       (SELECT count(*) FROM public.transactions)       AS transactions,
       (SELECT ROUND(SUM(balance),2) FROM public.wallets) AS wallet_total;"

echo
echo "[done] merge complete. Old passwords work as-is. Nothing existing was deleted."
echo "Skipped users (email already existed here):"
psql_run -c "
SELECT lower(s.j->>'email') AS email
FROM merge_stage.users s
WHERE (s.j->>'user_id')::uuid NOT IN (SELECT user_id FROM merge_stage.accepted)
ORDER BY 1 LIMIT 50;"
