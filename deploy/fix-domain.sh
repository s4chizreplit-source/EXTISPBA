#!/usr/bin/env bash
# ============================================================================
# FIX a domain that shows ERR_SSL_PROTOCOL_ERROR / "can't provide a secure connection"
#
#   DOMAIN=extipspanel.com bash deploy/fix-domain.sh
#
# What it does (safe + idempotent, does not break other sites):
#   1. Checks DNS -> this server IP
#   2. Makes sure ports 80/443 are open (ufw/iptables) and nothing else uses them
#   3. Installs Caddy if missing, ensures it is running
#   4. Rewrites ONLY this domain's Caddy block (app on 127.0.0.1:APP_PORT)
#      - api.DOMAIN block added ONLY if its DNS already points here
#   5. Reloads Caddy, waits for Let's Encrypt cert, prints real HTTPS test
#   6. Adds the domain to Supabase auth redirect URLs
# ============================================================================
set -euo pipefail

DOMAIN="${DOMAIN:-}"
SUPA_DIR="${SUPA_DIR:-/opt/supabase}"
APP_PORT="${APP_PORT:-3000}"
CADDYFILE="${CADDYFILE:-/etc/caddy/Caddyfile}"
EMAIL="${EMAIL:-admin@$DOMAIN}"

log()  { echo -e "\n\033[1;32m==>\033[0m $*"; }
warn() { echo -e "\033[1;33m[warn]\033[0m $*"; }
die()  { echo -e "\033[1;31m[error]\033[0m $*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "Run as root (sudo -i)."
[ -n "$DOMAIN" ] || die "Usage: DOMAIN=extipspanel.com bash deploy/fix-domain.sh"

IP="$(curl -fsS --max-time 10 https://api.ipify.org || true)"
log "Server public IP: ${IP:-unknown}"

# ---------------------------------------------------------------- 1. DNS check
resolve() { getent hosts "$1" | awk '{print $1}' | head -1; }
ROOT_OK=0; WWW_OK=0; API_OK=0
for h in "$DOMAIN" "www.$DOMAIN" "api.$DOMAIN"; do
  got="$(resolve "$h" || true)"
  if [ -z "$got" ]; then
    echo "  [miss] $h -> no DNS record"
  elif [ -n "$IP" ] && [ "$got" != "$IP" ]; then
    echo "  [bad]  $h -> $got (expected $IP)"
  else
    echo "  [ok]   $h -> $got"
    case "$h" in
      "$DOMAIN") ROOT_OK=1 ;;
      "www.$DOMAIN") WWW_OK=1 ;;
      "api.$DOMAIN") API_OK=1 ;;
    esac
  fi
done
[ "$ROOT_OK" = "1" ] || die "DNS for $DOMAIN does not point to $IP yet. Add an A record @ -> $IP and re-run in a few minutes."

# ------------------------------------------------------- 2. firewall + ports
log "Opening ports 80/443"
if command -v ufw >/dev/null 2>&1; then
  ufw allow 80/tcp  >/dev/null 2>&1 || true
  ufw allow 443/tcp >/dev/null 2>&1 || true
  ufw status | head -20 || true
fi
iptables -C INPUT -p tcp --dport 80  -j ACCEPT 2>/dev/null || iptables -I INPUT -p tcp --dport 80  -j ACCEPT 2>/dev/null || true
iptables -C INPUT -p tcp --dport 443 -j ACCEPT 2>/dev/null || iptables -I INPUT -p tcp --dport 443 -j ACCEPT 2>/dev/null || true

log "Who is listening on 80/443"
ss -lntp 2>/dev/null | grep -E ':80 |:443 ' || echo "  (nothing listening yet)"
for svc in apache2 nginx; do
  if systemctl is-active --quiet "$svc" 2>/dev/null; then
    warn "$svc is holding port 80/443 -> stopping it so Caddy can serve HTTPS"
    systemctl disable --now "$svc" || true
  fi
done

# ------------------------------------------------------------- 3. ensure Caddy
if ! command -v caddy >/dev/null 2>&1; then
  log "Installing Caddy"
  apt-get update -y
  apt-get install -y debian-keyring debian-archive-keyring apt-transport-https curl gnupg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
    | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  echo "deb [signed-by=/usr/share/keyrings/caddy-stable-archive-keyring.gpg] https://dl.cloudsmith.io/public/caddy/stable/deb/debian any-version main" \
    > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -y && apt-get install -y caddy
fi
mkdir -p "$(dirname "$CADDYFILE")"
[ -f "$CADDYFILE" ] || printf '{\n\temail %s\n}\n' "$EMAIL" > "$CADDYFILE"
cp -a "$CADDYFILE" "$CADDYFILE.bak.$(date +%s)"

# make sure an ACME email is configured (otherwise issuance can fail)
if ! grep -q "email " "$CADDYFILE"; then
  printf '{\n\temail %s\n}\n%s\n' "$EMAIL" "$(cat "$CADDYFILE")" > "$CADDYFILE.tmp" && mv "$CADDYFILE.tmp" "$CADDYFILE"
