ALTER TABLE public.service_provider_mapping
  ADD COLUMN IF NOT EXISTS backup_provider_account_id uuid REFERENCES public.provider_accounts(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS backup_provider_service_id text;