-- VPS-only repair: tables that exist in Lovable Cloud but whose CREATE TABLE
-- migration is not present in this repo's supabase/migrations history.
-- Safe to run repeatedly.

CREATE TABLE IF NOT EXISTS public.organic_run_schedule (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id uuid REFERENCES public.orders(id) ON DELETE CASCADE,
  run_number integer NOT NULL,
  scheduled_at timestamptz NOT NULL,
  quantity_to_send integer NOT NULL,
  base_quantity integer NOT NULL,
  variance_applied integer DEFAULT 0,
  peak_multiplier numeric DEFAULT 1.0,
  status text DEFAULT 'pending',
  provider_order_id text,
  provider_response jsonb,
  error_message text,
  started_at timestamptz,
  completed_at timestamptz,
  engagement_order_item_id uuid,
  provider_start_count integer,
  provider_remains integer,
  provider_status text,
  provider_charge numeric,
  last_status_check timestamptz,
  retry_count integer DEFAULT 0,
  provider_account_id uuid,
  provider_account_name text,
  created_at timestamptz DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.organic_run_schedule TO authenticated;
GRANT ALL ON public.organic_run_schedule TO service_role;

DO $$ BEGIN
  ALTER TABLE public.organic_run_schedule
    ADD CONSTRAINT organic_run_schedule_engagement_order_item_id_fkey
    FOREIGN KEY (engagement_order_item_id)
    REFERENCES public.engagement_order_items(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE public.organic_run_schedule
    ADD CONSTRAINT organic_run_schedule_provider_account_id_fkey
    FOREIGN KEY (provider_account_id)
    REFERENCES public.provider_accounts(id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE INDEX IF NOT EXISTS idx_organic_runs_status_scheduled
  ON public.organic_run_schedule(status, scheduled_at);
CREATE INDEX IF NOT EXISTS idx_organic_runs_engagement_item
  ON public.organic_run_schedule(engagement_order_item_id);
CREATE INDEX IF NOT EXISTS idx_organic_runs_order_status
  ON public.organic_run_schedule(order_id, status);

ALTER TABLE public.organic_run_schedule ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='organic_run_schedule' AND policyname='Users view own runs') THEN
    CREATE POLICY "Users view own runs" ON public.organic_run_schedule
      FOR SELECT TO authenticated USING (
        EXISTS (SELECT 1 FROM public.orders o WHERE o.id = order_id AND o.user_id = auth.uid())
        OR EXISTS (
          SELECT 1 FROM public.engagement_order_items eoi
          JOIN public.engagement_orders eo ON eo.id = eoi.engagement_order_id
          WHERE eoi.id = engagement_order_item_id AND eo.user_id = auth.uid()
        )
        OR public.has_role(auth.uid(), 'admin')
      );
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='organic_run_schedule' AND policyname='Users insert runs for own engagement orders') THEN
    CREATE POLICY "Users insert runs for own engagement orders" ON public.organic_run_schedule
      FOR INSERT TO authenticated WITH CHECK (
        EXISTS (
          SELECT 1 FROM public.engagement_order_items eoi
          JOIN public.engagement_orders eo ON eo.id = eoi.engagement_order_id
          WHERE eoi.id = engagement_order_item_id AND eo.user_id = auth.uid()
        )
        OR EXISTS (SELECT 1 FROM public.orders o WHERE o.id = order_id AND o.user_id = auth.uid())
      );
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='organic_run_schedule' AND policyname='Admins manage runs') THEN
    CREATE POLICY "Admins manage runs" ON public.organic_run_schedule
      FOR ALL TO authenticated
      USING (public.has_role(auth.uid(), 'admin'))
      WITH CHECK (public.has_role(auth.uid(), 'admin'));
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS public.promo_codes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text NOT NULL UNIQUE,
  description text,
  bonus_type text NOT NULL DEFAULT 'percent',
  bonus_value numeric NOT NULL DEFAULT 0,
  min_deposit_usd numeric NOT NULL DEFAULT 0,
  max_uses integer,
  used_count integer NOT NULL DEFAULT 0,
  expires_at timestamptz,
  is_active boolean NOT NULL DEFAULT true,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT ON public.promo_codes TO anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.promo_codes TO authenticated;
GRANT ALL ON public.promo_codes TO service_role;
ALTER TABLE public.promo_codes ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='promo_codes' AND policyname='Admins manage promo codes') THEN
    CREATE POLICY "Admins manage promo codes" ON public.promo_codes
      FOR ALL TO authenticated
      USING (public.has_role(auth.uid(), 'admin'))
      WITH CHECK (public.has_role(auth.uid(), 'admin'));
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS public.promo_redemptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  promo_code_id uuid NOT NULL REFERENCES public.promo_codes(id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  bonus_amount_usd numeric NOT NULL DEFAULT 0,
  deposit_amount_usd numeric NOT NULL DEFAULT 0,
  redeemed_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT ON public.promo_redemptions TO authenticated;
GRANT ALL ON public.promo_redemptions TO service_role;
ALTER TABLE public.promo_redemptions ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='promo_redemptions' AND policyname='Users view own redemptions') THEN
    CREATE POLICY "Users view own redemptions" ON public.promo_redemptions
      FOR SELECT TO authenticated
      USING (user_id = auth.uid() OR public.has_role(auth.uid(), 'admin'));
  END IF;
END $$;
