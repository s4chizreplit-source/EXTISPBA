CREATE TABLE IF NOT EXISTS public.apify_call_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  username text NOT NULL,
  scrape_type text NOT NULL,
  source text NOT NULL DEFAULT 'refresh',
  results_count integer,
  success boolean NOT NULL DEFAULT true,
  error_message text,
  duration_ms integer,
  created_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT ON public.apify_call_log TO authenticated;
GRANT ALL ON public.apify_call_log TO service_role;

ALTER TABLE public.apify_call_log ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users view own apify calls"
  ON public.apify_call_log FOR SELECT
  TO authenticated
  USING (auth.uid() = user_id OR public.has_role(auth.uid(), 'admin'));

CREATE INDEX IF NOT EXISTS apify_call_log_username_idx
  ON public.apify_call_log (lower(username), created_at DESC);
CREATE INDEX IF NOT EXISTS apify_call_log_user_idx
  ON public.apify_call_log (user_id, created_at DESC);