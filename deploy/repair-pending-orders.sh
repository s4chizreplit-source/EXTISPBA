#!/usr/bin/env bash
# Force-dispatch overdue organic runs on the self-hosted backend and show a
# useful result instead of silently relying on the next cron tick.
set -euo pipefail

SUPA_DIR="${SUPA_DIR:-/opt/supabase}"
ENVF="$SUPA_DIR/.env"

fail() { echo "[error] $*" >&2; exit 1; }
[ -f "$ENVF" ] || fail "backend env missing at $ENVF"
cd "$SUPA_DIR" || fail "backend stack missing at $SUPA_DIR"

env_value() {
  grep -E "^$1=" "$ENVF" | head -1 | cut -d= -f2- | tr -d '"\r'
}

PORT="$(env_value KONG_HTTP_PORT || true)"
SERVICE_KEY="$(env_value SERVICE_ROLE_KEY || true)"
[ -n "$SERVICE_KEY" ] || fail "SERVICE_ROLE_KEY is missing"

pending_count() {
  docker compose exec -T db psql -U postgres -d postgres -tAc \
    "SELECT count(*) FROM public.organic_run_schedule WHERE status='pending' AND scheduled_at <= now();" 2>/dev/null \
    | tr -d '[:space:]'
}

scalar() {
  docker compose exec -T db psql -U postgres -d postgres -tAc "$1" 2>/dev/null \
    | tr -d '[:space:]'
}

TABLE_EXISTS="$(docker compose exec -T db psql -U postgres -d postgres -tAc \
  "SELECT to_regclass('public.organic_run_schedule') IS NOT NULL;" 2>/dev/null | tr -d '[:space:]')"
[ "$TABLE_EXISTS" = "t" ] || fail "organic_run_schedule is missing; schema repair did not apply"

# Rebuild orders accepted while the schedule table was missing. Only orders
# with no schedule rows are resumed, preventing duplicate provider delivery.
mapfile -t UNSCHEDULED_ORDER_IDS < <(docker compose exec -T db psql -U postgres -d postgres -tAc \
  "SELECT eo.id
     FROM public.engagement_orders eo
    WHERE eo.status IN ('pending','processing')
      AND EXISTS (SELECT 1 FROM public.engagement_order_items eoi WHERE eoi.engagement_order_id = eo.id)
      AND NOT EXISTS (
        SELECT 1 FROM public.organic_run_schedule ors
        JOIN public.engagement_order_items eoi ON eoi.id = ors.engagement_order_item_id
        WHERE eoi.engagement_order_id = eo.id
      )
    ORDER BY eo.created_at LIMIT 100;" 2>/dev/null)

echo "   unscheduled orders found: ${#UNSCHEDULED_ORDER_IDS[@]}"
RESUMED=0
for ORDER_ID in "${UNSCHEDULED_ORDER_IDS[@]}"; do
  [ -n "$ORDER_ID" ] || continue
  RESUME_CODE="$(curl -sS --max-time 300 -o /tmp/order-resume-result.json -w '%{http_code}' \
    "http://127.0.0.1:${PORT:-8000}/functions/v1/process-engagement-order" \
    -H "Authorization: Bearer $SERVICE_KEY" -H "apikey: $SERVICE_KEY" \
    -H 'Content-Type: application/json' \
    --data "{\"engagement_order_id\":\"$ORDER_ID\"}" || true)"
  if [ "$RESUME_CODE" = "200" ]; then
    RESUMED=$((RESUMED + 1))
  else
    echo "[warn] could not rebuild order $ORDER_ID (HTTP ${RESUME_CODE:-000}): $(head -c 300 /tmp/order-resume-result.json 2>/dev/null || true)" >&2
  fi
done
echo "   unscheduled orders rebuilt: $RESUMED"

# A freshly rebuilt organic schedule intentionally starts in the future. During
# a repair this looked like "0 overdue" and no provider call happened at all.
# Move only the earliest untouched run of every active item to now; later runs
# keep their randomized organic timing and already-dispatched items are ignored.
KICKED="$(docker compose exec -T db psql -U postgres -d postgres -tAc \
  "WITH first_untouched AS (
     SELECT DISTINCT ON (ors.engagement_order_item_id) ors.id
       FROM public.organic_run_schedule ors
       JOIN public.engagement_order_items eoi ON eoi.id = ors.engagement_order_item_id
       JOIN public.engagement_orders eo ON eo.id = eoi.engagement_order_id
      WHERE ors.status = 'pending'
        AND eo.status IN ('pending','processing')
        AND eoi.status IN ('pending','processing')
        AND NOT EXISTS (
          SELECT 1 FROM public.organic_run_schedule sent
           WHERE sent.engagement_order_item_id = ors.engagement_order_item_id
             AND sent.provider_order_id IS NOT NULL
        )
      ORDER BY ors.engagement_order_item_id, ors.scheduled_at
   ), moved AS (
     UPDATE public.organic_run_schedule ors
        SET scheduled_at = LEAST(ors.scheduled_at, now())
       FROM first_untouched f
      WHERE ors.id = f.id
        AND ors.scheduled_at > now()
     RETURNING ors.id
   ) SELECT count(*) FROM moved;" 2>/dev/null | tr -d '[:space:]')"
echo "   first untouched runs made due now: ${KICKED:-0}"

