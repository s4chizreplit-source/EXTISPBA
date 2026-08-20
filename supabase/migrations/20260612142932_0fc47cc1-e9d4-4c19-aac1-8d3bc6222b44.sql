ALTER PUBLICATION supabase_realtime ADD TABLE public.engagement_bundles;
ALTER PUBLICATION supabase_realtime ADD TABLE public.bundle_items;
ALTER PUBLICATION supabase_realtime ADD TABLE public.services;
ALTER TABLE public.engagement_bundles REPLICA IDENTITY FULL;
ALTER TABLE public.bundle_items REPLICA IDENTITY FULL;
ALTER TABLE public.services REPLICA IDENTITY FULL;