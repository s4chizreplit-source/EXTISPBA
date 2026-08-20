  FOR SELECT USING (is_active = true);

CREATE POLICY "Admins can manage bundles" ON public.engagement_bundles
  FOR ALL USING (has_role(auth.uid(), 'admin'::app_role));

-- RLS Policies for bundle_items (public read via bundle, admin write)
CREATE POLICY "Everyone can view bundle items" ON public.bundle_items
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM public.engagement_bundles 
      WHERE id = bundle_items.bundle_id AND is_active = true
    )
  );

CREATE POLICY "Admins can manage bundle items" ON public.bundle_items
  FOR ALL USING (has_role(auth.uid(), 'admin'::app_role));

-- RLS Policies for engagement_orders
CREATE POLICY "Users can view own engagement orders" ON public.engagement_orders
  FOR SELECT USING (auth.uid() = user_id);

CREATE POLICY "Users can create own engagement orders" ON public.engagement_orders
  FOR INSERT WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Admins can manage all engagement orders" ON public.engagement_orders
  FOR ALL USING (has_role(auth.uid(), 'admin'::app_role));

-- RLS Policies for engagement_order_items
CREATE POLICY "Users can view own order items" ON public.engagement_order_items
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM public.engagement_orders 
      WHERE id = engagement_order_items.engagement_order_id AND user_id = auth.uid()
    )
  );

CREATE POLICY "Users can create own order items" ON public.engagement_order_items
  FOR INSERT WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.engagement_orders 
      WHERE id = engagement_order_items.engagement_order_id AND user_id = auth.uid()
    )
  );

CREATE POLICY "Admins can manage all order items" ON public.engagement_order_items
  FOR ALL USING (has_role(auth.uid(), 'admin'::app_role));

-- Update organic_run_schedule RLS to include engagement orders
CREATE POLICY "Users can view own engagement run schedules" ON public.organic_run_schedule
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM public.engagement_order_items eoi
      JOIN public.engagement_orders eo ON eo.id = eoi.engagement_order_id
      WHERE eoi.id = organic_run_schedule.engagement_order_item_id 
      AND eo.user_id = auth.uid()
    )
  );

-- Triggers for updated_at
CREATE TRIGGER update_engagement_bundles_updated_at
  BEFORE UPDATE ON public.engagement_bundles
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE TRIGGER update_engagement_orders_updated_at
  BEFORE UPDATE ON public.engagement_orders
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE TRIGGER update_engagement_order_items_updated_at
  BEFORE UPDATE ON public.engagement_order_items
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- === FILE: 20260206220345_2d3fbb5a-ae8f-43c1-82ae-a4e27b1b60ed.sql ===
-- Allow engagement-order schedules to exist without legacy orders.order_id
ALTER TABLE public.organic_run_schedule
ALTER COLUMN order_id DROP NOT NULL;

-- === FILE: 20260206220504_ee9181c0-68c5-4686-87b6-c8db970b6664.sql ===
-- Recreate pg_net extension outside public schema to satisfy linter
CREATE SCHEMA IF NOT EXISTS extensions;
DROP EXTENSION IF EXISTS pg_net;
CREATE EXTENSION IF NOT EXISTS pg_net WITH SCHEMA extensions;

-- === FILE: 20260206220739_4257b285-3fee-4a64-87e8-db7a534fca99.sql ===
-- Update cron job to use execute-all-runs instead of execute-organic-runs
-- This function handles BOTH legacy orders AND engagement orders
-- [REMOVED: Old cron job - set up cron with new project URL separately]

-- === FILE: 20260206220953_2cd7374a-2c2d-40fb-942f-babb3dbeb75d.sql ===
-- Allow users to update their own pending runs
CREATE POLICY "Users can update own pending engagement runs" 
ON public.organic_run_schedule 
FOR UPDATE 
USING (
  status = 'pending' AND
  EXISTS (
    SELECT 1
    FROM engagement_order_items eoi
    JOIN engagement_orders eo ON eo.id = eoi.engagement_order_id
    WHERE eoi.id = organic_run_schedule.engagement_order_item_id
    AND eo.user_id = auth.uid()
  )
);

