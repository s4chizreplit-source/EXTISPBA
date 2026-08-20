#!/usr/bin/env bash
# ============================================================================
# PHASE 3 — AUTH: same UUID, same email, SAME OLD PASSWORD.
# Pulls bcrypt hashes from the temporary `export-auth-hashes` edge function
# and applies them to the self-hosted auth.users + auth.identities.
#
#   CLOUD_URL=https://<ref>.supabase.co MIGRATION_TOKEN=xxxx \
#     VERIFY_EMAIL=user@x.com VERIFY_PASSWORD='oldpass' \
#     bash deploy/import-auth-passwords.sh
#
# Values can also live in /etc/smmpanel.migration
# Idempotent: re-running just re-applies the same hashes.
# ============================================================================
set -euo pipefail

INSTALL_DIR="${INSTALL_DIR:-/opt/supabase}"
CONF="${CONF:-/etc/smmpanel.migration}"
JSONF="${JSONF:-/root/auth-hashes.json}"

log()  { echo -e "\n\033[1;32m==>\033[0m $*"; }
warn() { echo -e "\033[1;33m[warn]\033[0m $*"; }
die()  { echo -e "\033[1;31m[error]\033[0m $*" >&2; exit 1; }

[ -f "$CONF" ] && . "$CONF"
CLOUD_URL="${CLOUD_URL:-https://xbxcjkypcgriiqsmhcjq.supabase.co}"
: "${MIGRATION_TOKEN:?MIGRATION_TOKEN required}"
CLOUD_URL="${CLOUD_URL%/}"

cd "$INSTALL_DIR" || die "stack not found at $INSTALL_DIR"
psql_run() { docker compose exec -T db psql -U postgres -d postgres "$@"; }
docker compose exec -T db pg_isready -U postgres >/dev/null 2>&1 || die "Postgres not running"

log "1/6 Downloading auth hashes"
curl -fsS --max-time 600 "$CLOUD_URL/functions/v1/export-auth-hashes" \
  -H "Authorization: Bearer $MIGRATION_TOKEN" -o "$JSONF" \
  || die "export-auth-hashes call failed"
COUNT=$(jq '.users | length' "$JSONF")
echo "   $COUNT users received"
[ "$COUNT" -gt 0 ] || die "no users returned"

log "2/6 Staging into database"
psql_run -v ON_ERROR_STOP=1 >/dev/null <<'SQL'
DROP TABLE IF EXISTS public._auth_stage;
CREATE TABLE public._auth_stage(j jsonb);
SQL
jq -c '.users[]' "$JSONF" | sed 's/\\/\\\\/g' \
  | docker compose exec -T db psql -U postgres -d postgres \
      -c "\copy public._auth_stage(j) FROM STDIN" >/dev/null

log "3/6 Upserting auth.users (UUID + email preserved) and auth.identities"
psql_run -v ON_ERROR_STOP=1 <<'SQL'
-- Insert users that do not exist yet
INSERT INTO auth.users (
  instance_id, id, aud, role, email, encrypted_password,
  email_confirmed_at, raw_user_meta_data, raw_app_meta_data,
  created_at, updated_at
)
SELECT '00000000-0000-0000-0000-000000000000',
       (j->>'id')::uuid, 'authenticated', 'authenticated',
       j->>'email', j->>'encrypted_password',
       COALESCE((j->>'email_confirmed_at')::timestamptz, (j->>'created_at')::timestamptz, now()),
       COALESCE(j->'raw_user_meta_data', '{}'::jsonb),
       COALESCE(j->'raw_app_meta_data', '{"provider":"email","providers":["email"]}'::jsonb),
       COALESCE((j->>'created_at')::timestamptz, now()), now()
FROM public._auth_stage
ON CONFLICT (id) DO NOTHING;

-- Apply the original password hash to existing rows
UPDATE auth.users u
SET encrypted_password = s.j->>'encrypted_password',
    email              = COALESCE(s.j->>'email', u.email),
    updated_at         = now()
