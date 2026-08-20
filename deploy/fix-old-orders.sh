#!/usr/bin/env bash
# ============================================================================
# FIX OLD / STUCK ORDERS  (self-hosted VPS)
#
#   bash deploy/fix-old-orders.sh
#
# Kya karta hai:
#   1. cron jobs verify + missing hone par dobara schedule
#   2. purane overdue "queued" runs ka diagnosis
#   3. dead runs cleanup (parent already completed/cancelled)
#   4. execute-all-runs ko controlled loop me chala kar overdue runs bhejna
#   5. final report (kitne bache, kitne bhej diye)
# Safe hai: koi run duplicate dispatch nahi hota, executor khud lock leta hai.
# ============================================================================
set -euo pipefail

SUPA_DIR="${SUPA_DIR:-/opt/supabase}"
REPO_DIR="${REPO_DIR:-/opt/smmpanel}"
MAX_LOOPS="${MAX_LOOPS:-40}"
PASS_PAUSE="${PASS_PAUSE:-5}"
ENVF="$SUPA_DIR/.env"

fail() { echo "[error] $*" >&2; exit 1; }
[ -f "$ENVF" ] || fail "backend env missing at $ENVF"
cd "$SUPA_DIR" || fail "backend stack missing at $SUPA_DIR"

env_value() { grep -E "^$1=" "$ENVF" | head -1 | cut -d= -f2- | tr -d '"\r'; }
PORT="$(env_value KONG_HTTP_PORT || true)"; PORT="${PORT:-8000}"
SRK="$(env_value SERVICE_ROLE_KEY || true)"
[ -n "$SRK" ] || fail "SERVICE_ROLE_KEY missing in $ENVF"

psql_t() { docker compose exec -T db psql -U postgres -d postgres -tAc "$1" 2>/dev/null | tr -d '\r'; }
scalar() { psql_t "$1" | tr -d '[:space:]'; }

echo "==> 1/5 cron jobs check"
CRON_OK="$(scalar "SELECT count(*) FROM cron.job WHERE command LIKE '%execute-all-runs%'" || echo 0)"
if [ "${CRON_OK:-0}" = "0" ]; then
  echo "   cron missing -> re-scheduling"
  bash "$REPO_DIR/deploy/schedule-cron.sh"
else
  echo "   cron jobs present: $(scalar "SELECT count(*) FROM cron.job")"
fi
# hosted (purane supabase.co) cron leftovers hata do — wo kabhi chalte hi nahi
psql_t "DO \$\$ BEGIN PERFORM cron.unschedule(jobid) FROM cron.job WHERE command LIKE '%supabase.co%'; EXCEPTION WHEN OTHERS THEN NULL; END \$\$;" >/dev/null || true

echo "==> 2/5 diagnosis"
echo "   overdue pending runs : $(scalar "SELECT count(*) FROM public.organic_run_schedule WHERE status='pending' AND scheduled_at <= now()")"
echo "   future pending runs  : $(scalar "SELECT count(*) FROM public.organic_run_schedule WHERE status='pending' AND scheduled_at > now()")"
echo "   stuck 'processing'   : $(scalar "SELECT count(*) FROM public.organic_run_schedule WHERE status='processing' AND started_at < now() - interval '30 minutes'")"
echo "   open orders          : $(scalar "SELECT count(*) FROM public.engagement_orders WHERE status IN ('pending','processing')")"

echo "==> 3/5 cleanup"
# 3a. 30 min se zyada 'processing' me atke runs wapas pending (crash/restart ke baad)
REVIVED="$(scalar "WITH u AS (
  UPDATE public.organic_run_schedule
     SET status='pending', started_at=NULL, error_message=NULL
   WHERE status='processing'
     AND provider_order_id IS NULL
     AND started_at < now() - interval '30 minutes'
  RETURNING 1) SELECT count(*) FROM u")"
echo "   revived stuck processing runs : ${REVIVED:-0}"

