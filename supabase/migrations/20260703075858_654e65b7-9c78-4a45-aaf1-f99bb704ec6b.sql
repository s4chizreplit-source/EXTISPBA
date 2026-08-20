-- Schedule instagram-poll every 10 minutes via pg_cron + pg_net
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'instagram-poll-every-10min') THEN
    PERFORM cron.unschedule('instagram-poll-every-10min');
  END IF;
END $$;

SELECT cron.schedule(
  'instagram-poll-every-10min',
  '*/10 * * * *',
  $cron$
  SELECT net.http_post(
    url := 'https://lvrbhgulxqdsamhdjzkw.supabase.co/functions/v1/instagram-poll',
    headers := jsonb_build_object(
      'Content-Type','application/json',
      'Authorization', 'Bearer ' || current_setting('app.settings.service_role_key', true)
    ),
    body := jsonb_build_object('trigger','cron')
  );
  $cron$
);