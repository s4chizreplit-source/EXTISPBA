GRANT INSERT, UPDATE, DELETE ON public.wallets TO authenticated;
GRANT INSERT, UPDATE, DELETE ON public.transactions TO authenticated;
GRANT ALL ON public.wallets TO service_role;
GRANT ALL ON public.transactions TO service_role;