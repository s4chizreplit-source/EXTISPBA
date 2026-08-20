-- ============================================================================
-- Data API grants for every base table in public.
-- authenticated + service_role always; anon SELECT only where a permissive
-- (non auth.uid()-scoped) SELECT policy exists.
-- ============================================================================
DO $$
DECLARE t record; has boolean;
BEGIN
  FOR t IN SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
            WHERE c.relkind='r' AND n.nspname='public'
  LOOP
    -- Always grant the full CRUD set: a partial grant (e.g. SELECT only) used to
    -- be treated as "already granted" and left UPDATE/INSERT missing, which
    -- surfaced as "permission denied for table <name>" in the app.
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON public.%I TO authenticated', t.relname);
    EXECUTE format('GRANT ALL ON public.%I TO service_role', t.relname);

    -- anon read only when a public-read policy already allows it.
    SELECT EXISTS(
      SELECT 1 FROM pg_policies p
       WHERE p.schemaname='public' AND p.tablename=t.relname
         AND p.cmd IN ('SELECT','ALL')
         AND ('anon'=ANY(p.roles) OR 'public'=ANY(p.roles))
         AND coalesce(p.qual,'true') NOT LIKE '%auth.uid()%'
    ) INTO has;
    IF has THEN
      EXECUTE format('GRANT SELECT ON public.%I TO anon', t.relname);
    END IF;
  END LOOP;
END $$;

GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;

-- Sequences (needed for tables with serial/identity columns e.g. order_number)
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO authenticated, service_role;

-- ============================================================================
-- Admin RLS policies for wallet/transaction management from the admin panel.
-- ============================================================================
DROP POLICY IF EXISTS "Admins can manage all wallets" ON public.wallets;
CREATE POLICY "Admins can manage all wallets" ON public.wallets
  FOR ALL TO authenticated
  USING (public.has_role(auth.uid(), 'admin'))
  WITH CHECK (public.has_role(auth.uid(), 'admin'));

DROP POLICY IF EXISTS "Admins can manage all transactions" ON public.transactions;
CREATE POLICY "Admins can manage all transactions" ON public.transactions
  FOR ALL TO authenticated
  USING (public.has_role(auth.uid(), 'admin'))
  WITH CHECK (public.has_role(auth.uid(), 'admin'));
