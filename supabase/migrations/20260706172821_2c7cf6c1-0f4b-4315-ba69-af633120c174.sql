
-- 1. Revoke direct execute from anon/authenticated on payment-crediting RPCs
REVOKE EXECUTE ON FUNCTION public.activate_subscription_oxapay(uuid, text, text, numeric, text) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.credit_wallet_oxapay(uuid, text, numeric, text) FROM PUBLIC, anon, authenticated;

-- 2. Defense in depth: refuse if any user session is attached (only service_role has auth.uid() = NULL)
CREATE OR REPLACE FUNCTION public.activate_subscription_oxapay(p_user_id uuid, p_order_id text, p_plan text, p_amount_usd numeric, p_track_id text)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_lock_key BIGINT;
  v_dep public.oxapay_deposits%ROWTYPE;
  v_expires TIMESTAMPTZ;
BEGIN
  -- Backend-only guard: reject any call that carries an end-user session
  IF auth.uid() IS NOT NULL THEN
    RAISE EXCEPTION 'Not permitted';
  END IF;

  IF p_user_id IS NULL OR p_order_id IS NULL OR p_plan IS NULL THEN
    RAISE EXCEPTION 'missing required inputs';
  END IF;
  IF p_plan NOT IN ('monthly','yearly','lifetime') THEN
    RAISE EXCEPTION 'invalid plan %', p_plan;
  END IF;

  v_lock_key := abs(hashtextextended('oxapay-sub:' || p_order_id, 0));
  PERFORM pg_advisory_xact_lock(v_lock_key);

  SELECT * INTO v_dep FROM public.oxapay_deposits
    WHERE order_id = p_order_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'deposit not found for order %', p_order_id;
  END IF;
  IF v_dep.credited THEN
    RETURN json_build_object('activated', false, 'duplicate', true);
  END IF;
  -- Extra safety: the deposit row's user_id must match caller-supplied user_id
  IF v_dep.user_id IS DISTINCT FROM p_user_id THEN
    RAISE EXCEPTION 'user mismatch for order %', p_order_id;
  END IF;

  v_expires := CASE p_plan
    WHEN 'monthly'  THEN now() + interval '30 days'
    WHEN 'yearly'   THEN now() + interval '365 days'
    WHEN 'lifetime' THEN now() + interval '100 years'
  END;

  INSERT INTO public.subscriptions (user_id, plan_type, status, expires_at, started_at)
  VALUES (p_user_id, p_plan, 'active', v_expires, now())
  ON CONFLICT (user_id) DO UPDATE
    SET plan_type = EXCLUDED.plan_type,
        status = 'active',
        expires_at = EXCLUDED.expires_at,
        started_at = now(),
        updated_at = now();

  INSERT INTO public.transactions (
    user_id, type, amount, balance_after, status,
    payment_method, payment_reference, description
  )
  SELECT p_user_id, 'subscription', -p_amount_usd,
         COALESCE((SELECT balance FROM public.wallets WHERE user_id = p_user_id), 0),
         'completed', 'oxapay', p_order_id,
         'Subscription payment (' || p_plan || ') via OxaPay';

  UPDATE public.oxapay_deposits
    SET credited = true, status = 'credited',
        track_id = COALESCE(p_track_id, track_id),
        plan_type = p_plan
    WHERE order_id = p_order_id;

  RETURN json_build_object('activated', true, 'plan', p_plan, 'expires_at', v_expires);
END;
$function$;

CREATE OR REPLACE FUNCTION public.credit_wallet_oxapay(p_user_id uuid, p_order_id text, p_amount_usd numeric, p_track_id text)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_lock_key BIGINT;
  v_dep public.oxapay_deposits%ROWTYPE;
  v_balance NUMERIC;
  v_deposited NUMERIC;
  v_new_balance NUMERIC;
  v_credit_usd NUMERIC;
BEGIN
  IF auth.uid() IS NOT NULL THEN
    RAISE EXCEPTION 'Not permitted';
  END IF;

  IF p_user_id IS NULL OR p_order_id IS NULL THEN
    RAISE EXCEPTION 'user_id and order_id required';
  END IF;
  IF p_amount_usd IS NULL OR p_amount_usd <= 0 THEN
    RAISE EXCEPTION 'amount_usd must be > 0';
  END IF;

  v_credit_usd := trunc(p_amount_usd::numeric, 4);
  v_lock_key := abs(hashtextextended('oxapay:' || p_order_id, 0));
  PERFORM pg_advisory_xact_lock(v_lock_key);

  SELECT * INTO v_dep FROM public.oxapay_deposits
    WHERE order_id = p_order_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'deposit not found for order %', p_order_id;
  END IF;
  IF v_dep.user_id IS DISTINCT FROM p_user_id THEN
    RAISE EXCEPTION 'user mismatch for order %', p_order_id;
  END IF;

  IF v_dep.credited THEN
    SELECT balance INTO v_balance FROM public.wallets WHERE user_id = p_user_id;
    RETURN json_build_object('credited', false, 'duplicate', true, 'new_balance', COALESCE(v_balance, 0));
  END IF;

  INSERT INTO public.wallets (user_id, balance, total_deposited, total_spent)
    VALUES (p_user_id, 0, 0, 0)
    ON CONFLICT (user_id) DO NOTHING;

  SELECT balance, total_deposited INTO v_balance, v_deposited
    FROM public.wallets WHERE user_id = p_user_id FOR UPDATE;

  v_new_balance := trunc(COALESCE(v_balance, 0) + v_credit_usd, 4);

  UPDATE public.wallets
    SET balance = v_new_balance,
        total_deposited = trunc(COALESCE(v_deposited, 0) + v_credit_usd, 4)
    WHERE user_id = p_user_id;

  INSERT INTO public.transactions (
    user_id, type, amount, balance_after, status,
    payment_method, payment_reference, description
  ) VALUES (
    p_user_id, 'deposit', v_credit_usd, v_new_balance, 'completed',
    'oxapay', p_order_id,
    'Wallet top-up via OxaPay (crypto)'
  );

  UPDATE public.oxapay_deposits
    SET credited = true, status = 'credited',
        track_id = COALESCE(p_track_id, track_id)
    WHERE order_id = p_order_id;

  RETURN json_build_object('credited', true, 'duplicate', false, 'new_balance', v_new_balance, 'credited_usd', v_credit_usd);
END;
$function$;

-- Re-revoke after replacement (CREATE OR REPLACE preserves grants, but be explicit)
REVOKE EXECUTE ON FUNCTION public.activate_subscription_oxapay(uuid, text, text, numeric, text) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.credit_wallet_oxapay(uuid, text, numeric, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.activate_subscription_oxapay(uuid, text, text, numeric, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.credit_wallet_oxapay(uuid, text, numeric, text) TO service_role;

-- 3. Remove user-facing INSERT policies on deposit tables (only edge functions with service_role should create)
DROP POLICY IF EXISTS "oxapay_deposits_insert_own" ON public.oxapay_deposits;
DROP POLICY IF EXISTS "Users insert own zapupi deposits" ON public.zapupi_deposits;
DROP POLICY IF EXISTS "Users insert own deposits" ON public.deposits;
