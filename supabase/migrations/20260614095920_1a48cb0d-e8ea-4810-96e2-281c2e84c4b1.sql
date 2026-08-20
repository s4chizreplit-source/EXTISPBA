
-- 1) BATCHES
CREATE TABLE public.mass_order_batches (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  name TEXT,
  platform TEXT,
  total_count INTEGER NOT NULL DEFAULT 0,
  success_count INTEGER NOT NULL DEFAULT 0,
  failed_count INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'processing',
  total_price NUMERIC NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.mass_order_batches TO authenticated;
GRANT ALL ON public.mass_order_batches TO service_role;

ALTER TABLE public.mass_order_batches ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users manage their own batches"
ON public.mass_order_batches FOR ALL
TO authenticated
USING (auth.uid() = user_id OR public.has_role(auth.uid(), 'admin'))
WITH CHECK (auth.uid() = user_id OR public.has_role(auth.uid(), 'admin'));

CREATE INDEX idx_mass_order_batches_user ON public.mass_order_batches(user_id, created_at DESC);

CREATE TRIGGER update_mass_order_batches_updated_at
BEFORE UPDATE ON public.mass_order_batches
FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- 2) BATCH ITEMS
CREATE TABLE public.mass_order_batch_items (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  batch_id UUID NOT NULL REFERENCES public.mass_order_batches(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  link TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  error_message TEXT,
  engagement_order_id UUID,
  engagement_order_number BIGINT,
  price NUMERIC NOT NULL DEFAULT 0,
  payload JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.mass_order_batch_items TO authenticated;
GRANT ALL ON public.mass_order_batch_items TO service_role;

ALTER TABLE public.mass_order_batch_items ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users manage their own batch items"
ON public.mass_order_batch_items FOR ALL
TO authenticated
USING (auth.uid() = user_id OR public.has_role(auth.uid(), 'admin'))
WITH CHECK (auth.uid() = user_id OR public.has_role(auth.uid(), 'admin'));

CREATE INDEX idx_mass_order_batch_items_batch ON public.mass_order_batch_items(batch_id);
CREATE INDEX idx_mass_order_batch_items_user ON public.mass_order_batch_items(user_id);

CREATE TRIGGER update_mass_order_batch_items_updated_at
BEFORE UPDATE ON public.mass_order_batch_items
FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
