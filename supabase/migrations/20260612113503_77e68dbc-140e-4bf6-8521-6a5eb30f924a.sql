
ALTER TABLE public.engagement_orders
  ADD COLUMN IF NOT EXISTS current_botting_percent numeric DEFAULT 0,
  ADD COLUMN IF NOT EXISTS current_health_score numeric DEFAULT 100,
  ADD COLUMN IF NOT EXISTS last_health_check_at timestamptz;

CREATE TABLE IF NOT EXISTS public.engagement_health_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  engagement_order_id uuid NOT NULL REFERENCES public.engagement_orders(id) ON DELETE CASCADE,
  health_score numeric NOT NULL DEFAULT 0,
  botting_percent numeric NOT NULL DEFAULT 0,
  views_count integer NOT NULL DEFAULT 0,
  likes_count integer NOT NULL DEFAULT 0,
  comments_count integer NOT NULL DEFAULT 0,
  shares_count integer NOT NULL DEFAULT 0,
  saves_count integer NOT NULL DEFAULT 0,
  followers_count integer NOT NULL DEFAULT 0,
  ratios jsonb,
  warnings jsonb,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.engagement_health_history TO authenticated;
GRANT ALL ON public.engagement_health_history TO service_role;

ALTER TABLE public.engagement_health_history ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users view own engagement health history"
ON public.engagement_health_history FOR SELECT TO authenticated
USING (
  EXISTS (
    SELECT 1 FROM public.engagement_orders eo
    WHERE eo.id = engagement_health_history.engagement_order_id
      AND (eo.user_id = auth.uid() OR public.has_role(auth.uid(), 'admin'))
  )
);

CREATE POLICY "Users insert own engagement health history"
ON public.engagement_health_history FOR INSERT TO authenticated
WITH CHECK (
  EXISTS (
    SELECT 1 FROM public.engagement_orders eo
    WHERE eo.id = engagement_health_history.engagement_order_id
      AND eo.user_id = auth.uid()
  )
);

CREATE POLICY "Admins manage engagement health history"
ON public.engagement_health_history FOR ALL TO authenticated
USING (public.has_role(auth.uid(), 'admin'))
WITH CHECK (public.has_role(auth.uid(), 'admin'));

CREATE POLICY "Deny anonymous access to engagement_health_history"
ON public.engagement_health_history AS RESTRICTIVE FOR SELECT TO public
USING (auth.uid() IS NOT NULL);

CREATE INDEX IF NOT EXISTS idx_engagement_health_history_order
  ON public.engagement_health_history(engagement_order_id, recorded_at DESC);
