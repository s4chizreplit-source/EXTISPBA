
-- ============ OxaPay Deposits Table ============
CREATE TABLE IF NOT EXISTS public.oxapay_deposits (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL,
  purpose TEXT NOT NULL DEFAULT 'wallet', -- 'wallet' | 'subscription'
  plan_type TEXT, -- 'monthly' | 'yearly' | 'lifetime' | null (for wallet)
  track_id TEXT UNIQUE, -- OxaPay track_id
  order_id TEXT UNIQUE NOT NULL, -- our internal order id passed to OxaPay
  pay_link TEXT,
  amount_usd NUMERIC(12,4) NOT NULL,
  amount_inr NUMERIC(12,2),
  status TEXT NOT NULL DEFAULT 'pending', -- pending, paid, expired, failed, credited
  credited BOOLEAN NOT NULL DEFAULT false,
  raw_response JSONB,
  webhook_payload JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE ON public.oxapay_deposits TO authenticated;
GRANT ALL ON public.oxapay_deposits TO service_role;

ALTER TABLE public.oxapay_deposits ENABLE ROW LEVEL SECURITY;

CREATE POLICY "oxapay_deposits_select_own_or_admin"
  ON public.oxapay_deposits FOR SELECT
  USING (auth.uid() = user_id OR public.has_role(auth.uid(), 'admin'));

CREATE POLICY "oxapay_deposits_insert_own"
  ON public.oxapay_deposits FOR INSERT
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "oxapay_deposits_admin_update"
  ON public.oxapay_deposits FOR UPDATE
  USING (public.has_role(auth.uid(), 'admin'));

CREATE INDEX IF NOT EXISTS idx_oxapay_deposits_user ON public.oxapay_deposits(user_id);
CREATE INDEX IF NOT EXISTS idx_oxapay_deposits_status ON public.oxapay_deposits(status);
CREATE INDEX IF NOT EXISTS idx_oxapay_deposits_track ON public.oxapay_deposits(track_id);

CREATE TRIGGER update_oxapay_deposits_updated_at
  BEFORE UPDATE ON public.oxapay_deposits
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- ============ Credit wallet via OxaPay (idempotent) ============
CREATE OR REPLACE FUNCTION public.credit_wallet_oxapay(
  p_user_id UUID,
  p_order_id TEXT,
  p_amount_usd NUMERIC,
  p_track_id TEXT
) RETURNS JSON
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_lock_key BIGINT;
  v_dep public.oxapay_deposits%ROWTYPE;
  v_balance NUMERIC;
  v_deposited NUMERIC;
  v_new_balance NUMERIC;
  v_credit_usd NUMERIC;
BEGIN
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
$$;

-- ============ Activate subscription via OxaPay ============
CREATE OR REPLACE FUNCTION public.activate_subscription_oxapay(
  p_user_id UUID,
  p_order_id TEXT,
  p_plan TEXT,
  p_amount_usd NUMERIC,
  p_track_id TEXT
) RETURNS JSON
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_lock_key BIGINT;
  v_dep public.oxapay_deposits%ROWTYPE;
  v_expires TIMESTAMPTZ;
BEGIN
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
$$;

-- ============ Expire subscriptions cron helper ============
CREATE OR REPLACE FUNCTION public.expire_subscriptions()
RETURNS INTEGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE v_count INTEGER;
BEGIN
  WITH upd AS (
    UPDATE public.subscriptions
    SET status = 'expired', updated_at = now()
    WHERE status = 'active'
      AND expires_at IS NOT NULL
      AND expires_at < now()
    RETURNING 1
  )
  SELECT count(*) INTO v_count FROM upd;
  RETURN v_count;
END;
$$;