-- Allow users to update their own pending order runs (legacy)
CREATE POLICY "Users can update own pending order runs" 
ON public.organic_run_schedule 
FOR UPDATE 
USING (
  status = 'pending' AND
  EXISTS (
    SELECT 1
    FROM orders
    WHERE orders.id = organic_run_schedule.order_id
    AND orders.user_id = auth.uid()
  )
);

-- === FILE: 20260206221520_cb960b62-41d2-4aba-b879-8008965a7b02.sql ===
-- Enable realtime for organic_run_schedule and engagement_order_items
ALTER PUBLICATION supabase_realtime ADD TABLE public.organic_run_schedule;
ALTER PUBLICATION supabase_realtime ADD TABLE public.engagement_order_items;
ALTER PUBLICATION supabase_realtime ADD TABLE public.engagement_orders;

-- === FILE: 20260206225416_692f1ad4-8e51-40dd-98d1-0323f701de51.sql ===
-- Create function to handle new user signup
-- This automatically creates profile and wallet for new users
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Create profile for new user
  INSERT INTO public.profiles (user_id, email, full_name)
  VALUES (
    NEW.id,
    NEW.email,
    COALESCE(NEW.raw_user_meta_data->>'full_name', split_part(NEW.email, '@', 1))
  )
  ON CONFLICT (user_id) DO NOTHING;
  
  -- Create wallet for new user
  INSERT INTO public.wallets (user_id, balance, total_deposited, total_spent)
  VALUES (NEW.id, 0, 0, 0)
  ON CONFLICT (user_id) DO NOTHING;
  
  -- Assign default user role
  INSERT INTO public.user_roles (user_id, role)
  VALUES (NEW.id, 'user')
  ON CONFLICT (user_id, role) DO NOTHING;
  
  RETURN NEW;
END;
$$;

-- Drop existing trigger if exists
DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;

-- Create trigger on auth.users table
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW
  EXECUTE FUNCTION public.handle_new_user();

-- Add unique constraint on profiles.user_id if not exists
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'profiles_user_id_key'
  ) THEN
    ALTER TABLE public.profiles ADD CONSTRAINT profiles_user_id_key UNIQUE (user_id);
  END IF;
END $$;

-- Add unique constraint on wallets.user_id if not exists  
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'wallets_user_id_key'
  ) THEN
    ALTER TABLE public.wallets ADD CONSTRAINT wallets_user_id_key UNIQUE (user_id);
  END IF;
END $$;

-- === FILE: 20260206231815_3d0050ba-956b-4dab-b2d7-b7d1cdad4474.sql ===
-- Add column for custom ratio mode to engagement_bundles
ALTER TABLE public.engagement_bundles 
ADD COLUMN IF NOT EXISTS use_custom_ratios boolean DEFAULT false;

-- Add comment for documentation
COMMENT ON COLUMN public.engagement_bundles.use_custom_ratios IS 'When true, uses admin-defined ratios. When false, uses AI-calculated organic ratios.';

-- === FILE: 20260207005528_e347c040-4591-406d-b86c-82666c093a83.sql ===
-- Add AI Organic Mode setting to engagement bundles
-- When enabled, AI automatically generates unique organic patterns for each order

ALTER TABLE public.engagement_bundles 
ADD COLUMN IF NOT EXISTS ai_organic_enabled boolean DEFAULT true;

-- Add a comment for clarity
COMMENT ON COLUMN public.engagement_bundles.ai_organic_enabled IS 'When ON, AI generates unique organic delivery patterns for each order automatically';

-- === FILE: 20260207010155_2a29b892-5503-44bc-98bf-530e3675878e.sql ===
-- Fix Critical Security: Provider API keys should NOT be visible to regular users
-- Only admins should be able to see API keys

-- Drop existing "Everyone can view active providers" policy
DROP POLICY IF EXISTS "Everyone can view active providers" ON public.providers;

-- Create new policy that only allows viewing non-sensitive columns for regular users
-- The api_key column should never be exposed to non-admin users

