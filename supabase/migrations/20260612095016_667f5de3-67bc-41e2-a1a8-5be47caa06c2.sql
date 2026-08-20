
-- 1. Re-create handle_new_user trigger on auth.users
DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

-- 2. Backfill profile / wallet / role for existing auth users that are missing them
INSERT INTO public.profiles (user_id, email, full_name)
SELECT u.id, u.email, COALESCE(u.raw_user_meta_data->>'full_name','')
FROM auth.users u
LEFT JOIN public.profiles p ON p.user_id = u.id
WHERE p.user_id IS NULL
ON CONFLICT (user_id) DO NOTHING;

INSERT INTO public.wallets (user_id, balance, total_deposited, total_spent)
SELECT u.id, 0, 0, 0
FROM auth.users u
LEFT JOIN public.wallets w ON w.user_id = u.id
WHERE w.user_id IS NULL
ON CONFLICT (user_id) DO NOTHING;

INSERT INTO public.user_roles (user_id, role)
SELECT u.id, 'user'::app_role
FROM auth.users u
LEFT JOIN public.user_roles ur ON ur.user_id = u.id
WHERE ur.user_id IS NULL
ON CONFLICT (user_id, role) DO NOTHING;

-- 3. Make xbhishekh@gmail.com an admin
INSERT INTO public.user_roles (user_id, role)
SELECT id, 'admin'::app_role FROM auth.users WHERE email='xbhishekh@gmail.com'
ON CONFLICT (user_id, role) DO NOTHING;

-- 4. Schedule cron jobs that call the edge functions
-- execute-organic-runs: every 1 minute
SELECT cron.schedule(
  'execute-organic-runs-every-minute',
  '* * * * *',
  $$
  SELECT net.http_post(
    url := 'https://lvrbhgulxqdsamhdjzkw.supabase.co/functions/v1/execute-organic-runs',
    headers := '{"Content-Type":"application/json","Authorization":"Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imx2cmJoZ3VseHFkc2FtaGRqemt3Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODEyNDYyNDIsImV4cCI6MjA5NjgyMjI0Mn0._I4OukQ6LlNmTxvPp2yvPat-jiYxOaCEZXGxRl9NqeM"}'::jsonb,
    body := '{}'::jsonb
  ) AS request_id;
  $$
);

-- check-order-status: every 5 minutes
SELECT cron.schedule(
  'check-order-status-every-5-min',
  '*/5 * * * *',
  $$
  SELECT net.http_post(
    url := 'https://lvrbhgulxqdsamhdjzkw.supabase.co/functions/v1/check-order-status',
    headers := '{"Content-Type":"application/json","Authorization":"Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imx2cmJoZ3VseHFkc2FtaGRqemt3Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODEyNDYyNDIsImV4cCI6MjA5NjgyMjI0Mn0._I4OukQ6LlNmTxvPp2yvPat-jiYxOaCEZXGxRl9NqeM"}'::jsonb,
    body := '{}'::jsonb
  ) AS request_id;
  $$
);

-- check-subscription-expiry: hourly
SELECT cron.schedule(
  'check-subscription-expiry-hourly',
  '0 * * * *',
  $$
  SELECT net.http_post(
    url := 'https://lvrbhgulxqdsamhdjzkw.supabase.co/functions/v1/check-subscription-expiry',
    headers := '{"Content-Type":"application/json","Authorization":"Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imx2cmJoZ3VseHFkc2FtaGRqemt3Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODEyNDYyNDIsImV4cCI6MjA5NjgyMjI0Mn0._I4OukQ6LlNmTxvPp2yvPat-jiYxOaCEZXGxRl9NqeM"}'::jsonb,
    body := '{}'::jsonb
  ) AS request_id;
  $$
);

-- cleanup_old_completed_engagement_orders: daily at 3 AM UTC (DB function, direct call)
SELECT cron.schedule(
  'cleanup-old-engagement-orders-daily',
  '0 3 * * *',
  $$ SELECT public.cleanup_old_completed_engagement_orders(); $$
);
