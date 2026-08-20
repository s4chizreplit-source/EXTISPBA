#!/usr/bin/env bash
# Verify one existing pending engagement order dispatches exactly once.
# TEST_ORDER_ID is optional: without it, the newest safely retryable queued
# engagement order is selected automatically.
set -Eeuo pipefail
SUPA_DIR="${SUPA_DIR:-/opt/supabase}"
ENVF="$SUPA_DIR/.env"
die() { echo "[FAIL] $*" >&2; exit 1; }
[ -f "$ENVF" ] || die "backend env missing"
cd "$SUPA_DIR"
psql_db() { docker compose exec -T db psql -X -U postgres -d postgres -v ON_ERROR_STOP=1 "$@"; }
scalar() { psql_db -tAc "$1" | tr -d '[:space:]'; }
env_value() { grep -E "^$1=" "$ENVF" | head -1 | cut -d= -f2- | tr -d '"\r'; }
PORT="$(env_value KONG_HTTP_PORT)"; KEY="$(env_value SERVICE_ROLE_KEY)"
[ -n "$KEY" ] || die "SERVICE_ROLE_KEY missing"

echo '=== CRON ACTIVE ==='
psql_db -P pager=off -c "SELECT jobname,schedule,active FROM cron.job ORDER BY jobname;"
BAD="$(scalar "SELECT count(*) FROM cron.job WHERE NOT active OR command LIKE '%supabase.co%';")"
[ "$BAD" = "0" ] || die "$BAD inactive/hosted cron jobs found"

ORDER_ID="${TEST_ORDER_ID:-}"
if [ -z "$ORDER_ID" ]; then
  ORDER_ID="$(scalar "SELECT i.engagement_order_id
    FROM public.organic_run_schedule r
    JOIN public.engagement_order_items i ON i.id=r.engagement_order_item_id
    JOIN public.engagement_orders o ON o.id=i.engagement_order_id
    WHERE o.status IN ('pending','processing')
      AND i.status IN ('pending','processing')
      AND r.provider_order_id IS NULL
      AND r.status IN ('pending','failed')
      AND coalesce(r.error_message,'') NOT ILIKE '%dispatch uncertain%'
      AND coalesce(r.error_message,'') NOT ILIKE '%awaiting provider confirmation%'
    ORDER BY o.created_at DESC,r.scheduled_at,r.created_at
    LIMIT 1;")"
  [ -n "$ORDER_ID" ] || die "no safely retryable queued engagement order found"
  echo "auto-selected latest queued order: $ORDER_ID"
fi
[[ "$ORDER_ID" =~ ^[0-9a-fA-F-]{36}$ ]] || die "invalid TEST_ORDER_ID"
RUN_ID="$(scalar "SELECT r.id FROM public.organic_run_schedule r JOIN public.engagement_order_items i ON i.id=r.engagement_order_item_id WHERE i.engagement_order_id='$ORDER_ID' AND r.provider_order_id IS NULL AND r.status IN ('pending','failed') AND coalesce(r.error_message,'') NOT ILIKE '%dispatch uncertain%' AND coalesce(r.error_message,'') NOT ILIKE '%awaiting provider confirmation%' ORDER BY r.scheduled_at,r.created_at LIMIT 1;")"
[ -n "$RUN_ID" ] || die "no safely retryable run exists for order $ORDER_ID"
USER_ID="$(scalar "SELECT user_id FROM public.engagement_orders WHERE id='$ORDER_ID';")"
[ -n "$USER_ID" ] || die "selected order is not an engagement order"
BALANCE_BEFORE="$(scalar "SELECT balance FROM public.wallets WHERE user_id='$USER_ID';")"
TX_BEFORE="$(scalar "SELECT count(*) FROM public.transactions WHERE order_id='$ORDER_ID';")"
echo "test_order=$ORDER_ID run=$RUN_ID wallet_before=$BALANCE_BEFORE order_transactions_before=$TX_BEFORE"

psql_db -c "UPDATE public.organic_run_schedule SET status='pending',scheduled_at=now(),started_at=NULL WHERE id='$RUN_ID' AND provider_order_id IS NULL AND status IN ('pending','failed');" >/dev/null
call_retry() {
  local label="$1" code
  code="$(curl -sS --max-time 300 -o "/tmp/retry-$label.json" -w '%{http_code}' \
    "http://127.0.0.1:${PORT:-8000}/functions/v1/retry-pending-dispatch" \
    -H "Authorization: Bearer $KEY" -H "apikey: $KEY" -H 'Content-Type: application/json' --data "{\"run_id\":\"$RUN_ID\"}")"
  echo "$label HTTP=$code response=$(head -c 600 "/tmp/retry-$label.json")"
  [ "$code" = "200" ] || die "$label retry endpoint failed"
}
call_retry first
PROVIDER_ID_1="$(scalar "SELECT coalesce(provider_order_id,'') FROM public.organic_run_schedule WHERE id='$RUN_ID';")"
[ -n "$PROVIDER_ID_1" ] || {
  psql_db -P pager=off -c "SELECT r.status,r.error_message,i.engagement_type,i.service_id FROM public.organic_run_schedule r JOIN public.engagement_order_items i ON i.id=r.engagement_order_item_id WHERE r.id='$RUN_ID';"
  die "provider_order_id is still NULL after first retry"
}
call_retry second
PROVIDER_ID_2="$(scalar "SELECT coalesce(provider_order_id,'') FROM public.organic_run_schedule WHERE id='$RUN_ID';")"
BALANCE_AFTER="$(scalar "SELECT balance FROM public.wallets WHERE user_id='$USER_ID';")"
TX_AFTER="$(scalar "SELECT count(*) FROM public.transactions WHERE order_id='$ORDER_ID';")"
[ "$PROVIDER_ID_1" = "$PROVIDER_ID_2" ] || die "provider order changed on second retry ($PROVIDER_ID_1 -> $PROVIDER_ID_2)"
[ "$BALANCE_BEFORE" = "$BALANCE_AFTER" ] || die "wallet changed during retry ($BALANCE_BEFORE -> $BALANCE_AFTER)"
[ "$TX_BEFORE" = "$TX_AFTER" ] || die "transaction count changed during retry ($TX_BEFORE -> $TX_AFTER)"

echo '=== RECENT CRON EXECUTIONS ==='
psql_db -P pager=off -c "SELECT j.jobname,r.status,left(coalesce(r.return_message,''),120) return_message,r.start_time FROM cron.job_run_details r LEFT JOIN cron.job j ON j.jobid=r.jobid ORDER BY r.start_time DESC LIMIT 20;"
echo "PASS: provider_order_id=$PROVIDER_ID_1 remained unchanged on second retry; wallet=$BALANCE_AFTER; order_transactions=$TX_AFTER"