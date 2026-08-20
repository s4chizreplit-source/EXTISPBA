
-- 1) zapupi_deposits table
CREATE TABLE public.zapupi_deposits (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  order_id text NOT NULL UNIQUE,
  amount_inr numeric NOT NULL,
  amount_usd numeric,
  status text NOT NULL DEFAULT 'pending',
  credited boolean NOT NULL DEFAULT false,
  txn_id text,
  utr text,
  payment_url text,
  raw_response jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT ON public.zapupi_deposits TO authenticated;
GRANT ALL ON public.zapupi_deposits TO service_role;

ALTER TABLE public.zapupi_deposits ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users view own zapupi deposits"
  ON public.zapupi_deposits
  FOR SELECT TO authenticated
  USING (auth.uid() = user_id);

CREATE TRIGGER update_zapupi_deposits_updated_at
  BEFORE UPDATE ON public.zapupi_deposits
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE INDEX zapupi_deposits_user_idx
  ON public.zapupi_deposits(user_id, created_at DESC);
CREATE INDEX zapupi_deposits_pending_idx
  ON public.zapupi_deposits(status) WHERE status = 'pending';

-- 2) credit_wallet_zapupi (idempotent, SECURITY DEFINER, service-role only)
CREATE OR REPLACE FUNCTION public.credit_wallet_zapupi(
  p_user_id uuid,
  p_order_id text,
  p_amount_usd numeric,
  p_amount_inr numeric,
  p_txn_id text,
  p_utr text
) RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_lock_key bigint;
  v_dep public.zapupi_deposits%ROWTYPE;
  v_balance numeric;
  v_deposited numeric;
  v_new_balance numeric;
  v_credit_usd numeric;
  v_amount_inr numeric;
  v_rate numeric := 83.5;
BEGIN
  IF p_user_id IS NULL OR p_order_id IS NULL THEN
    RAISE EXCEPTION 'user_id and order_id required';
  END IF;
  IF p_amount_inr IS NULL OR p_amount_inr <= 0 THEN
    RAISE EXCEPTION 'amount_inr must be > 0';
  END IF;

  v_amount_inr := trunc(p_amount_inr::numeric, 2);
  v_credit_usd := COALESCE(
    NULLIF(trunc(p_amount_usd::numeric, 4), 0),
    trunc((v_amount_inr / v_rate)::numeric, 4)
  );
  IF v_credit_usd <= 0 THEN
    RAISE EXCEPTION 'invalid credit amount';
  END IF;

  v_lock_key := abs(hashtextextended(p_order_id, 0));
  PERFORM pg_advisory_xact_lock(v_lock_key);

  SELECT * INTO v_dep FROM public.zapupi_deposits
    WHERE order_id = p_order_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'deposit not found for order %', p_order_id;
  END IF;

  IF v_dep.credited THEN
    SELECT balance INTO v_balance FROM public.wallets WHERE user_id = p_user_id;
    RETURN json_build_object(
      'credited', false,
      'duplicate', true,
      'new_balance', COALESCE(v_balance, 0)
    );
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
    'zapupi', p_order_id,
    'Wallet top-up via ZapUPI (INR ' || trim(to_char(v_amount_inr, 'FM9999999990D00')) || ')'
  );

  UPDATE public.zapupi_deposits
    SET credited = true,
        status = 'success',
        txn_id = COALESCE(p_txn_id, txn_id),
        utr = COALESCE(p_utr, utr),
        amount_usd = v_credit_usd
    WHERE order_id = p_order_id;

  RETURN json_build_object(
    'credited', true,
    'duplicate', false,
    'new_balance', v_new_balance,
    'credited_usd', v_credit_usd,
    'credited_inr', v_amount_inr
  );
END;
$$;

-- 3) Lock down wallet-money functions — service_role only
REVOKE EXECUTE ON FUNCTION public.credit_wallet_zapupi(uuid,text,numeric,numeric,text,text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.credit_wallet_zapupi(uuid,text,numeric,numeric,text,text) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.credit_wallet_zapupi(uuid,text,numeric,numeric,text,text) TO service_role;

REVOKE EXECUTE ON FUNCTION public.credit_wallet_razorpay(uuid,text,numeric,numeric) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.credit_wallet_razorpay(uuid,text,numeric,numeric) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.credit_wallet_razorpay(uuid,text,numeric,numeric) TO service_role;

REVOKE EXECUTE ON FUNCTION public.apply_referral_bonus(uuid,numeric) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.apply_referral_bonus(uuid,numeric) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.apply_referral_bonus(uuid,numeric) TO service_role;

-- redeem_promo_code is user-callable (charges their own wallet via deposit credit),
-- keep authenticated execute but lock anon
REVOKE EXECUTE ON FUNCTION public.redeem_promo_code(text,numeric) FROM PUBLIC, anon;

-- 4) Block direct client writes on wallets & transactions
REVOKE INSERT, UPDATE, DELETE ON public.wallets FROM anon, authenticated;
REVOKE INSERT, UPDATE, DELETE ON public.transactions FROM anon, authenticated;
