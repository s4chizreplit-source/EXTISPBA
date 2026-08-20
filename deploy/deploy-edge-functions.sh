#!/usr/bin/env bash
# ============================================================================
# PHASE 4 — Deploy all repo edge functions to the self-hosted Edge Runtime and
# load secrets from /etc/smmpanel.secrets (chmod 600, template auto-created).
#   bash deploy/deploy-edge-functions.sh
# Idempotent.
# ============================================================================
set -euo pipefail

REPO_DIR="${REPO_DIR:-/opt/smmpanel}"
SUPA_DIR="${SUPA_DIR:-/opt/supabase}"
SRC="$REPO_DIR/supabase/functions"
DST="$SUPA_DIR/volumes/functions"
SECRETS_FILE="${SECRETS_FILE:-/etc/smmpanel.secrets}"
ENVF="$SUPA_DIR/.env"

log()  { echo -e "\n\033[1;32m==>\033[0m $*"; }
warn() { echo -e "\033[1;33m[warn]\033[0m $*"; }
die()  { echo -e "\033[1;31m[error]\033[0m $*" >&2; exit 1; }

[ -d "$SRC" ] || die "$SRC not found"
[ -f "$SUPA_DIR/docker-compose.yml" ] || die "Supabase stack not found at $SUPA_DIR"

log "1/5 Secrets template"
if [ ! -f "$SECRETS_FILE" ]; then
  cat > "$SECRETS_FILE" <<'EOF'
# Fill these in, then rerun deploy/deploy-edge-functions.sh
OXAPAY_MERCHANT_API_KEY=
ZAPUPI_ZAP_KEY=
RAZORPAY_KEY_ID=
RAZORPAY_KEY_SECRET=
RAZORPAY_WEBHOOK_SECRET=
TELEGRAM_BOT_TOKEN=
TELEGRAM_BOT_USERNAME=
TELEGRAM_CHAT_ID=
TELEGRAM_API_KEY=
APIFY_API_TOKEN=
LOVABLE_API_KEY=
RESEND_API_KEY=
PROVIDER_CURRENCY=USD
EOF
  chmod 600 "$SECRETS_FILE"
  warn "created template $SECRETS_FILE — fill it in and rerun this script"
fi

log "2/5 Copying $(find "$SRC" -mindepth 1 -maxdepth 1 -type d ! -name _shared | wc -l) functions -> $DST"
mkdir -p "$DST"
find "$DST" -mindepth 1 -maxdepth 1 ! -name main -exec rm -rf {} +
cp -r "$SRC"/. "$DST"/
# temporary migration helpers must never run on the new stack
rm -rf "$DST/export-cloud-data" "$DST/export-auth-hashes"

log "3/5 Merging secrets into $ENVF"
set_env() {
  local k="$1" v="$2"
  [ -n "$v" ] || return 0
  if grep -qE "^${k}=" "$ENVF"; then sed -i "s|^${k}=.*|${k}=${v}|" "$ENVF"; else printf '%s=%s\n' "$k" "$v" >> "$ENVF"; fi
}
MISSING=""
while IFS='=' read -r k v; do
  [ -z "${k// }" ] && continue
  case "$k" in \#*) continue;; esac
  if [ -z "$v" ]; then MISSING="$MISSING $k"; else set_env "$k" "$v"; fi
done < "$SECRETS_FILE"
[ -n "${MISSING// /}" ] && warn "empty secrets (features using them will fail):$MISSING"

# Public functions base URL — payment providers must reach webhooks from outside.
PUB="$(grep -E '^API_EXTERNAL_URL=' "$ENVF" | head -1 | cut -d= -f2- || true)"
[ -n "$PUB" ] && set_env "PUBLIC_FUNCTIONS_URL" "$PUB"

# ---------------------------------------------------------------------------
# The edge runtime container only sees variables explicitly passed to it.
# Attach the merged .env as an env_file on the functions service so every
# secret above (ZAPUPI_ZAP_KEY, OXAPAY_*, APIFY_API_TOKEN, ...) is present.
# ---------------------------------------------------------------------------
log "3b/5 Ensuring functions service loads $ENVF"
python3 - "$SUPA_DIR/docker-compose.yml" <<'PY' || warn "could not patch docker-compose.yml (python3 missing?)"
import re, sys
p = sys.argv[1]
s = open(p).read()
m = re.search(r'^(  )(functions|edge-functions):\s*$', s, re.M)
if not m:
    print("   [warn] functions service not found in compose file"); sys.exit(0)
start = m.end()
nxt = re.search(r'^  \S', s[start:], re.M)
end = start + (nxt.start() if nxt else len(s) - start)
block = s[start:end]
if 'env_file' in block:
    print("   env_file already configured"); sys.exit(0)
block = "\n    env_file:\n      - ./.env" + block
open(p, 'w').write(s[:start] + block + s[end:])
print("   env_file: ./.env added to functions service")
PY

log "4/5 Restarting edge runtime"
cd "$SUPA_DIR"
docker compose up -d functions >/dev/null 2>&1 || docker compose up -d edge-functions >/dev/null 2>&1 || true
docker compose up -d --force-recreate functions >/dev/null 2>&1 || docker compose up -d --force-recreate edge-functions >/dev/null 2>&1 || true

# Report which payment/integration secrets the container actually sees (masked)
SVC="functions"; docker compose ps functions >/dev/null 2>&1 || SVC="edge-functions"
for K in ZAPUPI_ZAP_KEY OXAPAY_MERCHANT_API_KEY RAZORPAY_KEY_ID APIFY_API_TOKEN TELEGRAM_BOT_TOKEN PUBLIC_FUNCTIONS_URL; do
  V="$(docker compose exec -T "$SVC" sh -lc "printenv $K" 2>/dev/null || true)"
  if [ -n "$V" ]; then echo "   $K = ${V:0:6}…(len ${#V})"; else warn "   $K NOT visible inside edge runtime"; fi
done


log "5/5 Health check + webhook URLs"
KONG_PORT="$(grep -E '^KONG_HTTP_PORT=' "$ENVF" | cut -d= -f2- | tr -d '"')"
API_URL="$(grep -E '^API_EXTERNAL_URL=' "$ENVF" | cut -d= -f2- | tr -d '"')"
ANON="$(grep -E '^ANON_KEY=' "$ENVF" | cut -d= -f2- | tr -d '"')"
sleep 6
CODE=$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:${KONG_PORT:-8000}/functions/v1/cron-status" -H "apikey: $ANON" || true)
echo "   GET /functions/v1/cron-status -> HTTP $CODE"
[ "$CODE" = "000" ] && warn "edge runtime unreachable: docker compose logs functions --tail=50"

cat <<EOF

Point provider webhooks here:
  OxaPay    -> $API_URL/functions/v1/oxapay-webhook
  ZapUPI    -> $API_URL/functions/v1/zapupi-webhook
  Razorpay  -> $API_URL/functions/v1/razorpay-webhook
  Telegram  -> $API_URL/functions/v1/telegram-webhook
  (Telegram can be registered by calling: $API_URL/functions/v1/telegram-set-webhook)
EOF
echo "[done] edge functions deployed."