TOTAL_PENDING="$(scalar "SELECT count(*) FROM public.organic_run_schedule WHERE status='pending';" || echo unknown)"
FUTURE_PENDING="$(scalar "SELECT count(*) FROM public.organic_run_schedule WHERE status='pending' AND scheduled_at > now();" || echo unknown)"
STARTED="$(scalar "SELECT count(*) FROM public.organic_run_schedule WHERE status='started';" || echo unknown)"
FAILED="$(scalar "SELECT count(*) FROM public.organic_run_schedule WHERE status='failed';" || echo unknown)"
echo "   run state before executor: pending=$TOTAL_PENDING future=$FUTURE_PENDING started=$STARTED failed=$FAILED"

BEFORE="$(pending_count || echo unknown)"
echo "   overdue runs before: $BEFORE"

# Refresh provider state before dispatching another run. This releases accounts
# whose previous order has completed since the last five-minute cron tick and
# avoids reporting them as busy from stale local state.
STATUS_CODE="$(curl -sS --max-time 300 -o /tmp/order-status-result.json -w '%{http_code}' \
  "http://127.0.0.1:${PORT:-8000}/functions/v1/check-order-status" \
  -H "Authorization: Bearer $SERVICE_KEY" -H "apikey: $SERVICE_KEY" \
  -H 'Content-Type: application/json' --data '{}' || true)"
if [ "$STATUS_CODE" = "200" ]; then
  echo "   provider status refresh -> HTTP 200"
else
  echo "[warn] provider status refresh HTTP ${STATUS_CODE:-000}: $(head -c 300 /tmp/order-status-result.json 2>/dev/null || true)" >&2
fi

# Ensure the runtime has loaded the freshly copied function before invoking it.
for _ in $(seq 1 20); do
  CODE="$(curl -sS --max-time 5 -o /tmp/order-executor-ready.json -w '%{http_code}' \
    "http://127.0.0.1:${PORT:-8000}/functions/v1/execute-all-runs" \
    -H "Authorization: Bearer $SERVICE_KEY" -H "apikey: $SERVICE_KEY" \
    -H 'Content-Type: application/json' --data '{}' || true)"
  [ "$CODE" != "000" ] && break
  sleep 2
done

CODE="$(curl -sS --max-time 300 -o /tmp/order-executor-result.json -w '%{http_code}' \
  "http://127.0.0.1:${PORT:-8000}/functions/v1/execute-all-runs" \
  -H "Authorization: Bearer $SERVICE_KEY" -H "apikey: $SERVICE_KEY" \
  -H 'Content-Type: application/json' --data '{"instant":true}' || true)"

if [ "$CODE" != "200" ]; then
  echo "[error] order executor HTTP ${CODE:-000}: $(head -c 500 /tmp/order-executor-result.json 2>/dev/null || true)" >&2
  docker compose logs functions --tail=40 2>/dev/null || docker compose logs edge-functions --tail=40 2>/dev/null || true
  exit 1
fi

AFTER="$(pending_count || echo unknown)"
echo "   order executor -> HTTP 200"
echo "   overdue runs after: $AFTER"
echo "   response: $(head -c 500 /tmp/order-executor-result.json)"

echo "   recent unresolved run errors:"
docker compose exec -T db psql -U postgres -d postgres -P pager=off -c \
  "SELECT ors.status, ors.run_number, eoi.engagement_type,
          left(coalesce(ors.error_message, 'no error recorded'), 110) AS error
     FROM public.organic_run_schedule ors
     LEFT JOIN public.engagement_order_items eoi ON eoi.id = ors.engagement_order_item_id
    WHERE ors.status IN ('pending','started','failed')
    ORDER BY coalesce(ors.last_status_check, ors.created_at) DESC NULLS LAST
    LIMIT 8;" 2>/dev/null || true

echo "   provider rotation coverage for unresolved services:"
docker compose exec -T db psql -U postgres -d postgres -P pager=off -c \
  "SELECT eoi.engagement_type,
          left(s.name, 42) AS service,
          count(DISTINCT spm.provider_account_id) FILTER (
            WHERE spm.is_active AND pa.is_active
          ) AS active_panels,
          string_agg(DISTINCT pa.name, ', ') FILTER (
            WHERE spm.is_active AND pa.is_active
          ) AS panels
     FROM public.organic_run_schedule ors
     JOIN public.engagement_order_items eoi ON eoi.id = ors.engagement_order_item_id
     LEFT JOIN public.services s ON s.id = eoi.service_id
     LEFT JOIN public.service_provider_mapping spm ON spm.service_id = eoi.service_id
     LEFT JOIN public.provider_accounts pa ON pa.id = spm.provider_account_id
    WHERE ors.status IN ('pending','started','failed')
    GROUP BY eoi.engagement_type, s.id, s.name
    ORDER BY active_panels, eoi.engagement_type
    LIMIT 30;" 2>/dev/null || true

echo "   admin retry endpoint (before/after counts):"
curl -sS --max-time 300 -X POST "http://127.0.0.1:${PORT:-8000}/functions/v1/retry-pending-dispatch" \
  -H "Authorization: Bearer $SERVICE_KEY" -H "apikey: $SERVICE_KEY" \
  -H 'Content-Type: application/json' --data '{}' | head -c 1200
echo