-- Create a view for public provider info (without API key)
CREATE OR REPLACE VIEW public.providers_public AS
SELECT 
  id,
  name,
  api_url,
  is_active,
  created_at,
  updated_at
FROM public.providers
WHERE is_active = true;

-- Grant access to the view for authenticated users
GRANT SELECT ON public.providers_public TO authenticated;

-- Now update RLS: Only admins can view full providers table
CREATE POLICY "Admins can view all provider details"
ON public.providers
FOR SELECT
USING (has_role(auth.uid(), 'admin'::app_role));

-- Enable leaked password protection
-- Note: This is a Supabase setting, not SQL, but we can add a check constraint for password complexity

-- === FILE: 20260207010203_7e2f5c6e-75e5-4ab1-a489-064e963d257c.sql ===
-- Fix SECURITY DEFINER view issue - drop and recreate with SECURITY INVOKER
DROP VIEW IF EXISTS public.providers_public;

-- Recreate without SECURITY DEFINER (uses SECURITY INVOKER by default)
CREATE VIEW public.providers_public
WITH (security_invoker = on) AS
SELECT 
  id,
  name,
  api_url,
  is_active,
  created_at,
  updated_at
FROM public.providers
WHERE is_active = true;

-- Grant select to authenticated users
GRANT SELECT ON public.providers_public TO authenticated;
GRANT SELECT ON public.providers_public TO anon;

-- === FILE: 20260207081615_c260b358-c43b-4154-97d5-0b235badabcf.sql ===
-- Drop existing constraint and add CASCADE delete for bundle_items -> services
ALTER TABLE public.bundle_items
  DROP CONSTRAINT IF EXISTS bundle_items_service_id_fkey;

ALTER TABLE public.bundle_items
  ADD CONSTRAINT bundle_items_service_id_fkey
  FOREIGN KEY (service_id) REFERENCES public.services(id) ON DELETE SET NULL;

-- === FILE: 20260207093742_5557cbec-6b13-460d-a0a4-3eba0cab6234.sql ===
-- Add columns to track provider real-time status
ALTER TABLE public.organic_run_schedule 
ADD COLUMN IF NOT EXISTS provider_start_count integer DEFAULT NULL,
ADD COLUMN IF NOT EXISTS provider_remains integer DEFAULT NULL,
ADD COLUMN IF NOT EXISTS provider_status text DEFAULT NULL,
ADD COLUMN IF NOT EXISTS provider_charge numeric DEFAULT NULL,
ADD COLUMN IF NOT EXISTS last_status_check timestamp with time zone DEFAULT NULL;

-- Add index for faster status queries
CREATE INDEX IF NOT EXISTS idx_organic_run_schedule_status_check 
ON public.organic_run_schedule(status, last_status_check);

COMMENT ON COLUMN public.organic_run_schedule.provider_start_count IS 'Initial count from provider when order started';
COMMENT ON COLUMN public.organic_run_schedule.provider_remains IS 'Remaining quantity to deliver from provider';
COMMENT ON COLUMN public.organic_run_schedule.provider_status IS 'Current status from provider (Pending, In progress, Processing, Completed, etc.)';
COMMENT ON COLUMN public.organic_run_schedule.provider_charge IS 'Actual charge from provider for this run';
COMMENT ON COLUMN public.organic_run_schedule.last_status_check IS 'Last time provider status was checked';

