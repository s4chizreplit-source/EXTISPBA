-- Apply to the development database. Replit Publish carries the resulting
-- schema diff to production; this file must never be run by app startup.

CREATE TABLE IF NOT EXISTS public.password_resets (
  token text PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES public.auth_users(id) ON DELETE CASCADE,
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

-- Replit production uses public.auth_users rather than Supabase's private
-- auth.users schema. Re-anchor imported public-table foreign keys without
-- changing any user IDs or application data.
DO $$
DECLARE
  fk record;
BEGIN
  IF to_regclass('auth.users') IS NULL THEN
    RETURN;
  END IF;

  FOR fk IN
    SELECT con.oid,
           n.nspname AS table_schema,
           rel.relname AS table_name,
           con.conname AS constraint_name,
           pg_get_constraintdef(con.oid) AS constraint_definition
      FROM pg_constraint con
      JOIN pg_class rel ON rel.oid = con.conrelid
      JOIN pg_namespace n ON n.oid = rel.relnamespace
     WHERE con.contype = 'f'
       AND n.nspname = 'public'
       AND con.confrelid = to_regclass('auth.users')
  LOOP
    EXECUTE format(
      'ALTER TABLE %I.%I DROP CONSTRAINT %I',
      fk.table_schema,
      fk.table_name,
      fk.constraint_name
    );
    EXECUTE format(
      'ALTER TABLE %I.%I ADD CONSTRAINT %I %s',
      fk.table_schema,
      fk.table_name,
      fk.constraint_name,
      replace(
        fk.constraint_definition,
        'REFERENCES auth.users',
        'REFERENCES public.auth_users'
      )
    );
  END LOOP;
END
$$;