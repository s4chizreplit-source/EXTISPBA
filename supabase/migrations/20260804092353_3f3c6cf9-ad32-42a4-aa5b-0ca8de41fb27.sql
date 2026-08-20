CREATE OR REPLACE FUNCTION public.debit_wallet_for_order(
  p_user_id uuid,
  p_amount numeric
) RETURNS numeric
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_new_balance numeric;
BEGIN
  IF p_amount IS NULL OR p_amount <= 0 THEN
    RAISE EXCEPTION 'Invalid debit amount';
  END IF;

  UPDATE public.wallets
  SET balance = balance - p_amount,
      total_spent = COALESCE(total_spent, 0) + p_amount,
      updated_at = now()
  WHERE user_id = p_user_id
    AND balance >= p_amount
  RETURNING balance INTO v_new_balance;

  IF v_new_balance IS NULL THEN
    RAISE EXCEPTION 'Insufficient balance';
  END IF;

  RETURN v_new_balance;
END;
$$;
REVOKE ALL ON FUNCTION public.debit_wallet_for_order(uuid, numeric) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.debit_wallet_for_order(uuid, numeric) TO service_role;