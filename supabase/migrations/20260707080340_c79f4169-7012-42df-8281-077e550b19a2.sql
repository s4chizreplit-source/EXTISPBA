DROP INDEX IF EXISTS public.webhook_events_provider_track_uniq;
CREATE UNIQUE INDEX webhook_events_provider_track_status_uniq
  ON public.webhook_events (provider, track_id, event_status)
  WHERE track_id IS NOT NULL;