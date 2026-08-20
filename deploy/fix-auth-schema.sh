#!/usr/bin/env bash
# Fix self-hosted GoTrue "Database error querying schema" (HTTP 500 on login).
# Cause: supabase_auth_admin lost ownership/grants on the auth schema, or
# auth.users is missing columns that the GoTrue version expects.
set -euo pipefail

SUPA_DIR="${SUPA_DIR:-/opt/supabase}"
cd "$SUPA_DIR"

psql_run() { docker compose exec -T db psql -U postgres -d postgres "$@"; }

echo "===== 1) GOTRUE LOGS (last 40) ====="
docker compose logs --tail=40 auth 2>&1 | tail -40 || true

echo
echo "===== 2) REPAIRING auth SCHEMA OWNERSHIP + GRANTS ====="
docker compose exec -T db psql -U postgres -d postgres <<'SQL'
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='supabase_auth_admin') THEN
    CREATE ROLE supabase_auth_admin NOINHERIT CREATEROLE LOGIN NOREPLICATION;
  END IF;
END $$;

ALTER SCHEMA auth OWNER TO supabase_auth_admin;
GRANT USAGE, CREATE ON SCHEMA auth TO supabase_auth_admin;
GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA auth TO supabase_auth_admin;
GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA auth TO supabase_auth_admin;
GRANT ALL PRIVILEGES ON ALL FUNCTIONS IN SCHEMA auth TO supabase_auth_admin;
ALTER DEFAULT PRIVILEGES IN SCHEMA auth GRANT ALL ON TABLES TO supabase_auth_admin;
ALTER DEFAULT PRIVILEGES IN SCHEMA auth GRANT ALL ON SEQUENCES TO supabase_auth_admin;

-- make supabase_auth_admin own every auth table (GoTrue runs migrations as this role)
DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT tablename FROM pg_tables WHERE schemaname='auth' LOOP
    EXECUTE format('ALTER TABLE auth.%I OWNER TO supabase_auth_admin', r.tablename);
  END LOOP;
  FOR r IN SELECT sequencename FROM pg_sequences WHERE schemaname='auth' LOOP
    EXECUTE format('ALTER SEQUENCE auth.%I OWNER TO supabase_auth_admin', r.sequencename);
  END LOOP;
END $$;

-- auth needs to reach public (profiles trigger etc.)
GRANT USAGE ON SCHEMA public TO supabase_auth_admin;
GRANT ALL ON ALL TABLES IN SCHEMA public TO supabase_auth_admin;
GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO supabase_auth_admin;
GRANT USAGE ON SCHEMA auth TO postgres, anon, authenticated, service_role;
GRANT SELECT ON auth.users TO postgres, service_role;

-- columns newer GoTrue versions expect on auth.users
ALTER TABLE auth.users ADD COLUMN IF NOT EXISTS is_sso_user boolean NOT NULL DEFAULT false;
ALTER TABLE auth.users ADD COLUMN IF NOT EXISTS is_anonymous boolean NOT NULL DEFAULT false;
ALTER TABLE auth.users ADD COLUMN IF NOT EXISTS deleted_at timestamptz;
ALTER TABLE auth.users ADD COLUMN IF NOT EXISTS phone_confirmed_at timestamptz;
ALTER TABLE auth.users ADD COLUMN IF NOT EXISTS confirmed_at timestamptz;
ALTER TABLE auth.users ADD COLUMN IF NOT EXISTS reauthentication_token varchar(255) DEFAULT '';
ALTER TABLE auth.users ADD COLUMN IF NOT EXISTS reauthentication_sent_at timestamptz;
ALTER TABLE auth.users ADD COLUMN IF NOT EXISTS banned_until timestamptz;
ALTER TABLE auth.identities ADD COLUMN IF NOT EXISTS email text;
ALTER TABLE auth.sessions ADD COLUMN IF NOT EXISTS not_after timestamptz;
ALTER TABLE auth.sessions ADD COLUMN IF NOT EXISTS refreshed_at timestamptz;
ALTER TABLE auth.sessions ADD COLUMN IF NOT EXISTS user_agent text;
ALTER TABLE auth.sessions ADD COLUMN IF NOT EXISTS ip inet;
ALTER TABLE auth.sessions ADD COLUMN IF NOT EXISTS tag text;
SQL

echo
echo "===== 3) TRIGGERS ON auth.users (broken trigger = 500) ====="
psql_run -c "SELECT tgname, pg_get_triggerdef(oid) FROM pg_trigger WHERE tgrelid='auth.users'::regclass AND NOT tgisinternal;"

echo
echo "===== 4) RESTARTING auth + rest ====="
docker compose restart auth rest >/dev/null
for i in $(seq 1 30); do
  curl -sf -o /dev/null "http://localhost:8000/auth/v1/health" && break
  sleep 2
done
docker compose logs --tail=20 auth 2>&1 | tail -20 || true

echo
echo "===== 5) LOGIN TEST ====="
EMAIL="${EMAIL:-}"; PASSWORD="${PASSWORD:-}"
if [ -n "$EMAIL" ] && [ -n "$PASSWORD" ]; then
  ANON_KEY="$(grep -E '^ANON_KEY=' "$SUPA_DIR/.env" | cut -d= -f2- | tr -d '"')"
  HTTP="$(curl -s -o /tmp/lt.json -w '%{http_code}' \
    -X POST "http://localhost:8000/auth/v1/token?grant_type=password" \
    -H "apikey: $ANON_KEY" -H "Content-Type: application/json" \
    --data "$(printf '{"email":"%s","password":"%s"}' "$EMAIL" "$PASSWORD")" || true)"
  echo "HTTP $HTTP"
  [ "$HTTP" = "200" ] && echo "LOGIN OK" || { echo "LOGIN FAILED:"; cat /tmp/lt.json; echo; }
  rm -f /tmp/lt.json
else
  echo "(EMAIL/PASSWORD env nahi diya, skip)"
fi
