ALTER TABLE public.oxapay_deposits ADD COLUMN IF NOT EXISTS email text;
CREATE INDEX IF NOT EXISTS oxapay_deposits_email_idx ON public.oxapay_deposits (lower(email));