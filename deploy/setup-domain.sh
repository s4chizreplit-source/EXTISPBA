#!/usr/bin/env bash
# ============================================================================
# PHASE 5 — Caddy + domain (auto-HTTPS). Idempotent.
#   DOMAIN=mydomain.com bash deploy/setup-domain.sh
#     mydomain.com      -> 127.0.0.1:3000  (frontend)
#     api.mydomain.com  -> 127.0.0.1:8000  (Supabase Kong)
# ============================================================================
set -euo pipefail

DOMAIN="${DOMAIN:-}"
SUPA_DIR="${SUPA_DIR:-/opt/supabase}"
REPO_DIR="${REPO_DIR:-/opt/smmpanel}"
APP_PORT="${APP_PORT:-3000}"

log()  { echo -e "\n\033[1;32m==>\033[0m $*"; }
die()  { echo -e "\033[1;31m[error]\033[0m $*" >&2; exit 1; }
[ "$(id -u)" -eq 0 ] || die "Run as root."
[ -n "$DOMAIN" ] || die "Usage: DOMAIN=mydomain.com bash deploy/setup-domain.sh"

API_PORT="$(grep -E '^KONG_HTTP_PORT=' "$SUPA_DIR/.env" 2>/dev/null | cut -d= -f2- | tr -d '"')"
API_PORT="${API_PORT:-8000}"

log "1/5 Installing Caddy"
if ! command -v caddy >/dev/null 2>&1; then
  apt-get install -y debian-keyring debian-archive-keyring apt-transport-https curl gnupg
  curl -1fsSL https://dl.cloudsmith.io/public/caddy/stable/gpg.key \
    | gpg --batch --yes --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1fsSL https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt \
    > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -y && apt-get install -y caddy
fi

log "2/5 Writing /etc/caddy/Caddyfile (printf, no heredoc)"
printf '%s {\n\tencode zstd gzip\n\t@assets path /assets/*\n\theader @assets Cache-Control "public, max-age=31536000, immutable"\n\t@documents path / /index.html /*.html\n\theader @documents Cache-Control "no-cache, no-store, must-revalidate"\n\treverse_proxy 127.0.0.1:%s\n}\n\napi.%s {\n\treverse_proxy 127.0.0.1:%s\n}\n' \
  "$DOMAIN" "$APP_PORT" "$DOMAIN" "$API_PORT" > /etc/caddy/Caddyfile
cat /etc/caddy/Caddyfile

log "3/5 caddy validate"
caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile

log "4/5 Restarting Caddy"
systemctl enable --now caddy
systemctl restart caddy

log "5/5 Pointing the app at https://api.$DOMAIN"
ENVF="$SUPA_DIR/.env"
set_env() { if grep -q "^$1=" "$ENVF"; then sed -i "s|^$1=.*|$1=$2|" "$ENVF"; else echo "$1=$2" >> "$ENVF"; fi; }
set_env API_EXTERNAL_URL    "https://api.$DOMAIN"
set_env SUPABASE_PUBLIC_URL "https://api.$DOMAIN"
set_env SITE_URL            "https://$DOMAIN"
(cd "$SUPA_DIR" && docker compose up -d >/dev/null)

ANON="$(grep -E '^ANON_KEY=' "$ENVF" | cut -d= -f2- | tr -d '"')"
printf 'VITE_SUPABASE_URL=https://api.%s\nVITE_SUPABASE_PUBLISHABLE_KEY=%s\nVITE_SUPABASE_PROJECT_ID=selfhosted\n' \
  "$DOMAIN" "$ANON" > "$REPO_DIR/.env"
(cd "$REPO_DIR" && \
  rm -rf dist-new && \
  pnpm run build --outDir dist-new >/dev/null && \
  if [ -d dist/assets ]; then mkdir -p dist-new/assets && cp -an dist/assets/. dist-new/assets/ && find dist-new/assets -type f -mtime +30 -delete; fi && \
  rm -rf dist-prev && \
  if [ -d dist ]; then mv dist dist-prev; fi && \
  mv dist-new dist && \
  systemctl restart smmpanel && \
  rm -rf dist-prev)

sleep 3
echo "   https://$DOMAIN      -> HTTP $(curl -s -o /dev/null -w '%{http_code}' "https://$DOMAIN/" || true)"
echo "   https://api.$DOMAIN/auth/v1/health -> HTTP $(curl -s -o /dev/null -w '%{http_code}' "https://api.$DOMAIN/auth/v1/health" || true)"
echo "[done] domain live with auto-HTTPS."
