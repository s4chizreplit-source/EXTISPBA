ALTER TABLE public.instagram_accounts
  ADD COLUMN IF NOT EXISTS last_fetched_at timestamptz;

CREATE INDEX IF NOT EXISTS instagram_accounts_last_fetched_at_idx
  ON public.instagram_accounts (last_fetched_at);