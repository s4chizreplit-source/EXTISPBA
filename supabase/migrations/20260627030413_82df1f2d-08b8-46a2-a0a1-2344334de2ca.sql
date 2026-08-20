
-- Shared CTE logic is duplicated for clarity inside each RPC.

CREATE OR REPLACE FUNCTION public.get_provider_topup_plan()
RETURNS TABLE (
  provider_account_id uuid,
  provider_id text,
  provider_name text,
  pending_runs bigint,
  pending_user_usd numeric,
  markup_percent numeric
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT public.has_role(auth.uid(), 'admin') THEN
    RAISE EXCEPTION 'Unauthorized';
  END IF;

  RETURN QUERY
  WITH pending_units AS (
    -- Engagement runs
    SELECT
      eoi.service_id,
      rs.quantity_to_send::numeric AS qty,
      s.price                       AS price_per_k
    FROM public.organic_run_schedule rs
    JOIN public.engagement_order_items eoi ON eoi.id = rs.engagement_order_item_id
    JOIN public.services s ON s.id = eoi.service_id
    WHERE rs.status = 'pending'

    UNION ALL

    -- Order runs
    SELECT
      o.service_id,
      rs.quantity_to_send::numeric AS qty,
      s.price                       AS price_per_k
    FROM public.organic_run_schedule rs
    JOIN public.orders o ON o.id = rs.order_id
    JOIN public.services s ON s.id = o.service_id
    WHERE rs.status = 'pending'

    UNION ALL

    -- Plain orders (no run schedule rows)
    SELECT
      o.service_id,
      o.quantity::numeric AS qty,
      s.price             AS price_per_k
    FROM public.orders o
    JOIN public.services s ON s.id = o.service_id
    WHERE o.status IN ('pending','processing')
      AND NOT EXISTS (
        SELECT 1 FROM public.organic_run_schedule rs2 WHERE rs2.order_id = o.id
      )
  ),
  service_provider_split AS (
    SELECT
      pu.service_id,
      pu.qty,
      pu.price_per_k,
      pa.id                              AS provider_account_id,
      pa.provider_id                     AS provider_id,
      pa.name                            AS provider_name,
      1.0 / NULLIF(cnt.n, 0)::numeric    AS share
    FROM pending_units pu
    JOIN LATERAL (
      -- Try active mappings first
      SELECT m.provider_account_id
      FROM public.service_provider_mapping m
      WHERE m.service_id = pu.service_id
        AND m.is_active = true
      UNION
      -- Fallback: services.provider_id → any active provider_account
      SELECT pa2.id
      FROM public.services s2
      JOIN public.provider_accounts pa2
        ON pa2.provider_id = s2.provider_id
       AND pa2.is_active = true
      WHERE s2.id = pu.service_id
        AND NOT EXISTS (
          SELECT 1 FROM public.service_provider_mapping m2
          WHERE m2.service_id = pu.service_id AND m2.is_active = true
        )
    ) pas ON true
    JOIN public.provider_accounts pa ON pa.id = pas.provider_account_id
    JOIN LATERAL (
      SELECT count(*)::int AS n FROM (
        SELECT m.provider_account_id
        FROM public.service_provider_mapping m
        WHERE m.service_id = pu.service_id AND m.is_active = true
        UNION
        SELECT pa3.id
        FROM public.services s3
        JOIN public.provider_accounts pa3
          ON pa3.provider_id = s3.provider_id
         AND pa3.is_active = true
        WHERE s3.id = pu.service_id
          AND NOT EXISTS (
            SELECT 1 FROM public.service_provider_mapping m3
            WHERE m3.service_id = pu.service_id AND m3.is_active = true
          )
      ) inner_pas
    ) cnt ON true
  )
  SELECT
    sps.provider_account_id,
    sps.provider_id,
    sps.provider_name,
    count(*)::bigint                                                          AS pending_runs,
    COALESCE(SUM((sps.qty / 1000.0) * sps.price_per_k * sps.share), 0)::numeric AS pending_user_usd,
    COALESCE((SELECT global_markup_percent FROM public.platform_settings LIMIT 1), 0)::numeric AS markup_percent
  FROM service_provider_split sps
  GROUP BY sps.provider_account_id, sps.provider_id, sps.provider_name
  HAVING count(*) > 0
  ORDER BY pending_user_usd DESC;
END;
$$;

CREATE OR REPLACE FUNCTION public.get_provider_topup_breakdown()
RETURNS TABLE (
  provider_account_id uuid,
  provider_id text,
  provider_name text,
  service_id uuid,
  service_name text,
  service_category text,
  pending_runs bigint,
  pending_quantity bigint,
  pending_user_usd numeric
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT public.has_role(auth.uid(), 'admin') THEN
    RAISE EXCEPTION 'Unauthorized';
  END IF;

  RETURN QUERY
  WITH pending_units AS (
    SELECT eoi.service_id, rs.quantity_to_send::numeric AS qty, s.price AS price_per_k
    FROM public.organic_run_schedule rs
    JOIN public.engagement_order_items eoi ON eoi.id = rs.engagement_order_item_id
    JOIN public.services s ON s.id = eoi.service_id
    WHERE rs.status = 'pending'
    UNION ALL
    SELECT o.service_id, rs.quantity_to_send::numeric AS qty, s.price AS price_per_k
    FROM public.organic_run_schedule rs
    JOIN public.orders o ON o.id = rs.order_id
    JOIN public.services s ON s.id = o.service_id
    WHERE rs.status = 'pending'
    UNION ALL
    SELECT o.service_id, o.quantity::numeric AS qty, s.price AS price_per_k
    FROM public.orders o
    JOIN public.services s ON s.id = o.service_id
    WHERE o.status IN ('pending','processing')
      AND NOT EXISTS (SELECT 1 FROM public.organic_run_schedule rs2 WHERE rs2.order_id = o.id)
  ),
  split AS (
    SELECT
      pu.service_id,
      pu.qty,
      pu.price_per_k,
      pa.id          AS provider_account_id,
      pa.provider_id AS provider_id,
      pa.name        AS provider_name,
      1.0 / NULLIF(cnt.n, 0)::numeric AS share
    FROM pending_units pu
    JOIN LATERAL (
      SELECT m.provider_account_id
      FROM public.service_provider_mapping m
      WHERE m.service_id = pu.service_id AND m.is_active = true
      UNION
      SELECT pa2.id
      FROM public.services s2
      JOIN public.provider_accounts pa2
        ON pa2.provider_id = s2.provider_id AND pa2.is_active = true
      WHERE s2.id = pu.service_id
        AND NOT EXISTS (
          SELECT 1 FROM public.service_provider_mapping m2
          WHERE m2.service_id = pu.service_id AND m2.is_active = true
        )
    ) pas ON true
    JOIN public.provider_accounts pa ON pa.id = pas.provider_account_id
    JOIN LATERAL (
      SELECT count(*)::int AS n FROM (
        SELECT m.provider_account_id
        FROM public.service_provider_mapping m
        WHERE m.service_id = pu.service_id AND m.is_active = true
        UNION
        SELECT pa3.id
        FROM public.services s3
        JOIN public.provider_accounts pa3
          ON pa3.provider_id = s3.provider_id AND pa3.is_active = true
        WHERE s3.id = pu.service_id
          AND NOT EXISTS (
            SELECT 1 FROM public.service_provider_mapping m3
            WHERE m3.service_id = pu.service_id AND m3.is_active = true
          )
      ) inner_pas
    ) cnt ON true
  )
  SELECT
    sp.provider_account_id,
    sp.provider_id,
    sp.provider_name,
    sp.service_id,
    s.name                                                                  AS service_name,
    s.category                                                              AS service_category,
    count(*)::bigint                                                        AS pending_runs,
    COALESCE(SUM(sp.qty * sp.share), 0)::bigint                             AS pending_quantity,
    COALESCE(SUM((sp.qty / 1000.0) * sp.price_per_k * sp.share), 0)::numeric AS pending_user_usd
  FROM split sp
  JOIN public.services s ON s.id = sp.service_id
  GROUP BY sp.provider_account_id, sp.provider_id, sp.provider_name, sp.service_id, s.name, s.category
  HAVING count(*) > 0
  ORDER BY sp.provider_account_id, pending_user_usd DESC;
END;
$$;

-- Lock down execution: admins call via authenticated session (function self-gates with has_role)
REVOKE ALL ON FUNCTION public.get_provider_topup_plan() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_provider_topup_plan() FROM anon;
GRANT EXECUTE ON FUNCTION public.get_provider_topup_plan() TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.get_provider_topup_breakdown() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_provider_topup_breakdown() FROM anon;
GRANT EXECUTE ON FUNCTION public.get_provider_topup_breakdown() TO authenticated, service_role;

-- Add organic_run_schedule to realtime publication (idempotent)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'organic_run_schedule'
  ) THEN
    EXECUTE 'ALTER PUBLICATION supabase_realtime ADD TABLE public.organic_run_schedule';
  END IF;
END $$;
