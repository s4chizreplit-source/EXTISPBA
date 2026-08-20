#!/usr/bin/env bash
# Import auth users (from auth-users.json) into the self-hosted Supabase stack.
# Passwords are NOT transferable from Lovable Cloud, so each user is created
# with a random password and must use "Forgot password" once.
#
# Usage: bash import-auth-users.sh /root/auth-users.json
set -euo pipefail

FILE="${1:-/root/auth-users.json}"
SUPA_DIR="${SUPA_DIR:-/opt/supabase}"

[ -f "$FILE" ] || { echo "[error] File not found: $FILE"; exit 1; }
[ -f "$SUPA_DIR/.env" ] || { echo "[error] $SUPA_DIR/.env not found"; exit 1; }

API_URL="$(grep -E '^API_EXTERNAL_URL=' "$SUPA_DIR/.env" | cut -d= -f2- | tr -d '"' )"
SERVICE_KEY="$(grep -E '^SERVICE_ROLE_KEY=' "$SUPA_DIR/.env" | cut -d= -f2- | tr -d '"' )"
: "${API_URL:?API_EXTERNAL_URL missing}"
: "${SERVICE_KEY:?SERVICE_ROLE_KEY missing}"

command -v jq >/dev/null || { apt-get update -qq && apt-get install -y jq >/dev/null; }

TOTAL=$(jq 'length' "$FILE")
echo "[info] Importing $TOTAL users into $API_URL"

OK=0; SKIP=0; FAIL=0
for i in $(seq 0 $((TOTAL - 1))); do
  ROW=$(jq -c ".[$i]" "$FILE")
  EMAIL=$(echo "$ROW" | jq -r '.email // empty')
  [ -n "$EMAIL" ] || { SKIP=$((SKIP+1)); continue; }
  ID=$(echo "$ROW" | jq -r '.id')
  META=$(echo "$ROW" | jq -c '.user_metadata // {}')
  PASS=$(openssl rand -hex 16)

  BODY=$(jq -n --arg id "$ID" --arg email "$EMAIL" --arg pass "$PASS" --argjson meta "$META" \
    '{id:$id, email:$email, password:$pass, email_confirm:true, user_metadata:$meta}')

  CODE=$(curl -s -o /tmp/.iu_resp -w '%{http_code}' -X POST "$API_URL/auth/v1/admin/users" \
    -H "apikey: $SERVICE_KEY" -H "Authorization: Bearer $SERVICE_KEY" \
    -H "Content-Type: application/json" -d "$BODY")

  case "$CODE" in
    200|201) OK=$((OK+1));;
    422) SKIP=$((SKIP+1));;   # already exists
    *) FAIL=$((FAIL+1)); echo "[warn] $EMAIL -> HTTP $CODE $(head -c 200 /tmp/.iu_resp)";;
  esac
done
rm -f /tmp/.iu_resp

echo "[done] created=$OK skipped=$SKIP failed=$FAIL"
echo "[note] Users must reset their password once via 'Forgot password' (SMTP required)."
