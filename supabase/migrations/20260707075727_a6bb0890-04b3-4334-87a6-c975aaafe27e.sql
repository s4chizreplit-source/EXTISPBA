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
  IF v_dep.user_id IS DISTINCT FROM p_user_id THEN
    RAISE EXCEPTION 'user mismatch for order %', p_order_id;
  END IF;

  v_expires := CASE p_plan
    WHEN 'monthly'  THEN now() + interval '30 days'
    WHEN 'yearly'   THEN now() + interval '365 days'
    WHEN 'lifetime' THEN now() + interval '100 years'
  END;

  INSERT INTO public.subscriptions (user_id, plan_type, status, expires_at, activated_at)
  VALUES (p_user_id, p_plan, 'active', v_expires, now())
  ON CONFLICT (user_id) DO UPDATE
    SET plan_type = EXCLUDED.plan_type,
        status = 'active',
        expires_at = EXCLUDED.expires_at,
        activated_at = now(),
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