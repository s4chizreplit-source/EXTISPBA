
-- instagram_poll_state: add admin access
CREATE POLICY "Admins can view poll state"
  ON public.instagram_poll_state FOR SELECT
  TO authenticated
  USING (public.has_role(auth.uid(), 'admin'));

CREATE POLICY "Admins can manage poll state"
  ON public.instagram_poll_state FOR ALL
  TO authenticated
  USING (public.has_role(auth.uid(), 'admin'))
  WITH CHECK (public.has_role(auth.uid(), 'admin'));

-- platform_settings: allow public read (markup & maintenance are intentionally public)
DROP POLICY IF EXISTS "Anyone can read platform settings" ON public.platform_settings;
CREATE POLICY "Anyone can read platform settings"
  ON public.platform_settings FOR SELECT
  TO anon, authenticated
  USING (true);

GRANT SELECT ON public.platform_settings TO anon;