# 3b. jinke parent order/item pehle hi band ho gaye, un pending runs ko cancel
DEAD="$(scalar "WITH u AS (
  UPDATE public.organic_run_schedule ors
     SET status='cancelled', error_message='parent order closed'
   WHERE ors.status='pending'
     AND EXISTS (
       SELECT 1 FROM public.engagement_order_items eoi
       JOIN public.engagement_orders eo ON eo.id = eoi.engagement_order_id
       WHERE eoi.id = ors.engagement_order_item_id
         AND (eo.status IN ('completed','cancelled','failed') OR eoi.status IN ('completed','cancelled','failed'))
     )
  RETURNING 1) SELECT count(*) FROM u")"
echo "   cancelled dead runs           : ${DEAD:-0}"

# 3c. order 'pending' pada hai par runs chal chuke hain -> processing kar do
psql_t "UPDATE public.engagement_orders eo SET status='processing', updated_at=now()
        WHERE eo.status='pending'
          AND EXISTS (SELECT 1 FROM public.engagement_order_items eoi
                      JOIN public.organic_run_schedule ors ON ors.engagement_order_item_id = eoi.id
                      WHERE eoi.engagement_order_id = eo.id AND ors.status='pending');" >/dev/null || true

echo "==> 4/5 dispatching overdue runs (max $MAX_LOOPS passes)"
LAST=-1
for i in $(seq 1 "$MAX_LOOPS"); do
  DUE="$(scalar "SELECT count(*) FROM public.organic_run_schedule WHERE status='pending' AND scheduled_at <= now()")"
  DUE="${DUE:-0}"
  echo "   pass $i: overdue=$DUE"
  [ "$DUE" = "0" ] && break
  CODE="$(curl -sS --max-time 75 -o /tmp/exec-all-runs.json -w '%{http_code}' \
    "http://127.0.0.1:${PORT}/functions/v1/execute-all-runs" \
    -H "Authorization: Bearer $SRK" -H "apikey: $SRK" \
    -H 'Content-Type: application/json' --data '{"instant":true}' || true)"
  if [ "$CODE" != "200" ] && [ "$CODE" != "202" ]; then
    echo "[warn] execute-all-runs HTTP ${CODE:-000}: $(head -c 300 /tmp/exec-all-runs.json 2>/dev/null || true)" >&2
  fi
  AFTER="$(scalar "SELECT count(*) FROM public.organic_run_schedule WHERE status='pending' AND scheduled_at <= now()")"
  AFTER="${AFTER:-0}"
  echo "   pass $i result: HTTP ${CODE:-000}, remaining=$AFTER"
  if [ "$DUE" = "$LAST" ] && [ "$AFTER" = "$DUE" ]; then
    echo "   do passes me progress nahi hui — provider busy ya mapping missing (neeche errors dekhein)"
    break
  fi
  LAST="$DUE"
  [ "$AFTER" = "0" ] && break
  sleep "$PASS_PAUSE"
done

echo "==> 5/5 final report"
docker compose exec -T db psql -U postgres -d postgres -c \
  "SELECT status, count(*) AS runs, min(scheduled_at) AS oldest
     FROM public.organic_run_schedule GROUP BY status ORDER BY runs DESC;"
docker compose exec -T db psql -U postgres -d postgres -c \
  "SELECT eo.order_number, eo.status,
          count(ors.id) FILTER (WHERE ors.status='completed') AS done,
          count(ors.id) AS total, max(ors.error_message) AS last_error
     FROM public.engagement_orders eo
     JOIN public.engagement_order_items eoi ON eoi.engagement_order_id = eo.id
     LEFT JOIN public.organic_run_schedule ors ON ors.engagement_order_item_id = eoi.id
    WHERE eo.status IN ('pending','processing')
    GROUP BY eo.order_number, eo.status
    ORDER BY eo.order_number DESC LIMIT 20;"
echo "==> done"