fi

# ------------------------------------------------- 4. rewrite domain's block
API_PORT="$(grep -E '^KONG_HTTP_PORT=' "$SUPA_DIR/.env" 2>/dev/null | cut -d= -f2- | tr -d '"' || true)"
API_PORT="${API_PORT:-8000}"

python3 - "$CADDYFILE" "$DOMAIN" <<'PY'
import re, sys
path, dom = sys.argv[1], sys.argv[2]
src = open(path).read()
# drop previous managed block
src = re.sub(re.escape(f"# >>> added-domain:{dom}") + r".*?" + re.escape(f"# <<< added-domain:{dom}") + r"\n?", "", src, flags=re.S)
# drop any stray hand-written site blocks for the same names
for name in (dom, f"www.{dom}", f"api.{dom}"):
    src = re.sub(r"(?m)^\s*" + re.escape(name) + r"[^\n{]*\{.*?^\}\n?", "", src, flags=re.S)
open(path, "w").write(src.rstrip() + "\n")
PY

HOSTS="$DOMAIN"
[ "$WWW_OK" = "1" ] && HOSTS="$DOMAIN, www.$DOMAIN"

log "Writing Caddy block for: $HOSTS  -> 127.0.0.1:$APP_PORT"
{
  printf '\n# >>> added-domain:%s\n' "$DOMAIN"
  printf '%s {\n\tencode zstd gzip\n\t@assets path /assets/*\n\theader @assets Cache-Control "public, max-age=31536000, immutable"\n\t@documents path / /index.html /*.html\n\theader @documents Cache-Control "no-cache, no-store, must-revalidate"\n\treverse_proxy 127.0.0.1:%s\n}\n' "$HOSTS" "$APP_PORT"
  if [ "$API_OK" = "1" ]; then
    printf '\napi.%s {\n\treverse_proxy 127.0.0.1:%s\n}\n' "$DOMAIN" "$API_PORT"
  else
    printf '# api.%s skipped: add an A record api -> %s and re-run this script\n' "$DOMAIN" "${IP:-SERVER_IP}"
  fi
  printf '# <<< added-domain:%s\n' "$DOMAIN"
} >> "$CADDYFILE"

log "Validating Caddyfile"
caddy validate --config "$CADDYFILE" --adapter caddyfile

# ------------------------------------------------------- 5. reload + wait cert
log "Reloading Caddy"
systemctl enable caddy >/dev/null 2>&1 || true
systemctl reload caddy 2>/dev/null || systemctl restart caddy
sleep 3
systemctl is-active --quiet caddy || { journalctl -u caddy -n 40 --no-pager; die "Caddy is not running."; }

log "Waiting for the HTTPS certificate (up to 120s)"
ok=0
for i in $(seq 1 24); do
  code="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 8 "https://$DOMAIN" || true)"
  if [ -n "$code" ] && [ "$code" != "000" ]; then ok=1; echo "  https://$DOMAIN -> HTTP $code"; break; fi
  echo "  ...still issuing ($i/24)"
  sleep 5
done

if [ "$ok" != "1" ]; then
  warn "Certificate not ready yet. Recent Caddy log:"
  journalctl -u caddy -n 60 --no-pager | tail -60
  warn "Most common causes: port 80 blocked by the provider firewall, or DNS still propagating."
fi

# ------------------------------------------- 6. allow origin in Supabase auth
ENVF="$SUPA_DIR/.env"
if [ -f "$ENVF" ]; then
  log "Adding $DOMAIN to auth redirect URLs"
  cur="$(grep -E '^ADDITIONAL_REDIRECT_URLS=' "$ENVF" | cut -d= -f2- | tr -d '"' || true)"
  add="https://$DOMAIN,https://www.$DOMAIN,https://$DOMAIN/*,https://www.$DOMAIN/*"
  new="$(printf '%s,%s' "${cur:-}" "$add" | sed 's/^,//' | tr ',' '\n' | awk 'NF && !seen[$0]++' | paste -sd, -)"
  if grep -q '^ADDITIONAL_REDIRECT_URLS=' "$ENVF"; then
    sed -i "s|^ADDITIONAL_REDIRECT_URLS=.*|ADDITIONAL_REDIRECT_URLS=$new|" "$ENVF"
  else
    echo "ADDITIONAL_REDIRECT_URLS=$new" >> "$ENVF"
  fi
  (cd "$SUPA_DIR" && docker compose up -d auth >/dev/null 2>&1 || true)
fi

log "Summary"
echo "  App upstream : 127.0.0.1:$APP_PORT  ($(ss -lntp 2>/dev/null | grep -c ":$APP_PORT ") listener)"
echo "  Test         : curl -I https://$DOMAIN"
echo "  Certs        : ls /var/lib/caddy/.local/share/caddy/certificates/*/$DOMAIN 2>/dev/null || true"
echo
echo "Done."
