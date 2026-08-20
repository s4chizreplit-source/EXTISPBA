#!/usr/bin/env bash
# Send every existing successful gateway payment to the configured admin
# Telegram chat exactly once. New payments continue through edge webhooks.
set -euo pipefail

SUPA_DIR="${SUPA_DIR:-/opt/supabase}"
SECRETS_FILE="${SECRETS_FILE:-/etc/smmpanel.secrets}"
STATE_DIR="${STATE_DIR:-/var/lib/extips}"
STATE_FILE="$STATE_DIR/payment-history-telegram.sent"

log() { printf '\n\033[1;32m==>\033[0m %s\n' "$*"; }
die() { printf '\033[1;31m[error]\033[0m %s\n' "$*" >&2; exit 1; }

[ -f "$SECRETS_FILE" ] || die "$SECRETS_FILE not found"
[ -f "$SUPA_DIR/docker-compose.yml" ] || die "Backend stack not found at $SUPA_DIR"

read_secret() {
  local key="$1"
  sed -n "s/^${key}=//p" "$SECRETS_FILE" | tail -n 1 | tr -d '\r'
}

export TELEGRAM_BOT_TOKEN="$(read_secret TELEGRAM_BOT_TOKEN)"
export TELEGRAM_CHAT_ID="$(read_secret TELEGRAM_CHAT_ID)"
[ -n "$TELEGRAM_BOT_TOKEN" ] || die "TELEGRAM_BOT_TOKEN is empty in $SECRETS_FILE"
[ -n "$TELEGRAM_CHAT_ID" ] || die "TELEGRAM_CHAT_ID is empty in $SECRETS_FILE"

install -d -m 700 "$STATE_DIR"
touch "$STATE_FILE"
chmod 600 "$STATE_FILE"

TMP_JSON="$(mktemp)"
trap 'rm -f "$TMP_JSON"; unset TELEGRAM_BOT_TOKEN TELEGRAM_CHAT_ID' EXIT

log "Reading successful payment history"
cd "$SUPA_DIR"
docker compose exec -T db psql -X -U postgres -d postgres -v ON_ERROR_STOP=1 -tA <<'SQL' > "$TMP_JSON"
SELECT json_build_object(
  'id', t.id,
  'email', COALESCE(p.email, 'Unknown user'),
  'amount', abs(t.amount),
  'type', t.type,
  'method', COALESCE(t.payment_method, 'unknown'),
  'reference', COALESCE(t.payment_reference, '—'),
  'description', COALESCE(t.description, 'Payment'),
  'created_at', to_char(t.created_at AT TIME ZONE 'Asia/Kolkata', 'DD Mon YYYY, HH12:MI AM') || ' IST'
)::text
FROM public.transactions t
LEFT JOIN public.profiles p ON p.user_id = t.user_id
WHERE COALESCE(t.status, 'completed') = 'completed'
  AND lower(COALESCE(t.payment_method, '')) IN (
    'razorpay', 'razorpay_auto', 'zapupi', 'oxapay'
  )
  AND t.amount <> 0
ORDER BY t.created_at, t.id;
SQL

export PAYMENT_HISTORY_FILE="$TMP_JSON"
export PAYMENT_HISTORY_STATE="$STATE_FILE"
python3 <<'PY'
import html
import json
import os
import time
import urllib.error
import urllib.request

token = os.environ["TELEGRAM_BOT_TOKEN"]
chat_id = os.environ["TELEGRAM_CHAT_ID"]
history_file = os.environ["PAYMENT_HISTORY_FILE"]
state_file = os.environ["PAYMENT_HISTORY_STATE"]
url = f"https://api.telegram.org/bot{token}/sendMessage"

with open(state_file, "r", encoding="utf-8") as fh:
    sent = {line.strip() for line in fh if line.strip()}

rows = []
with open(history_file, "r", encoding="utf-8") as fh:
    for line in fh:
        line = line.strip()
        if line:
            rows.append(json.loads(line))

pending = [row for row in rows if str(row["id"]) not in sent]
print(f"   total={len(rows)} already_sent={len(rows) - len(pending)} pending={len(pending)}")

def send(text):
    payload = json.dumps({
        "chat_id": chat_id,
        "text": text[:4000],
        "parse_mode": "HTML",
        "disable_web_page_preview": True,
    }).encode("utf-8")
    request = urllib.request.Request(url, data=payload, headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(request, timeout=25) as response:
        result = json.loads(response.read().decode("utf-8"))
        if not result.get("ok"):
            raise RuntimeError(result.get("description", "Telegram rejected the message"))

if not pending:
    print("   Nothing new to send.")
    raise SystemExit(0)

send(
    "📚 <b>Previous Payment History</b>\n\n"
    f"Total <b>{len(pending)}</b> successful payment records ab bheje ja rahe hain. "
    "Iske baad sirf new payment ke live alerts aayenge."
)

success = 0
for row in pending:
    payment_type = "Subscription" if str(row.get("type", "")).lower() == "subscription" else "Wallet Deposit"
    message = (
        "✅ <b>Previous Payment</b>\n\n"
        f"👤 <b>User:</b> {html.escape(str(row['email']))}\n"
        f"💵 <b>Amount:</b> ${html.escape(str(row['amount']))}\n"
        f"🧾 <b>Type:</b> {payment_type}\n"
        f"💳 <b>Gateway:</b> {html.escape(str(row['method']).upper())}\n"
        f"🔖 <b>Reference:</b> <code>{html.escape(str(row['reference']))}</code>\n"
        f"🕒 <b>Paid:</b> {html.escape(str(row['created_at']))}\n"
        f"📝 <b>Details:</b> {html.escape(str(row['description']))}"
    )
    try:
        send(message)
        with open(state_file, "a", encoding="utf-8") as state:
            state.write(str(row["id"]) + "\n")
        success += 1
        print(f"   sent {success}/{len(pending)}")
        time.sleep(0.12)
    except (urllib.error.URLError, urllib.error.HTTPError, RuntimeError) as error:
        print(f"   FAILED after {success} messages: {error}")
        print("   Run this script again; already-sent records will not repeat.")
        raise SystemExit(1)

send(f"✅ <b>Payment History Complete</b>\n\n{success} previous payment records successfully sent.")
print(f"   Complete: {success} payment notifications sent.")
PY

unset PAYMENT_HISTORY_FILE PAYMENT_HISTORY_STATE
log "Done — old payments marked; future alerts remain automatic"