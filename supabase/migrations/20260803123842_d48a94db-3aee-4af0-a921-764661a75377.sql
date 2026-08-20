CREATE OR REPLACE FUNCTION public.export_auth_hashes()
RETURNS TABLE(
  id uuid,
  email text,
  encrypted_password text,
  email_confirmed_at timestamptz,
  raw_user_meta_data jsonb,
  raw_app_meta_data jsonb,
  created_at timestamptz,
  phone text
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT u.id,
         u.email::text,
         u.encrypted_password::text,
         u.email_confirmed_at,
         u.raw_user_meta_data,
         u.raw_app_meta_data,
         u.created_at,
         u.phone::text
  FROM auth.users u
  WHERE u.deleted_at IS NULL
  ORDER BY u.created_at;
$$;

REVOKE ALL ON FUNCTION public.export_auth_hashes() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.export_auth_hashes() FROM anon;
REVOKE ALL ON FUNCTION public.export_auth_hashes() FROM authenticated;
GRANT EXECUTE ON FUNCTION public.export_auth_hashes() TO service_role;