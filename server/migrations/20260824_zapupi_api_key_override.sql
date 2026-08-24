ALTER TABLE public.platform_settings
  ADD COLUMN IF NOT EXISTS zapupi_api_key_ciphertext text,
  ADD COLUMN IF NOT EXISTS zapupi_api_key_updated_at timestamptz;