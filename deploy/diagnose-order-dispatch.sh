#!/usr/bin/env bash
set -euo pipefail
SUPA_DIR="${SUPA_DIR:-/opt/supabase}"
cd "$SUPA_DIR"
psql_run() { docker compose exec -T db psql -U postgres -d postgres -P pager=off "$@"; }

echo '=== 1) STUCK ORDERS / DUE RUNS ==='
psql_run -c "SELECT
 (SELECT count(*) FROM public.engagement_orders eo WHERE eo.status='pending' AND NOT EXISTS (
   SELECT 1 FROM public.engagement_order_items eoi JOIN public.organic_run_schedule r ON r.engagement_order_item_id=eoi.id
   WHERE eoi.engagement_order_id=eo.id AND r.provider_order_id IS NOT NULL)) AS engagement_pending_without_provider,
 (SELECT count(*) FROM public.orders WHERE status='pending' AND provider_order_id IS NULL) AS legacy_pending_without_provider,
 (SELECT count(*) FROM public.organic_run_schedule WHERE status='pending' AND scheduled_at<=now()) AS due_pending_runs;"

echo '=== 2) CRON JOBS ==='
psql_run -c "SELECT jobname,schedule,active FROM cron.job ORDER BY jobname;"
echo '=== LAST 20 CRON RUNS ==='
psql_run -c "SELECT j.jobname,r.status,left(coalesce(r.return_message,''),180) AS return_message,r.start_time
 FROM cron.job_run_details r LEFT JOIN cron.job j ON j.jobid=r.jobid ORDER BY r.start_time DESC LIMIT 20;"

echo '=== 3) EDGE FUNCTION ERRORS (401/500/provider key) ==='
(docker compose logs functions --tail=500 2>/dev/null || docker compose logs edge-functions --tail=500 2>/dev/null || true) |
  grep -Ei 'execute-organic-runs|execute-all-runs|process-engagement-order|place-order|401|500|missing.*provider|provider.*error' | tail -n 120 || true

echo '=== 4) PROVIDER ACCOUNTS ==='
psql_run -c "SELECT id,name,provider_id,is_active,(nullif(btrim(api_url),'') IS NOT NULL) AS has_api_url,
 (nullif(btrim(api_key),'') IS NOT NULL) AS has_api_key FROM public.provider_accounts ORDER BY is_active DESC,name;"
echo '=== ACTIVE SERVICES WITHOUT ACTIVE MAPPING/ACCOUNT ==='
psql_run -c "SELECT s.id,s.name,s.provider_id,s.provider_service_id
 FROM public.services s WHERE s.is_active=true AND NOT EXISTS (
  SELECT 1 FROM public.service_provider_mapping m JOIN public.provider_accounts pa ON pa.id=m.provider_account_id
  WHERE m.service_id=s.id AND m.is_active=true AND pa.is_active=true
    AND nullif(btrim(pa.api_url),'') IS NOT NULL AND nullif(btrim(pa.api_key),'') IS NOT NULL)
 ORDER BY s.name;"

echo '=== RECENT UNDISPATCHED RUNS + STORED ERROR ==='
psql_run -c "SELECT r.id,r.status,r.scheduled_at,eoi.engagement_type,s.name AS service,
 left(coalesce(r.error_message,'NO ERROR RECORDED'),180) AS error
 FROM public.organic_run_schedule r
 LEFT JOIN public.engagement_order_items eoi ON eoi.id=r.engagement_order_item_id
 LEFT JOIN public.services s ON s.id=eoi.service_id
 WHERE r.provider_order_id IS NULL AND r.status IN ('pending','failed','started')
 ORDER BY r.created_at DESC LIMIT 30;"