#!/usr/bin/env bash
# ============================================================================
# OrganicSMM Pro — FULL self-hosted Supabase stack installer (idempotent)
#
#   curl -fsSL https://raw.githubusercontent.com/xbhisofy/extips-new-pannel/main/deploy/supabase-selfhost.sh | bash
#
# Optional env:
#   DOMAIN=api.example.com    (only used to set API_EXTERNAL_URL)
#   INSTALL_DIR=/opt/supabase
#   REPO_DIR=/opt/smmpanel
# ============================================================================
set -euo pipefail

# If piped into bash (curl | bash), docker/psql commands would eat the script
# from stdin. Re-exec from a real file so stdin stays free.
if [ ! -f "${BASH_SOURCE[0]:-}" ]; then
  _self="/tmp/supabase-selfhost.$$.sh"
  curl -fsSL "https://raw.githubusercontent.com/xbhisofy/extips-new-pannel/main/deploy/supabase-selfhost.sh" -o "$_self"
  chmod +x "$_self"
  exec bash "$_self" </dev/null
fi
exec </dev/null


INSTALL_DIR="${INSTALL_DIR:-/opt/supabase}"
REPO_DIR="${REPO_DIR:-/opt/smmpanel}"
REPO_URL="${REPO_URL:-https://github.com/xbhisofy/extips-new-pannel.git}"
DOMAIN="${DOMAIN:-}"

log()  { echo -e "\n\033[1;32m==>\033[0m $*"; }
warn() { echo -e "\033[1;33m[warn]\033[0m $*"; }
die()  { echo -e "\033[1;31m[error]\033[0m $*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "Run as root (or with sudo)."

port_busy() { ss -ltn 2>/dev/null | awk '{print $4}' | grep -Eq "(^|:)$1$"; }
free_port() { local p="$1"; while port_busy "$p"; do p=$((p+1)); done; echo "$p"; }

# ---------------------------------------------------------------------------
log "1/9 Base packages (docker, git, openssl, jq)"
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y ca-certificates curl gnupg git openssl jq iproute2

if ! command -v docker >/dev/null 2>&1; then
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg | gpg --batch --yes --dearmor -o /etc/apt/keyrings/docker.gpg
  chmod a+r /etc/apt/keyrings/docker.gpg
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] \
https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" \
    > /etc/apt/sources.list.d/docker.list
  apt-get update -y
  apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
fi
systemctl enable --now docker

# ---------------------------------------------------------------------------
log "2/9 Supabase docker stack -> $INSTALL_DIR"
if [ ! -f "$INSTALL_DIR/.stack_ready" ]; then
  if [ -f "$INSTALL_DIR/docker-compose.yml" ]; then
    (cd "$INSTALL_DIR" && docker compose down --remove-orphans >/dev/null 2>&1) || true
  fi
  rm -rf "$INSTALL_DIR-src"
  git clone --depth 1 https://github.com/supabase/supabase "$INSTALL_DIR-src"
  # docker may have auto-created dirs where files must live
  for pat in '*.sql' '*.yml' '*.toml' '*.conf'; do
    find "$INSTALL_DIR" -depth -type d -name "$pat" -exec rm -rf {} + 2>/dev/null || true
  done
  mkdir -p "$INSTALL_DIR"
  cp -rT "$INSTALL_DIR-src/docker" "$INSTALL_DIR"
  rm -rf "$INSTALL_DIR-src"
  touch "$INSTALL_DIR/.stack_ready"
fi
cd "$INSTALL_DIR"
[ -f docker-compose.yml ] || die "compose files missing in $INSTALL_DIR"

ENV_FILE="$INSTALL_DIR/.env"
set_env() {
  [ -f "$ENV_FILE" ] || touch "$ENV_FILE"
  if grep -q "^$1=" "$ENV_FILE"; then sed -i "s|^$1=.*|$1=$2|" "$ENV_FILE"; else echo "$1=$2" >> "$ENV_FILE"; fi
}
get_env() { grep -E "^$1=" "$ENV_FILE" | head -1 | cut -d= -f2- | tr -d '"'; }

