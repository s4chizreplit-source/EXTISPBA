
CREATE TABLE public.instagram_link_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  username text NOT NULL,
  event_type text NOT NULL DEFAULT 'link' CHECK (event_type IN ('link','cache_hit')),
  created_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT ON public.instagram_link_events TO authenticated;
GRANT ALL ON public.instagram_link_events TO service_role;

ALTER TABLE public.instagram_link_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users view own link events"
  ON public.instagram_link_events
  FOR SELECT
  TO authenticated
  USING (auth.uid() = user_id);

CREATE POLICY "Admins view all link events"
  ON public.instagram_link_events
  FOR SELECT
  TO authenticated
  USING (public.has_role(auth.uid(), 'admin'));

CREATE INDEX idx_ig_link_events_user_time
  ON public.instagram_link_events (user_id, created_at DESC);

-- Backfill existing accounts as historical link events so the 30-day window
-- reflects reality immediately after this migration.
INSERT INTO public.instagram_link_events (user_id, username, event_type, created_at)
SELECT user_id, username, 'link', created_at
FROM public.instagram_accounts;