-- === FILE: 20260208083100_58cfa56a-a84d-469d-965d-4870dc9f7c90.sql ===
-- Create RPC function to fetch cron jobs
CREATE OR REPLACE FUNCTION public.get_cron_jobs()
RETURNS TABLE (
  jobid bigint,
  jobname text,
  schedule text,
  active boolean
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, cron
AS $$
  SELECT jobid, jobname, schedule, active
  FROM cron.job
  ORDER BY jobname;
$$;

-- Create RPC function to fetch recent cron run details
CREATE OR REPLACE FUNCTION public.get_cron_run_details(limit_count integer DEFAULT 50)
RETURNS TABLE (
  runid bigint,
  jobid bigint,
  job_pid integer,
  database text,
  username text,
  command text,
  status text,
  return_message text,
  start_time timestamp with time zone,
  end_time timestamp with time zone
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, cron
AS $$
  SELECT 
    runid,
    jobid,
    job_pid,
    database,
    username,
    command,
    status,
    return_message,
    start_time,
    end_time
  FROM cron.job_run_details
  ORDER BY start_time DESC
  LIMIT limit_count;
$$;

-- Grant execute permissions to authenticated users (admin check is in edge function)
GRANT EXECUTE ON FUNCTION public.get_cron_jobs() TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_cron_run_details(integer) TO authenticated;

-- === FILE: 20260208085124_29abcc15-0376-43ef-9bbb-2a828601ad5f.sql ===
-- Create subscriptions table to track user subscription status
CREATE TABLE public.subscriptions (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id uuid NOT NULL UNIQUE,
  plan_type text NOT NULL DEFAULT 'none' CHECK (plan_type IN ('none', 'monthly', 'lifetime')),
  status text NOT NULL DEFAULT 'inactive' CHECK (status IN ('inactive', 'active', 'expired', 'cancelled')),
  activated_at timestamp with time zone,
  expires_at timestamp with time zone,
  activated_by uuid,
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now()
);

-- Create subscription_requests table for manual approval flow
CREATE TABLE public.subscription_requests (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id uuid NOT NULL,
  full_name text NOT NULL,
  email text NOT NULL,
  phone text NOT NULL,
  plan_type text NOT NULL CHECK (plan_type IN ('monthly', 'lifetime')),
  message text,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  reviewed_by uuid,
  reviewed_at timestamp with time zone,
  admin_notes text,
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now()
);

-- Enable RLS on both tables
ALTER TABLE public.subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.subscription_requests ENABLE ROW LEVEL SECURITY;

-- RLS for subscriptions
CREATE POLICY "Users can view own subscription"
ON public.subscriptions FOR SELECT
USING (auth.uid() = user_id);

CREATE POLICY "Admins can manage all subscriptions"
ON public.subscriptions FOR ALL
USING (has_role(auth.uid(), 'admin'::app_role));

-- RLS for subscription_requests
CREATE POLICY "Users can view own requests"
ON public.subscription_requests FOR SELECT
USING (auth.uid() = user_id);

CREATE POLICY "Users can create own requests"
ON public.subscription_requests FOR INSERT
WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Admins can manage all requests"
ON public.subscription_requests FOR ALL
USING (has_role(auth.uid(), 'admin'::app_role));

-- Create trigger for updated_at
CREATE TRIGGER update_subscriptions_updated_at
BEFORE UPDATE ON public.subscriptions
FOR EACH ROW
EXECUTE FUNCTION public.update_updated_at_column();

CREATE TRIGGER update_subscription_requests_updated_at
BEFORE UPDATE ON public.subscription_requests
FOR EACH ROW
EXECUTE FUNCTION public.update_updated_at_column();

-- Create subscription automatically when user signs up (status = inactive)
CREATE OR REPLACE FUNCTION public.create_user_subscription()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO public.subscriptions (user_id, plan_type, status)
  VALUES (NEW.id, 'none', 'inactive')
  ON CONFLICT (user_id) DO NOTHING;
  RETURN NEW;
END;
$$;

CREATE TRIGGER on_user_created_subscription
AFTER INSERT ON auth.users
FOR EACH ROW
EXECUTE FUNCTION public.create_user_subscription();

-- === FILE: 20260208085749_fb67e245-bb6b-4435-96a6-1ae9a5a1b167.sql ===
-- Add cron job to check subscription expiry every hour
-- [REMOVED: Old cron job - set up cron with new project URL separately]

-- === FILE: 20260208090035_c02a9142-5d4a-44c6-a185-2fb9b2384f71.sql ===
-- Create chat conversations table
CREATE TABLE public.chat_conversations (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL,
  user_email TEXT NOT NULL,
  user_name TEXT,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
  last_message_at TIMESTAMP WITH TIME ZONE DEFAULT now(),
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- Create chat messages table