# ---------------------------------------------------------------------------
log "3/9 Secrets (generated once, reused after that)"
if [ ! -f "$ENV_FILE.generated" ]; then
  cp .env.example "$ENV_FILE"
  POSTGRES_PASSWORD="$(openssl rand -hex 24)"
  JWT_SECRET="$(openssl rand -hex 32)"
  DASHBOARD_PASSWORD="$(openssl rand -hex 12)"

  b64url() { openssl base64 -A | tr '+/' '-_' | tr -d '='; }
  mint_jwt() {
    local role="$1" iat exp header payload si sig
    iat="$(date +%s)"; exp="$((iat + 60*60*24*3650))"
    header="$(printf '%s' '{"alg":"HS256","typ":"JWT"}' | b64url)"
    payload="$(printf '{"role":"%s","iss":"supabase","iat":%s,"exp":%s}' "$role" "$iat" "$exp" | b64url)"
    si="$header.$payload"
    sig="$(printf '%s' "$si" | openssl dgst -sha256 -hmac "$JWT_SECRET" -binary | b64url)"
    printf '%s.%s\n' "$si" "$sig"
  }

  set_env POSTGRES_PASSWORD  "$POSTGRES_PASSWORD"
  set_env JWT_SECRET         "$JWT_SECRET"
  set_env ANON_KEY           "$(mint_jwt anon)"
  set_env SERVICE_ROLE_KEY   "$(mint_jwt service_role)"
  set_env DASHBOARD_USERNAME "admin"
  set_env DASHBOARD_PASSWORD "$DASHBOARD_PASSWORD"
  set_env SECRET_KEY_BASE    "$(openssl rand -hex 32)"
  set_env VAULT_ENC_KEY      "$(openssl rand -hex 16)"
  set_env ENABLE_EMAIL_AUTOCONFIRM "true"
  set_env DISABLE_SIGNUP           "false"
  set_env ENABLE_EMAIL_SIGNUP      "true"
  touch "$ENV_FILE.generated"
fi

# ---------------------------------------------------------------------------
log "4/9 Port conflict handling"
docker compose down --remove-orphans >/dev/null 2>&1 || true
PG_PORT="$(free_port 5433)"        # keep 5432 free for any native postgres
KONG_PORT="$(free_port 8000)"
KONG_TLS_PORT="$(free_port 8443)"
STUDIO_PORT="$(free_port 3001)"    # 3000 belongs to the frontend
set_env POSTGRES_PORT       "$PG_PORT"
set_env KONG_HTTP_PORT      "$KONG_PORT"
set_env KONG_HTTPS_PORT     "$KONG_TLS_PORT"
set_env STUDIO_PORT         "$STUDIO_PORT"
echo "   postgres=$PG_PORT  api(kong)=$KONG_PORT  studio=$STUDIO_PORT"

if [ -n "$DOMAIN" ]; then
  set_env API_EXTERNAL_URL    "https://$DOMAIN"
  set_env SUPABASE_PUBLIC_URL "https://$DOMAIN"
  set_env SITE_URL            "https://${DOMAIN#api.}"
else
  IP="$(curl -fsS4 https://ifconfig.me || hostname -I | awk '{print $1}')"
  set_env API_EXTERNAL_URL    "http://$IP:$KONG_PORT"
  set_env SUPABASE_PUBLIC_URL "http://$IP:$KONG_PORT"
  set_env SITE_URL            "http://$IP"
fi

# ---------------------------------------------------------------------------
log "5/9 Starting stack"
docker compose pull
docker compose up -d

log "Waiting for Postgres"
for _ in $(seq 1 60); do docker compose exec -T db pg_isready -U postgres >/dev/null 2>&1 && break; sleep 2; done
docker compose exec -T db pg_isready -U postgres >/dev/null 2>&1 \
  || die "Postgres did not come up. Check: cd $INSTALL_DIR && docker compose logs db"

POOLER_SVC=""
for c in pooler supavisor; do docker compose config --services 2>/dev/null | grep -qx "$c" && POOLER_SVC="$c" && break; done
if [ -n "$POOLER_SVC" ]; then
  docker compose restart "$POOLER_SVC" >/dev/null 2>&1 || true
fi

# ---------------------------------------------------------------------------
log "6/9 Project repo -> $REPO_DIR"
if [ -d "$REPO_DIR/.git" ]; then
  git -C "$REPO_DIR" fetch --all --prune
  git -C "$REPO_DIR" reset --hard origin/main
else
  git clone "$REPO_URL" "$REPO_DIR"
fi

# ---------------------------------------------------------------------------
log "7/9 Applying migrations (serial order, retry passes)"
MIG_DIR="$REPO_DIR/supabase/migrations"
[ -d "$MIG_DIR" ] || die "No migrations at $MIG_DIR"

