
CREATE TABLE public.provider_balance_history (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  provider_account_id UUID NOT NULL REFERENCES public.provider_accounts(id) ON DELETE CASCADE,
  balance NUMERIC,
  balance_currency TEXT,
  previous_balance NUMERIC,
  delta NUMERIC,
  status TEXT NOT NULL DEFAULT 'ok',
  error_message TEXT,
  source TEXT NOT NULL DEFAULT 'auto',
  checked_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_pbh_account_time ON public.provider_balance_history (provider_account_id, checked_at DESC);
CREATE INDEX idx_pbh_time ON public.provider_balance_history (checked_at DESC);

GRANT SELECT ON public.provider_balance_history TO authenticated;
GRANT ALL ON public.provider_balance_history TO service_role;

ALTER TABLE public.provider_balance_history ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Admins view provider balance history"
ON public.provider_balance_history
FOR SELECT
TO authenticated
USING (public.has_role(auth.uid(), 'admin'::app_role));

ALTER TABLE public.provider_balance_history REPLICA IDENTITY FULL;
ALTER PUBLICATION supabase_realtime ADD TABLE public.provider_balance_history;
