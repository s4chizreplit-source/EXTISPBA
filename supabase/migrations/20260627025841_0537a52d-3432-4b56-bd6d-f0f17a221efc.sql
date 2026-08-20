
CREATE OR REPLACE FUNCTION public.debit_wallet_for_order(
  p_user_id uuid,
  p_amount numeric,
  p_order_id uuid DEFAULT NULL,
  p_description text DEFAULT 'Order payment',
  p_idempotency_key text DEFAULT NULL
)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_lock_key bigint;
  v_balance numeric;
  v_spent numeric;
  v_new_balance numeric;
  v_amount numeric;
  v_existing_id uuid;
  v_txn_id uuid;
BEGIN
  IF p_user_id IS NULL THEN
    RAISE EXCEPTION 'user_id required' USING ERRCODE = '22023';
  END IF;
  IF p_amount IS NULL OR p_amount <= 0 THEN
    RAISE EXCEPTION 'amount must be greater than zero' USING ERRCODE = '22023';
  END IF;

  v_amount := trunc(p_amount::numeric, 4);

  -- Idempotency: if a previous call with same key already debited, return that result.
  IF p_idempotency_key IS NOT NULL AND length(btrim(p_idempotency_key)) > 0 THEN
    v_lock_key := abs(hashtextextended('debit_wallet_for_order:' || p_idempotency_key, 0));
    PERFORM pg_catalog.pg_advisory_xact_lock(v_lock_key);

    SELECT id INTO v_existing_id
      FROM public.transactions
     WHERE payment_method = 'wallet'
       AND payment_reference = p_idempotency_key
       AND user_id = p_user_id
     LIMIT 1;

    IF v_existing_id IS NOT NULL THEN
      SELECT balance INTO v_balance FROM public.wallets WHERE user_id = p_user_id;
      RETURN json_build_object(
        'success', true,
        'duplicate', true,
        'transaction_id', v_existing_id,
        'new_balance', COALESCE(v_balance, 0),
        'debited', 0
      );
    END IF;
  END IF;

  INSERT INTO public.wallets (user_id, balance, total_deposited, total_spent)
    VALUES (p_user_id, 0, 0, 0)
    ON CONFLICT (user_id) DO NOTHING;

  SELECT balance, total_spent
    INTO v_balance, v_spent
    FROM public.wallets
    WHERE user_id = p_user_id
    FOR UPDATE;

  IF v_balance IS NULL THEN
    RAISE EXCEPTION 'wallet not found' USING ERRCODE = 'P0002';
  END IF;

  IF v_balance < v_amount THEN
    RAISE EXCEPTION 'insufficient balance: have %, need %', v_balance, v_amount
      USING ERRCODE = 'P0001';
  END IF;

  v_new_balance := trunc(v_balance - v_amount, 4);

  UPDATE public.wallets
     SET balance = v_new_balance,
         total_spent = trunc(COALESCE(v_spent, 0) + v_amount, 4)
   WHERE user_id = p_user_id;

  INSERT INTO public.transactions (
    user_id, type, amount, balance_after, status,
    payment_method, payment_reference, order_id, description
  ) VALUES (
    p_user_id, 'order', -v_amount, v_new_balance, 'completed',
    'wallet', p_idempotency_key, p_order_id, p_description
  )
  RETURNING id INTO v_txn_id;

  RETURN json_build_object(
    'success', true,
    'duplicate', false,
    'transaction_id', v_txn_id,
    'new_balance', v_new_balance,
    'debited', v_amount
  );
END;
$$;

-- Lock down: only service role (edge functions) may invoke.
REVOKE ALL ON FUNCTION public.debit_wallet_for_order(uuid, numeric, uuid, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.debit_wallet_for_order(uuid, numeric, uuid, text, text) FROM authenticated, anon;
GRANT EXECUTE ON FUNCTION public.debit_wallet_for_order(uuid, numeric, uuid, text, text) TO service_role;
