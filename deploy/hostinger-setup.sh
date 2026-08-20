#!/usr/bin/env bash
# ============================================================================
# App install/build on the VPS (idempotent).
#   bash deploy/hostinger-setup.sh
# Reads Supabase creds from /opt/supabase/.env and writes /opt/smmpanel/.env
# Serves the built SPA on 127.0.0.1:3000 via systemd (smmpanel.service).
# ============================================================================
set -euo pipefail

REPO_DIR="${REPO_DIR:-/opt/smmpanel}"
SUPA_DIR="${SUPA_DIR:-/opt/supabase}"
REPO_URL="${REPO_URL:-https://github.com/xbhisofy/extips-new-pannel.git}"
APP_PORT="${APP_PORT:-3000}"

log()  { echo -e "\n\033[1;32m==>\033[0m $*"; }
die()  { echo -e "\033[1;31m[error]\033[0m $*" >&2; exit 1; }
[ "$(id -u)" -eq 0 ] || die "Run as root."

log "1/6 Node 22 + pnpm 9"
if ! command -v node >/dev/null 2>&1 || [ "$(node -v | sed 's/v\([0-9]*\).*/\1/')" -lt 22 ]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi
# pnpm 10+/11 requires Node >= 22.13; pin 9.x which works everywhere
corepack enable >/dev/null 2>&1 || true
corepack prepare pnpm@9.15.9 --activate >/dev/null 2>&1 || npm i -g pnpm@9.15.9
pnpm -v
command -v serve >/dev/null 2>&1 || npm i -g serve

log "2/6 Repo"
if [ -d "$REPO_DIR/.git" ]; then
  git -C "$REPO_DIR" fetch --all --prune && git -C "$REPO_DIR" reset --hard origin/main
else
  git clone "$REPO_URL" "$REPO_DIR"
fi
cd "$REPO_DIR"

log "3/6 Frontend .env from $SUPA_DIR/.env"
[ -f "$SUPA_DIR/.env" ] || die "$SUPA_DIR/.env not found — run supabase-selfhost.sh first"
API_URL="$(grep -E '^API_EXTERNAL_URL=' "$SUPA_DIR/.env" | cut -d= -f2- | tr -d '"')"
ANON="$(grep -E '^ANON_KEY=' "$SUPA_DIR/.env" | cut -d= -f2- | tr -d '"')"
[ -n "$API_URL" ] && [ -n "$ANON" ] || die "API_EXTERNAL_URL / ANON_KEY missing in $SUPA_DIR/.env"
printf 'VITE_SUPABASE_URL=%s\nVITE_SUPABASE_PUBLISHABLE_KEY=%s\nVITE_SUPABASE_PROJECT_ID=selfhosted\n' \
  "$API_URL" "$ANON" > "$REPO_DIR/.env"
cat "$REPO_DIR/.env"

log "4/6 Install + build"
pnpm install --no-frozen-lockfile
rm -rf dist-new
pnpm run build --outDir dist-new
[ -d dist-new ] || die "build produced no dist-new"
# Preserve previous hashed assets for open browser tabs across deployments.
# The current build wins; only missing old chunks are copied in.
if [ -d dist/assets ]; then
  mkdir -p dist-new/assets
  cp -an dist/assets/. dist-new/assets/
  find dist-new/assets -type f -mtime +30 -delete
fi
rm -rf dist-old
[ -d dist ] && mv dist dist-old
mv dist-new dist
rm -rf dist-old

log "5/6 systemd service on 127.0.0.1:$APP_PORT"
cat > /etc/systemd/system/smmpanel.service <<EOF
[Unit]
Description=OrganicSMM Pro frontend
After=network.target

[Service]
WorkingDirectory=$REPO_DIR
ExecStart=$(command -v serve) -s dist -l tcp://127.0.0.1:$APP_PORT
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable --now smmpanel
systemctl restart smmpanel

log "6/6 Firewall + health"
if command -v ufw >/dev/null 2>&1; then
  ufw allow 22/tcp >/dev/null 2>&1 || true
  ufw allow 80/tcp >/dev/null 2>&1 || true
  ufw allow 443/tcp >/dev/null 2>&1 || true
  yes | ufw enable >/dev/null 2>&1 || true
fi
sleep 2
echo "   GET http://127.0.0.1:$APP_PORT -> HTTP $(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:$APP_PORT/)"
echo "[done] frontend built and running."
