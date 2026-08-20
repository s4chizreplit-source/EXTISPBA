-- Tighten EXECUTE on SECURITY DEFINER functions to prevent anon callers
DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT n.nspname, p.proname, pg_get_function_identity_arguments(p.oid) AS args
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.prosecdef = true
  LOOP
    EXECUTE format('REVOKE EXECUTE ON FUNCTION public.%I(%s) FROM PUBLIC, anon', r.proname, r.args);
  END LOOP;
END $$;

-- Re-grant to authenticated only the user-callable RPCs
GRANT EXECUTE ON FUNCTION public.redeem_promo_code(text, numeric) TO authenticated;
GRANT EXECUTE ON FUNCTION public.set_referrer_by_code(text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.reschedule_organic_run(uuid, integer, timestamp with time zone) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_admin_dashboard_stats() TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_admin_users_summary() TO authenticated;
GRANT EXECUTE ON FUNCTION public.has_role(uuid, app_role) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_user_role(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_user_tier(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_public_markup() TO authenticated;
GRANT EXECUTE ON FUNCTION public.is_maintenance_mode() TO authenticated, anon;