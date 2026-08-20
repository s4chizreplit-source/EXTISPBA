ALTER TABLE public.bundle_items
  ADD COLUMN IF NOT EXISTS price_per_k numeric(12,4);

COMMENT ON COLUMN public.bundle_items.price_per_k IS
  'Admin-set USD per 1000 for this bundle engagement type. Overrides services.price for orders placed via this bundle. NULL = fall back to linked service price.';