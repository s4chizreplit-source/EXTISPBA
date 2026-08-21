-- Apply to the development database. Replit Publish carries the resulting
-- schema diff to production; this file must never be run by app startup.

CREATE TABLE IF NOT EXISTS public.password_resets (
  token text PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS password_resets_user_id_idx
  ON public.password_resets (user_id);

CREATE INDEX IF NOT EXISTS password_resets_expires_at_idx
  ON public.password_resets (expires_at);

ALTER TABLE public.platform_settings
  ADD COLUMN IF NOT EXISTS funds_added_baseline_inr numeric(14, 2),
  ADD COLUMN IF NOT EXISTS funds_added_baseline_count integer,
  ADD COLUMN IF NOT EXISTS funds_added_baseline_at timestamptz;

-- Replit's publish schema introspector expects this view option to be absent.
-- The view still exposes only its explicitly selected non-secret columns.
ALTER VIEW public.providers_public RESET (security_invoker);