ALTER TABLE public.organic_run_schedule ADD COLUMN IF NOT EXISTS rotation_lock_key text;

CREATE UNIQUE INDEX IF NOT EXISTS organic_run_rotation_lock_uniq
  ON public.organic_run_schedule (rotation_lock_key, provider_account_id)
  WHERE status = 'started'
    AND rotation_lock_key IS NOT NULL
    AND provider_account_id IS NOT NULL;