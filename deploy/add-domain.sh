#!/usr/bin/env bash
# ============================================================================
# Add an EXTRA domain to the existing Caddy setup (does not touch other sites).
#   DOMAIN=extipspanel.com bash deploy/add-domain.sh
#   Optional: MODE=redirect TARGET=extipspanel.pro  (301 redirect instead of serving)
# Serves:  domain + www.domain -> app (127.0.0.1:3000)
#          api.domain          -> Supabase Kong
# ============================================================================
set -euo pipefail

DOMAIN="${DOMAIN:-}"
MODE="${MODE:-serve}"          # serve | redirect
TARGET="${TARGET:-}"           # required for MODE=redirect
SUPA_DIR="${SUPA_DIR:-/opt/supabase}"
APP_PORT="${APP_PORT:-3000}"
CADDYFILE="${CADDYFILE:-/etc/caddy/Caddyfile}"

log() { echo -e "\n\033[1;32m==>\033[0m $*"; }
die() { echo -e "\033[1;31m[error]\033[0m $*" >&2; exit 1; }
[ "$(id -u)" -eq 0 ] || die "Run as root."
[ -n "$DOMAIN" ] || die "Usage: DOMAIN=example.com bash deploy/add-domain.sh"
[ "$MODE" = "redirect" ] && [ -z "$TARGET" ] && die "MODE=redirect needs TARGET=maindomain.com"

API_PORT="$(grep -E '^KONG_HTTP_PORT=' "$SUPA_DIR/.env" 2>/dev/null | cut -d= -f2- | tr -d '"')"
API_PORT="${API_PORT:-8000}"

IP="$(curl -s https://api.ipify.org || true)"
log "This server public IP: ${IP:-unknown}"
for h in "$DOMAIN" "www.$DOMAIN" "api.$DOMAIN"; do
  got="$(getent hosts "$h" | awk '{print $1}' | head -1)"
  if [ -z "$got" ]; then echo "  [warn] $h -> no DNS yet"
  elif [ "$got" = "$IP" ]; then echo "  [ok]   $h -> $got"
  else echo "  [warn] $h -> $got (expected $IP)"; fi
done

cp -a "$CADDYFILE" "$CADDYFILE.bak.$(date +%s)"

# remove any previous block for this domain set (idempotent)
python3 - "$CADDYFILE" "$DOMAIN" <<'PY'
import re, sys
path, dom = sys.argv[1], sys.argv[2]
src = open(path).read()
marker_start = f"# >>> added-domain:{dom}"
marker_end = f"# <<< added-domain:{dom}"
src = re.sub(re.escape(marker_start) + r".*?" + re.escape(marker_end) + r"\n?", "", src, flags=re.S)
open(path, "w").write(src.rstrip() + "\n")
PY

log "Appending Caddy block for $DOMAIN (mode=$MODE)"
{
  printf '\n# >>> added-domain:%s\n' "$DOMAIN"
  if [ "$MODE" = "redirect" ]; then
    printf '%s, www.%s {\n\tredir https://%s{uri} permanent\n}\n' "$DOMAIN" "$DOMAIN" "$TARGET"
  else
    printf '%s, www.%s {\n\tencode zstd gzip\n\t@assets path /assets/*\n\theader @assets Cache-Control "public, max-age=31536000, immutable"\n\t@documents path / /index.html /*.html\n\theader @documents Cache-Control "no-cache, no-store, must-revalidate"\n\treverse_proxy 127.0.0.1:%s\n}\n\napi.%s {\n\treverse_proxy 127.0.0.1:%s\n}\n' \
      "$DOMAIN" "$DOMAIN" "$APP_PORT" "$DOMAIN" "$API_PORT"
  fi
  printf '# <<< added-domain:%s\n' "$DOMAIN"
} >> "$CADDYFILE"

log "Validating"
caddy validate --config "$CADDYFILE" --adapter caddyfile

log "Reloading Caddy"
systemctl reload caddy || systemctl restart caddy

log "Allowing the new origin in Supabase auth (SITE_URL stays, extra redirect URLs added)"
ENVF="$SUPA_DIR/.env"
if [ -f "$ENVF" ]; then
  cur="$(grep -E '^ADDITIONAL_REDIRECT_URLS=' "$ENVF" | cut -d= -f2- | tr -d '"')"
  add="https://$DOMAIN,https://www.$DOMAIN,https://$DOMAIN/*,https://www.$DOMAIN/*"
  new="$(printf '%s,%s' "${cur:-}" "$add" | sed 's/^,//' | tr ',' '\n' | awk 'NF && !seen[$0]++' | paste -sd, -)"
  if grep -q '^ADDITIONAL_REDIRECT_URLS=' "$ENVF"; then
    sed -i "s|^ADDITIONAL_REDIRECT_URLS=.*|ADDITIONAL_REDIRECT_URLS=$new|" "$ENVF"
  else
    echo "ADDITIONAL_REDIRECT_URLS=$new" >> "$ENVF"
  fi
  (cd "$SUPA_DIR" && docker compose up -d auth >/dev/null 2>&1 || docker compose up -d >/dev/null)
fi

echo
echo "Done. Test:  curl -I https://$DOMAIN"
