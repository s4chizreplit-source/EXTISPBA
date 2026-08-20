CREATE OR REPLACE FUNCTION public.get_admin_dashboard_stats()
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  result JSON;
BEGIN
  IF NOT public.has_role(auth.uid(), 'admin') THEN
    RAISE EXCEPTION 'Unauthorized';
  END IF;

  SELECT json_build_object(
    'total_revenue', COALESCE((SELECT SUM(ABS(amount)) FROM public.transactions WHERE type IN ('order', 'order_payment') AND COALESCE(status, 'completed') = 'completed'), 0),
    'total_deposits', COALESCE((SELECT SUM(COALESCE(total_deposited, 0)) FROM public.wallets), 0),
    'total_wallet_balance', COALESCE((SELECT SUM(COALESCE(balance, 0)) FROM public.wallets), 0),
    'deposits_today', COALESCE((SELECT SUM(amount) FROM public.transactions WHERE type = 'deposit' AND amount > 0 AND COALESCE(status, 'completed') = 'completed' AND created_at >= date_trunc('day', now())), 0),
    'deposits_count', COALESCE((SELECT COUNT(*) FROM public.transactions WHERE type = 'deposit' AND amount > 0 AND COALESCE(status, 'completed') = 'completed'), 0),
    'total_orders', (SELECT COUNT(*) FROM public.orders) + (SELECT COUNT(*) FROM public.engagement_orders),
    'user_count', (SELECT COUNT(DISTINCT user_id) FROM public.profiles),
    'service_count', (SELECT COUNT(*) FROM public.services WHERE is_active = true),
    'markup', COALESCE((SELECT global_markup_percent FROM public.platform_settings LIMIT 1), 0),
    'maintenance_mode', COALESCE((SELECT maintenance_mode FROM public.platform_settings LIMIT 1), false)
  ) INTO result;

  RETURN result;
END;
$function$;

REVOKE ALL ON FUNCTION public.get_admin_dashboard_stats() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_admin_dashboard_stats() TO authenticated, service_role;