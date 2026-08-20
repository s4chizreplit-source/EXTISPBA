-- ====================================================
-- SUPABASE CRON JOB SETUP
-- ====================================================
-- Run this in your Supabase SQL Editor.
-- IMPORTANT: Replace [YOUR_PROJECT_ID] and [YOUR_SERVICE_ROLE_KEY] with your actual values.

-- 1. Enable extensions if not already enabled
CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net;

-- 2. Unschedule any existing jobs to avoid duplicates
SELECT cron.unschedule('organic-runs-minutely');
SELECT cron.unschedule('check-order-status-every-5-min');
SELECT cron.unschedule('sync-service-prices-every-12-hours');

-- 3. Schedule Organic Run Execution (Every minute)
SELECT cron.schedule('organic-runs-minutely', '* * * * *', $$ 
  SELECT net.http_post(
    url:='https://[YOUR_PROJECT_ID].supabase.co/functions/v1/execute-all-runs', 
    headers:='{"Content-Type": "application/json", "Authorization": "Bearer [YOUR_SERVICE_ROLE_KEY]", "apikey": "[YOUR_SERVICE_ROLE_KEY]"}'::jsonb, 
    body:='{}'::jsonb
  ) as request_id; 
$$);

-- 4. Schedule Order Status Check (Every 5 minutes)
SELECT cron.schedule('check-order-status-every-5-min', '*/5 * * * *', $$ 
  SELECT net.http_post(
    url:='https://[YOUR_PROJECT_ID].supabase.co/functions/v1/check-order-status', 
    headers:='{"Content-Type": "application/json", "Authorization": "Bearer [YOUR_SERVICE_ROLE_KEY]", "apikey": "[YOUR_SERVICE_ROLE_KEY]"}'::jsonb, 
    body:='{}'::jsonb
  ) as request_id; 
$$);

-- 5. Schedule Service Price Sync (Every 12 hours)
SELECT cron.schedule('sync-service-prices-every-12-hours', '0 */12 * * *', $$ 
  SELECT net.http_post(
    url:='https://[YOUR_PROJECT_ID].supabase.co/functions/v1/sync-service-prices', 
    headers:='{"Content-Type": "application/json", "Authorization": "Bearer [YOUR_SERVICE_ROLE_KEY]", "apikey": "[YOUR_SERVICE_ROLE_KEY]"}'::jsonb, 
    body:='{}'::jsonb
  ) as request_id; 
$$);
