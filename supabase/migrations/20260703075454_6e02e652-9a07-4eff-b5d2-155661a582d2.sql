
UPDATE public.engagement_bundles SET is_active = true, sort_order = COALESCE(sort_order, 1)
WHERE platform = 'instagram';

INSERT INTO public.services (name, category, price, min_quantity, max_quantity, is_active, provider_id, provider_service_id)
SELECT 'Instagram Comments [Custom/Random]', 'Instagram Comments', 1.5, 10, 10000, true, 'chpst', 'ig-comments-manual'
WHERE NOT EXISTS (SELECT 1 FROM public.services WHERE category = 'Instagram Comments' AND is_active = true);

INSERT INTO public.bundle_items (bundle_id, engagement_type, service_id, price_per_k)
SELECT eb.id, 'comments', s.id, s.price
FROM public.engagement_bundles eb
JOIN public.services s ON s.category = 'Instagram Comments' AND s.is_active = true
WHERE eb.platform = 'instagram'
  AND NOT EXISTS (SELECT 1 FROM public.bundle_items bi WHERE bi.bundle_id = eb.id AND bi.engagement_type = 'comments');

UPDATE public.bundle_items bi
SET price_per_k = s.price
FROM public.services s
WHERE bi.service_id = s.id AND bi.price_per_k IS NULL;

CREATE TABLE IF NOT EXISTS public.engagement_presets (
  user_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  views int NOT NULL DEFAULT 0,
  likes int NOT NULL DEFAULT 0,
  comments int NOT NULL DEFAULT 0,
  drip_minutes int NOT NULL DEFAULT 0,
  mode text NOT NULL DEFAULT 'manual' CHECK (mode IN ('auto','manual')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.engagement_presets TO authenticated;
GRANT ALL ON public.engagement_presets TO service_role;
ALTER TABLE public.engagement_presets ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "own preset" ON public.engagement_presets;
CREATE POLICY "own preset" ON public.engagement_presets FOR ALL TO authenticated
  USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
DROP TRIGGER IF EXISTS trg_presets_updated_at ON public.engagement_presets;
CREATE TRIGGER trg_presets_updated_at BEFORE UPDATE ON public.engagement_presets
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE TABLE IF NOT EXISTS public.instagram_poll_state (
  account_id uuid PRIMARY KEY REFERENCES public.instagram_accounts(id) ON DELETE CASCADE,
  last_seen_media_id text,
  last_polled_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT ON public.instagram_poll_state TO authenticated;
GRANT ALL ON public.instagram_poll_state TO service_role;
ALTER TABLE public.instagram_poll_state ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "read own poll state" ON public.instagram_poll_state;
CREATE POLICY "read own poll state" ON public.instagram_poll_state FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.instagram_accounts a WHERE a.id = account_id AND a.user_id = auth.uid()));
