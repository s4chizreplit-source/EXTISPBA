#!/usr/bin/env bash
# Create/reset an admin user the CORRECT way: through GoTrue's admin API
# (manual SQL inserts leave NULL token columns -> "Database error querying schema").
set -euo pipefail

SUPA_DIR="${SUPA_DIR:-/opt/supabase}"
cd "$SUPA_DIR"

EMAIL="${EMAIL:-}"
PASSWORD="${PASSWORD:-}"
[ -z "$EMAIL" ] && read -rp "Email: " EMAIL
[ -z "$PASSWORD" ] && { read -rsp "Password: " PASSWORD; echo; }
EMAIL_LC="$(printf '%s' "$EMAIL" | tr '[:upper:]' '[:lower:]')"

SERVICE_KEY="$(grep -E '^SERVICE_ROLE_KEY=' .env | cut -d= -f2- | tr -d '"')"
ANON_KEY="$(grep -E '^ANON_KEY=' .env | cut -d= -f2- | tr -d '"')"
API="http://localhost:8000"

psql_q() { docker compose exec -T db psql -U postgres -d postgres -tAc "$1"; }

echo "== 1) purge any broken/manual row for $EMAIL_LC =="
docker compose exec -T db psql -U postgres -d postgres <<SQL
DELETE FROM auth.users WHERE lower(email)='${EMAIL_LC}';
SQL

echo "== 2) create user via GoTrue admin API =="
CREATE_BODY="$(printf '{"email":"%s","password":"%s","email_confirm":true}' "$EMAIL_LC" "$PASSWORD")"
RESP="$(curl -s -w '\n%{http_code}' -X POST "$API/auth/v1/admin/users" \
  -H "apikey: $SERVICE_KEY" -H "Authorization: Bearer $SERVICE_KEY" \
  -H "Content-Type: application/json" --data "$CREATE_BODY")"
CODE="$(printf '%s' "$RESP" | tail -1)"
BODY="$(printf '%s' "$RESP" | sed '$d')"
echo "admin create -> HTTP $CODE"
if [ "$CODE" != "200" ] && [ "$CODE" != "201" ]; then
  echo "$BODY"; echo "!! user create fail — upar ka error dekho"; exit 1
fi

UID_NEW="$(psql_q "SELECT id FROM auth.users WHERE lower(email)='${EMAIL_LC}' LIMIT 1")"
echo "user id: $UID_NEW"

echo "== 3) admin role + profile =="
docker compose exec -T db psql -U postgres -d postgres <<SQL
DO \$\$
DECLARE v_id uuid := '${UID_NEW}';
BEGIN
  BEGIN
    INSERT INTO public.profiles (id, email) VALUES (v_id, '${EMAIL_LC}')
    ON CONFLICT (id) DO UPDATE SET email = EXCLUDED.email;
  EXCEPTION WHEN others THEN RAISE NOTICE 'profiles: %', SQLERRM; END;
  BEGIN
    INSERT INTO public.user_roles (user_id, role) VALUES (v_id,'admin') ON CONFLICT DO NOTHING;
  EXCEPTION WHEN others THEN RAISE NOTICE 'user_roles: %', SQLERRM; END;
END \$\$;
SQL

psql_q "SELECT email||' | roles='||coalesce((SELECT string_agg(role::text,',') FROM public.user_roles WHERE user_id=u.id),'-') FROM auth.users u WHERE lower(email)='${EMAIL_LC}'"

echo
echo "== 4) LOGIN TEST =="
HTTP="$(curl -s -o /tmp/lt.json -w '%{http_code}' \
  -X POST "$API/auth/v1/token?grant_type=password" \
  -H "apikey: $ANON_KEY" -H "Content-Type: application/json" \
  --data "$(printf '{"email":"%s","password":"%s"}' "$EMAIL_LC" "$PASSWORD")")"
echo "HTTP $HTTP"
if [ "$HTTP" = "200" ]; then
  echo "LOGIN OK -> website pe isi email/password se sign in karo"
else
  echo "LOGIN FAILED:"; cat /tmp/lt.json; echo
  echo "--- auth logs ---"; docker compose logs --tail=25 auth 2>&1 | tail -25
fi
rm -f /tmp/lt.json