docker compose exec -T db psql -U postgres -d postgres >/dev/null <<'SQL' 2>&1 || true
CREATE TABLE IF NOT EXISTS public._applied_migrations (
  name text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);
SQL
# Extensions: pg_cron's after-create script can fail on re-run ("dependent
# privileges exist"). Each runs separately and failures are tolerated.
for ext in pg_cron pg_net pgcrypto; do
  docker compose exec -T db psql -U postgres -d postgres \
    -c "CREATE EXTENSION IF NOT EXISTS $ext" >/dev/null 2>&1 || true
done
docker compose exec -T db psql -U postgres -d postgres -tAc \
  "SELECT 'ext ok: '||string_agg(extname,',') FROM pg_extension WHERE extname IN ('pg_cron','pg_net','pgcrypto')" || true

TOTAL=$(ls "$MIG_DIR"/*.sql | wc -l)
echo "   $TOTAL migration files found"
APPLIED=0; PASS=1; LAST_FAILS=""
while [ "$PASS" -le 5 ]; do
  PASS_APPLIED=0; PASS_FAILED=0; LAST_FAILS=""
  for f in $(ls "$MIG_DIR"/*.sql | sort); do
    name="$(basename "$f")"
    done_row="$(docker compose exec -T db psql -U postgres -d postgres -tAc \
      "SELECT 1 FROM public._applied_migrations WHERE name='$name'" || true)"
    [ "$done_row" = "1" ] && continue
    if docker compose exec -T db psql -U postgres -d postgres -v ON_ERROR_STOP=1 -f - < "$f" >/tmp/mig.log 2>&1; then
      docker compose exec -T db psql -U postgres -d postgres -c \
        "INSERT INTO public._applied_migrations(name) VALUES ('$name') ON CONFLICT DO NOTHING" >/dev/null
      PASS_APPLIED=$((PASS_APPLIED+1)); APPLIED=$((APPLIED+1))
    else
      PASS_FAILED=$((PASS_FAILED+1)); LAST_FAILS="$LAST_FAILS $name"
      if [ "$PASS" -eq 1 ]; then warn "deferred: $name"; tail -n 4 /tmp/mig.log; fi
    fi
  done
  echo "   pass $PASS: applied=$PASS_APPLIED pending=$PASS_FAILED"
  [ "$PASS_FAILED" -eq 0 ] && break
  [ "$PASS_APPLIED" -eq 0 ] && break
  PASS=$((PASS+1))
done
if [ -n "${LAST_FAILS// /}" ]; then
  warn "still pending (usually data-dependent or obsolete cron migrations):$LAST_FAILS"
  for name in $LAST_FAILS; do
    echo "----- $name -----"
    # This is diagnostic output only. With `set -e -o pipefail`, an expected
    # migration failure in this preview pipeline must not abort the installer
    # before it prints credentials and the next migration step.
    (docker compose exec -T db psql -U postgres -d postgres -v ON_ERROR_STOP=1 -f - \
      < "$MIG_DIR/$name" 2>&1 | tail -n 6) || true
  done
fi
echo "   migrations applied this run: $APPLIED"

# ---------------------------------------------------------------------------
log "8/9 Making scripts executable"
chmod +x "$REPO_DIR"/deploy/*.sh || true

# ---------------------------------------------------------------------------
log "9/9 Credentials"
grep -E '^(API_EXTERNAL_URL|ANON_KEY|SERVICE_ROLE_KEY|JWT_SECRET|POSTGRES_PASSWORD|POSTGRES_PORT|KONG_HTTP_PORT|STUDIO_PORT|DASHBOARD_USERNAME|DASHBOARD_PASSWORD)=' "$ENV_FILE"

cat <<EOF

----------------------------------------------------------------------
NEXT: run the numbered blocks from the migration guide:
  bash $REPO_DIR/deploy/hostinger-setup.sh
  bash $REPO_DIR/deploy/import-data.sh
  bash $REPO_DIR/deploy/import-auth-passwords.sh
  bash $REPO_DIR/deploy/deploy-edge-functions.sh
  DOMAIN=yourdomain.com bash $REPO_DIR/deploy/setup-domain.sh
  bash $REPO_DIR/deploy/schedule-cron.sh
Stack: cd $INSTALL_DIR && docker compose ps
----------------------------------------------------------------------
EOF
