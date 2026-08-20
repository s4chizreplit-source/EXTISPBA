#!/usr/bin/env bash
# Fix "{}" / empty 500 error on sign-in for imported users.
# Cause: GoTrue cannot scan NULL token columns in auth.users.
# Safe to run any time — only fills NULLs, never deletes anything.
set -euo pipefail

DB_CONTAINER="${DB_CONTAINER:-supabase-db}"
psql_run() { docker exec -i "$DB_CONTAINER" psql -U postgres -d postgres -v ON_ERROR_STOP=1 "$@"; }

echo "==> Before:"
psql_run -c "SELECT count(*) AS users,
  count(*) FILTER (WHERE confirmation_token IS NULL) AS null_confirmation,
  count(*) FILTER (WHERE recovery_token IS NULL) AS null_recovery,
  count(*) FILTER (WHERE email_confirmed_at IS NULL) AS unconfirmed
FROM auth.users;"

psql_run <<'SQL'
DO $$
DECLARE
  c record;
  fix jsonb := jsonb_build_object(
    'confirmation_token', '''''', 'recovery_token', '''''',
    'email_change_token_new', '''''', 'email_change_token_current', '''''',
    'email_change', '''''', 'phone_change', '''''', 'phone_change_token', '''''',
    'reauthentication_token', '''''',
    'aud', '''authenticated''', 'role', '''authenticated''',
    'raw_app_meta_data', '''{"provider":"email","providers":["email"]}''::jsonb',
    'raw_user_meta_data', '''{}''::jsonb',
    'email_confirmed_at', 'now()',
    'is_sso_user', 'false', 'is_anonymous', 'false'
  );
BEGIN
  FOR c IN
    SELECT column_name, is_generated
    FROM information_schema.columns
    WHERE table_schema='auth' AND table_name='users'
      AND column_name IN (SELECT jsonb_object_keys(fix))
  LOOP
    IF c.is_generated = 'ALWAYS' THEN CONTINUE; END IF;
    EXECUTE format('UPDATE auth.users SET %1$I = %2$s WHERE %1$I IS NULL',
                   c.column_name, fix->>c.column_name);
  END LOOP;
  EXECUTE $q$UPDATE auth.users SET aud='authenticated' WHERE aud=''$q$;
  EXECUTE $q$UPDATE auth.users SET role='authenticated' WHERE role=''$q$;
END $$;

-- every email user needs an identity row, else login/lookup breaks
INSERT INTO auth.identities (id, user_id, provider_id, identity_data, provider, created_at, updated_at)
SELECT gen_random_uuid(), u.id, u.id::text,
       jsonb_build_object('sub', u.id::text, 'email', u.email, 'email_verified', true),
       'email', COALESCE(u.created_at, now()), now()
FROM auth.users u
WHERE u.email IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM auth.identities i WHERE i.user_id = u.id AND i.provider='email');
SQL

echo "==> After:"
psql_run -c "SELECT count(*) AS users,
  count(*) FILTER (WHERE confirmation_token IS NULL) AS null_confirmation,
  count(*) FILTER (WHERE email_confirmed_at IS NULL) AS unconfirmed,
  (SELECT count(*) FROM auth.identities) AS identities
FROM auth.users;"

echo "==> Restarting auth service"
cd /opt/smmpanel/supabase-selfhost 2>/dev/null || cd /opt/supabase/docker 2>/dev/null || true
docker restart supabase-auth >/dev/null 2>&1 || docker compose restart auth || true
echo "Done. Try logging in again."
