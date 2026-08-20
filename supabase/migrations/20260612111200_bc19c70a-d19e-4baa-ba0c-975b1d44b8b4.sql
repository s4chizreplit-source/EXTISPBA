
-- Auto-refill columns
ALTER TABLE public.engagement_order_items
  ADD COLUMN IF NOT EXISTS auto_refill_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS auto_refill_threshold_pct integer NOT NULL DEFAULT 10,
  ADD COLUMN IF NOT EXISTS auto_refill_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS auto_refill_max integer NOT NULL DEFAULT 3,
  ADD COLUMN IF NOT EXISTS last_refill_at timestamptz;

ALTER TABLE public.orders
  ADD COLUMN IF NOT EXISTS auto_refill_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS auto_refill_threshold_pct integer NOT NULL DEFAULT 10,
  ADD COLUMN IF NOT EXISTS auto_refill_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS auto_refill_max integer NOT NULL DEFAULT 3,
  ADD COLUMN IF NOT EXISTS last_refill_at timestamptz;

-- Drip-feed campaigns
CREATE TABLE IF NOT EXISTS public.drip_feed_campaigns (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  name text,
  link text NOT NULL,
  service_id uuid REFERENCES public.services(id) ON DELETE SET NULL,
  qty_per_run integer NOT NULL,
  interval_minutes integer NOT NULL DEFAULT 60,
  total_runs integer NOT NULL,
  runs_done integer NOT NULL DEFAULT 0,
  runs_failed integer NOT NULL DEFAULT 0,
  next_run_at timestamptz NOT NULL DEFAULT now(),
  is_active boolean NOT NULL DEFAULT true,
  last_order_id uuid,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.drip_feed_campaigns TO authenticated;
GRANT ALL ON public.drip_feed_campaigns TO service_role;
ALTER TABLE public.drip_feed_campaigns ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users manage own drip campaigns"
  ON public.drip_feed_campaigns FOR ALL
  TO authenticated
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Admins manage all drip campaigns"
  ON public.drip_feed_campaigns FOR ALL
  TO authenticated
  USING (public.has_role(auth.uid(), 'admin'))
  WITH CHECK (public.has_role(auth.uid(), 'admin'));

CREATE INDEX IF NOT EXISTS idx_drip_due
  ON public.drip_feed_campaigns (next_run_at)
  WHERE is_active = true;

CREATE INDEX IF NOT EXISTS idx_drip_user
  ON public.drip_feed_campaigns (user_id, created_at DESC);

-- Updated_at trigger
DROP TRIGGER IF EXISTS trg_drip_updated_at ON public.drip_feed_campaigns;
CREATE TRIGGER trg_drip_updated_at
  BEFORE UPDATE ON public.drip_feed_campaigns
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