FROM public._auth_stage s
WHERE u.id = (s.j->>'id')::uuid;

-- GoTrue compatibility: these columns must be '' not NULL, otherwise login 500s.
-- NOTE: confirmed_at is a GENERATED column — never update it.
UPDATE auth.users SET
  confirmation_token          = COALESCE(confirmation_token, ''),
  recovery_token              = COALESCE(recovery_token, ''),
  email_change_token_new      = COALESCE(email_change_token_new, ''),
  email_change_token_current  = COALESCE(email_change_token_current, ''),
  email_change                = COALESCE(email_change, ''),
  phone_change                = COALESCE(phone_change, ''),
  phone_change_token          = COALESCE(phone_change_token, ''),
  reauthentication_token      = COALESCE(reauthentication_token, ''),
  instance_id                 = COALESCE(instance_id, '00000000-0000-0000-0000-000000000000'),
  aud                         = COALESCE(NULLIF(aud, ''), 'authenticated'),
  role                        = COALESCE(NULLIF(role, ''), 'authenticated'),
  email_confirmed_at          = COALESCE(email_confirmed_at, created_at, now());

-- Email identity rows (GoTrue needs one per email user)
INSERT INTO auth.identities (id, provider_id, user_id, identity_data, provider, last_sign_in_at, created_at, updated_at)
SELECT gen_random_uuid(), u.id::text, u.id,
       jsonb_build_object('sub', u.id::text, 'email', u.email, 'email_verified', true, 'phone_verified', false),
       'email', now(), COALESCE(u.created_at, now()), now()
FROM auth.users u
WHERE u.email IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM auth.identities i WHERE i.user_id = u.id AND i.provider = 'email'
  );

DROP TABLE IF EXISTS public._auth_stage;
SQL

log "4/6 Counts"
psql_run -c "
SELECT (SELECT count(*) FROM auth.users) AS total_users,
       (SELECT count(*) FROM auth.users WHERE encrypted_password LIKE '\$2%') AS valid_bcrypt,
       (SELECT count(*) FROM auth.identities WHERE provider='email') AS email_identities;"

log "5/6 Restarting auth container"
docker compose restart auth >/dev/null 2>&1 || docker compose restart gotrue >/dev/null 2>&1 || true
sleep 8

log "6/6 Verifying a real login"
API_URL="$(grep -E '^API_EXTERNAL_URL=' "$INSTALL_DIR/.env" | cut -d= -f2- | tr -d '"')"
ANON="$(grep -E '^ANON_KEY=' "$INSTALL_DIR/.env" | cut -d= -f2- | tr -d '"')"
KONG_PORT="$(grep -E '^KONG_HTTP_PORT=' "$INSTALL_DIR/.env" | cut -d= -f2- | tr -d '"')"
BASE="http://127.0.0.1:${KONG_PORT:-8000}"

if [ -n "${VERIFY_EMAIL:-}" ] && [ -n "${VERIFY_PASSWORD:-}" ]; then
  RESP=$(curl -s -X POST "$BASE/auth/v1/token?grant_type=password" \
    -H "apikey: $ANON" -H "Content-Type: application/json" \
    -d "$(jq -nc --arg e "$VERIFY_EMAIL" --arg p "$VERIFY_PASSWORD" '{email:$e,password:$p}')")
  if echo "$RESP" | jq -e '.access_token' >/dev/null 2>&1; then
    echo -e "\033[1;32m   LOGIN OK — old password works, access_token received\033[0m"
  else
    warn "login FAILED:"; echo "$RESP" | head -c 500; echo
    warn "check: cd $INSTALL_DIR && docker compose logs auth --tail=60"
    exit 1
  fi
else
  warn "VERIFY_EMAIL / VERIFY_PASSWORD not set — skipping the real login proof."
  echo "   Run: VERIFY_EMAIL=you@mail.com VERIFY_PASSWORD='oldpass' bash deploy/import-auth-passwords.sh"
fi

rm -f "$JSONF"
echo "[done] hashes imported and $JSONF removed. Public API: ${API_URL:-$BASE}"
