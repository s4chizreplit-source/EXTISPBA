
-- engagement_health_history: replace universal restrictive gate with owner/admin-scoped one
DROP POLICY IF EXISTS "Deny anonymous access to engagement_health_history" ON public.engagement_health_history;

CREATE POLICY "Restrict engagement health history to owner or admin"
ON public.engagement_health_history
AS RESTRICTIVE
FOR SELECT
TO public
USING (
  auth.uid() IS NOT NULL
  AND (
    public.has_role(auth.uid(), 'admin'::app_role)
    OR EXISTS (
      SELECT 1 FROM public.engagement_orders eo
      WHERE eo.id = engagement_health_history.engagement_order_id
        AND eo.user_id = auth.uid()
    )
  )
);

-- platform_settings: drop redundant admin-only SELECT policy (public read + admin ALL cover it)
DROP POLICY IF EXISTS "Admins read platform settings" ON public.platform_settings;
