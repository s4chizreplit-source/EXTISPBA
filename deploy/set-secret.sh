#!/usr/bin/env bash
# Update (or add) a secret on the self-hosted VPS and redeploy edge functions.
# Usage:  bash deploy/set-secret.sh ZAPUPI_ZAP_KEY "new_value"
#         bash deploy/set-secret.sh KEY1=val1 KEY2=val2
# There is NO supabase CLI on this VPS — secrets live in /etc/smmpanel.secrets.
set -euo pipefail

SECRETS_FILE="${SECRETS_FILE:-/etc/smmpanel.secrets}"
REDEPLOY="${REDEPLOY:-1}"

log() { printf '\033[1;36m[secret]\033[0m %s\n' "$*"; }
die() { printf '\033[1;31m[error]\033[0m %s\n' "$*" >&2; exit 1; }

[ $# -ge 1 ] || die "usage: bash deploy/set-secret.sh NAME \"value\"   |   NAME=value ..."

touch "$SECRETS_FILE"
chmod 600 "$SECRETS_FILE"

set_one() {
  local name="$1" value="$2"
  [[ "$name" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] || die "invalid secret name: $name"
  # strip existing line(s), then append
  local tmp
  tmp="$(mktemp)"
  grep -v -E "^[[:space:]]*(export[[:space:]]+)?${name}=" "$SECRETS_FILE" > "$tmp" || true
  printf '%s=%s\n' "$name" "$value" >> "$tmp"
  cat "$tmp" > "$SECRETS_FILE"
  rm -f "$tmp"
  chmod 600 "$SECRETS_FILE"
  local masked="${value:0:4}…${value: -4}"
  log "set $name = $masked"
}

if [ $# -eq 2 ] && [[ "$1" != *=* ]]; then
  set_one "$1" "$2"
else
  for pair in "$@"; do
    [[ "$pair" == *=* ]] || die "expected NAME=value, got: $pair"
    set_one "${pair%%=*}" "${pair#*=}"
  done
fi

if [ "$REDEPLOY" = "1" ]; then
  SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  log "redeploying edge functions so the new value goes live…"
  bash "$SCRIPT_DIR/deploy-edge-functions.sh"
else
  log "skipped redeploy (REDEPLOY=0). Run: bash deploy/deploy-edge-functions.sh"
fi

log "done."
