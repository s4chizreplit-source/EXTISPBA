
-- 1) Lock down SECURITY DEFINER functions: revoke EXECUTE from anon/authenticated/public on sensitive ones
REVOKE EXECUTE ON FUNCTION public.credit_wallet_razorpay(uuid, text, numeric, numeric) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.cleanup_old_completed_engagement_orders() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.pg_advisory_xact_lock(bigint) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.handle_new_user() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.create_user_subscription() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.update_conversation_last_message() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.update_updated_at_column() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.set_engagement_order_completed_at() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.organic_run_schedule_lock_user_columns() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.get_admin_dashboard_stats() FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.get_admin_users_summary() FROM PUBLIC, anon;

-- Keep these callable (intentionally exposed / used by app):
-- has_role, get_user_role, get_public_markup, is_maintenance_mode, reschedule_organic_run,
-- get_admin_dashboard_stats (authenticated, internal auth check),
-- get_admin_users_summary (authenticated, internal auth check)

-- 2) Defensive RESTRICTIVE policy on user_roles: any mutation must satisfy admin check
CREATE POLICY "Restrict user_roles mutations to admins"
ON public.user_roles AS RESTRICTIVE
FOR ALL TO authenticated
USING (public.has_role(auth.uid(), 'admin'::app_role))
WITH CHECK (public.has_role(auth.uid(), 'admin'::app_role));

-- 3) Defensive RESTRICTIVE policy on providers + provider_accounts: admin-only
CREATE POLICY "Restrict providers to admins"
ON public.providers AS RESTRICTIVE
FOR ALL TO authenticated, anon
USING (public.has_role(auth.uid(), 'admin'::app_role))
WITH CHECK (public.has_role(auth.uid(), 'admin'::app_role));

CREATE POLICY "Restrict provider_accounts to admins"
ON public.provider_accounts AS RESTRICTIVE
FOR ALL TO authenticated, anon
USING (public.has_role(auth.uid(), 'admin'::app_role))
WITH CHECK (public.has_role(auth.uid(), 'admin'::app_role));

-- 4) Force balance_after to NULL on user-inserted deposit transactions
DROP POLICY IF EXISTS "Users create own deposit transactions" ON public.transactions;
CREATE POLICY "Users create own deposit transactions"
ON public.transactions
FOR INSERT TO authenticated
WITH CHECK (
  auth.uid() = user_id
  AND type = 'deposit'
  AND status = 'pending'
  AND amount IS NOT NULL
  AND amount > 0
  AND amount <= 1000
  AND balance_after IS NULL
  AND payment_method = ANY (ARRAY['upi','manual','bank_transfer'])
);
