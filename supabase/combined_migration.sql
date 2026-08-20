-- === FILE: 20260206190902_15809f09-a5e4-4a5c-863c-fdeead2818d0.sql ===
-- Create app_role enum
CREATE TYPE public.app_role AS ENUM ('admin', 'moderator', 'user');

-- Providers table
CREATE TABLE public.providers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  api_url TEXT NOT NULL,
  api_key TEXT NOT NULL,
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- Services table
CREATE TABLE public.services (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_id TEXT REFERENCES public.providers(id) ON DELETE CASCADE,
  provider_service_id TEXT NOT NULL,
  name TEXT NOT NULL,
  category TEXT NOT NULL,
  description TEXT,
  price NUMERIC NOT NULL DEFAULT 0,
  min_quantity INTEGER NOT NULL DEFAULT 10,
  max_quantity INTEGER NOT NULL DEFAULT 100000,
  speed TEXT DEFAULT 'medium',
  quality TEXT DEFAULT 'standard',
  drip_feed_enabled BOOLEAN DEFAULT false,
  is_active BOOLEAN DEFAULT true,
  start_time TEXT,
  refill TEXT,
  cancel_allowed TEXT,
  drop_type TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- Profiles table
CREATE TABLE public.profiles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL UNIQUE,
  email TEXT NOT NULL,
  full_name TEXT,
  api_key TEXT,
  currency TEXT DEFAULT 'USD',
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- User roles table (separate from profiles for security)
CREATE TABLE public.user_roles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,
  role app_role NOT NULL DEFAULT 'user',
  created_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(user_id, role)
);

-- Wallets table
CREATE TABLE public.wallets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL UNIQUE,
  balance NUMERIC DEFAULT 0,
  total_deposited NUMERIC DEFAULT 0,
  total_spent NUMERIC DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- Orders table
CREATE TABLE public.orders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_number SERIAL,
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,
  service_id UUID REFERENCES public.services(id) ON DELETE SET NULL,
  link TEXT NOT NULL,
  quantity INTEGER NOT NULL,
  price NUMERIC NOT NULL,
  status TEXT DEFAULT 'pending',
  start_count INTEGER,
  remains INTEGER,
  provider_order_id TEXT,
  is_drip_feed BOOLEAN DEFAULT false,
  drip_runs INTEGER,
  drip_interval INTEGER,
  drip_interval_unit TEXT,
  drip_quantity_per_run INTEGER,
  is_organic_mode BOOLEAN DEFAULT false,
  variance_percent INTEGER DEFAULT 25,
  peak_hours_enabled BOOLEAN DEFAULT true,
  error_message TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- Organic run schedule table
CREATE TABLE public.organic_run_schedule (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id UUID REFERENCES public.orders(id) ON DELETE CASCADE NOT NULL,
  run_number INTEGER NOT NULL,
  scheduled_at TIMESTAMPTZ NOT NULL,
  quantity_to_send INTEGER NOT NULL,
  base_quantity INTEGER NOT NULL,
  variance_applied INTEGER DEFAULT 0,
  peak_multiplier NUMERIC DEFAULT 1.0,
  status TEXT DEFAULT 'pending',
  provider_order_id TEXT,
  provider_response JSONB,
  error_message TEXT,
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- Transactions table
CREATE TABLE public.transactions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,
  type TEXT NOT NULL,
  amount NUMERIC NOT NULL,
  balance_after NUMERIC NOT NULL,
  order_id UUID REFERENCES public.orders(id) ON DELETE SET NULL,
  description TEXT,
  payment_method TEXT,
  payment_reference TEXT,
  status TEXT DEFAULT 'pending',
  created_at TIMESTAMPTZ DEFAULT now()
);

-- Support tickets table
CREATE TABLE public.support_tickets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,
  subject TEXT NOT NULL,
  message TEXT NOT NULL,
  category TEXT DEFAULT 'other',
  priority TEXT DEFAULT 'medium',
  status TEXT DEFAULT 'open',
  order_id UUID REFERENCES public.orders(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- Enable RLS on all tables
ALTER TABLE public.providers ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.services ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_roles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.wallets ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.organic_run_schedule ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.transactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.support_tickets ENABLE ROW LEVEL SECURITY;

-- Security definer function for role checking
CREATE OR REPLACE FUNCTION public.has_role(_user_id UUID, _role app_role)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.user_roles
    WHERE user_id = _user_id
      AND role = _role
  )
$$;

-- Function to get current user role
CREATE OR REPLACE FUNCTION public.get_user_role(_user_id UUID)
RETURNS app_role
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT role FROM public.user_roles WHERE user_id = _user_id LIMIT 1
$$;

-- RLS Policies for providers (admin only)
CREATE POLICY "Admins can manage providers"
ON public.providers FOR ALL
TO authenticated
USING (public.has_role(auth.uid(), 'admin'));

CREATE POLICY "Everyone can view active providers"
ON public.providers FOR SELECT
TO authenticated
USING (is_active = true);

-- RLS Policies for services
CREATE POLICY "Everyone can view active services"
ON public.services FOR SELECT
TO authenticated
USING (is_active = true);

CREATE POLICY "Admins can manage services"
ON public.services FOR ALL
TO authenticated
USING (public.has_role(auth.uid(), 'admin'));

-- RLS Policies for profiles
CREATE POLICY "Users can view own profile"
ON public.profiles FOR SELECT
TO authenticated
USING (auth.uid() = user_id);

CREATE POLICY "Users can update own profile"
ON public.profiles FOR UPDATE
TO authenticated
USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own profile"
ON public.profiles FOR INSERT
TO authenticated
WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Admins can view all profiles"
ON public.profiles FOR SELECT
TO authenticated
USING (public.has_role(auth.uid(), 'admin'));

-- RLS Policies for user_roles
CREATE POLICY "Users can view own roles"
ON public.user_roles FOR SELECT
TO authenticated
USING (auth.uid() = user_id);

CREATE POLICY "Admins can manage all roles"
ON public.user_roles FOR ALL
TO authenticated
USING (public.has_role(auth.uid(), 'admin'));

-- RLS Policies for wallets
CREATE POLICY "Users can view own wallet"
ON public.wallets FOR SELECT
TO authenticated
USING (auth.uid() = user_id);

CREATE POLICY "Users can update own wallet"
ON public.wallets FOR UPDATE
TO authenticated
USING (auth.uid() = user_id);

CREATE POLICY "Admins can manage all wallets"
ON public.wallets FOR ALL
TO authenticated
USING (public.has_role(auth.uid(), 'admin'));

-- RLS Policies for orders
CREATE POLICY "Users can view own orders"
ON public.orders FOR SELECT
TO authenticated
USING (auth.uid() = user_id);

CREATE POLICY "Users can create own orders"
ON public.orders FOR INSERT
TO authenticated
WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Admins can manage all orders"
ON public.orders FOR ALL
TO authenticated
USING (public.has_role(auth.uid(), 'admin'));

-- RLS Policies for organic_run_schedule
CREATE POLICY "Users can view own order runs"
ON public.organic_run_schedule FOR SELECT
TO authenticated
USING (EXISTS (
  SELECT 1 FROM public.orders 
  WHERE orders.id = organic_run_schedule.order_id 
  AND orders.user_id = auth.uid()
));

CREATE POLICY "Admins can manage all runs"
ON public.organic_run_schedule FOR ALL
TO authenticated
USING (public.has_role(auth.uid(), 'admin'));

-- RLS Policies for transactions
CREATE POLICY "Users can view own transactions"
ON public.transactions FOR SELECT
TO authenticated
USING (auth.uid() = user_id);

CREATE POLICY "Admins can manage all transactions"
ON public.transactions FOR ALL
TO authenticated
USING (public.has_role(auth.uid(), 'admin'));

-- RLS Policies for support_tickets
CREATE POLICY "Users can view own tickets"
ON public.support_tickets FOR SELECT
TO authenticated
USING (auth.uid() = user_id);

CREATE POLICY "Users can create own tickets"
ON public.support_tickets FOR INSERT
TO authenticated
WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Admins can manage all tickets"
ON public.support_tickets FOR ALL
TO authenticated
USING (public.has_role(auth.uid(), 'admin'));

-- Function to handle new user signup
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Create profile
  INSERT INTO public.profiles (user_id, email, full_name)
  VALUES (NEW.id, NEW.email, COALESCE(NEW.raw_user_meta_data->>'full_name', ''));
  
  -- Create wallet
  INSERT INTO public.wallets (user_id, balance)
  VALUES (NEW.id, 0);
  
  -- Assign default user role
  INSERT INTO public.user_roles (user_id, role)
  VALUES (NEW.id, 'user');
  
  RETURN NEW;
END;
$$;

-- Trigger for new user signup
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

-- Function to update updated_at timestamp
CREATE OR REPLACE FUNCTION public.update_updated_at_column()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

-- Triggers for updated_at
CREATE TRIGGER update_providers_updated_at BEFORE UPDATE ON public.providers FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
CREATE TRIGGER update_services_updated_at BEFORE UPDATE ON public.services FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
CREATE TRIGGER update_profiles_updated_at BEFORE UPDATE ON public.profiles FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
CREATE TRIGGER update_wallets_updated_at BEFORE UPDATE ON public.wallets FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
CREATE TRIGGER update_orders_updated_at BEFORE UPDATE ON public.orders FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
CREATE TRIGGER update_tickets_updated_at BEFORE UPDATE ON public.support_tickets FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- === FILE: 20260206193303_d70cb7f6-4cec-4ab2-b4f9-0465497ae3a3.sql ===
-- Enable pg_cron and pg_net extensions
CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net;

-- Grant usage to postgres user
GRANT USAGE ON SCHEMA cron TO postgres;
GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA cron TO postgres;

-- === FILE: 20260206205542_6394842f-0eff-482d-91ed-2ecde40b1bd4.sql ===
-- Create engagement_bundles table (Combo Packs for platforms)
CREATE TABLE public.engagement_bundles (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  name TEXT NOT NULL,
  platform TEXT NOT NULL, -- 'instagram', 'tiktok', 'youtube', 'twitter', 'facebook'
  provider_id TEXT REFERENCES public.providers(id),
  description TEXT,
  icon TEXT DEFAULT 'rocket',
  is_active BOOLEAN DEFAULT true,
  sort_order INTEGER DEFAULT 0,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT now()
);

-- Create bundle_items table (Services linked to bundles)
CREATE TABLE public.bundle_items (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  bundle_id UUID NOT NULL REFERENCES public.engagement_bundles(id) ON DELETE CASCADE,
  service_id UUID REFERENCES public.services(id),
  engagement_type TEXT NOT NULL, -- 'views', 'likes', 'comments', 'saves', 'shares'
  ratio_percent NUMERIC DEFAULT 100, -- percentage of base (100 for views, 6 for likes, etc.)
  is_base BOOLEAN DEFAULT false, -- is this the base service (Views)
  default_drip_qty_per_run INTEGER DEFAULT 500,
  default_drip_interval INTEGER DEFAULT 1,
  default_drip_interval_unit TEXT DEFAULT 'hours',
  sort_order INTEGER DEFAULT 0,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT now()
);

-- Create engagement_orders table (Parent Order for full engagement)
CREATE TABLE public.engagement_orders (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  order_number SERIAL,
  user_id UUID NOT NULL,
  bundle_id UUID REFERENCES public.engagement_bundles(id),
  link TEXT NOT NULL,
  base_quantity INTEGER NOT NULL,
  total_price NUMERIC NOT NULL,
  is_organic_mode BOOLEAN DEFAULT true,
  variance_percent INTEGER DEFAULT 25,
  peak_hours_enabled BOOLEAN DEFAULT true,
  status TEXT DEFAULT 'pending', -- 'pending', 'processing', 'completed', 'partial', 'failed'
  error_message TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT now()
);

-- Create engagement_order_items table (Child Orders per Engagement Type)
CREATE TABLE public.engagement_order_items (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  engagement_order_id UUID NOT NULL REFERENCES public.engagement_orders(id) ON DELETE CASCADE,
  engagement_type TEXT NOT NULL, -- 'views', 'likes', 'comments', 'saves', 'shares'
  service_id UUID REFERENCES public.services(id),
  quantity INTEGER NOT NULL,
  price NUMERIC NOT NULL,
  drip_qty_per_run INTEGER,
  drip_interval INTEGER,
  drip_interval_unit TEXT DEFAULT 'hours',
  speed_preset TEXT DEFAULT 'natural', -- 'fast', 'natural', 'safe'
  is_enabled BOOLEAN DEFAULT true,
  status TEXT DEFAULT 'pending', -- 'pending', 'processing', 'completed', 'failed'
  provider_order_id TEXT,
  error_message TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT now()
);

-- Add engagement_order_item_id to organic_run_schedule for linking runs to engagement items
ALTER TABLE public.organic_run_schedule 
ADD COLUMN IF NOT EXISTS engagement_order_item_id UUID REFERENCES public.engagement_order_items(id) ON DELETE CASCADE;

-- Enable RLS on all new tables
ALTER TABLE public.engagement_bundles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.bundle_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.engagement_orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.engagement_order_items ENABLE ROW LEVEL SECURITY;

-- RLS Policies for engagement_bundles (public read, admin write)
CREATE POLICY "Everyone can view active bundles" ON public.engagement_bundles
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
SELECT cron.unschedule(4);

SELECT cron.schedule(
  'execute-all-runs-cron',
  '* * * * *', -- Every minute
  $$
  SELECT extensions.http_post(
    url:='https://umtfcpopjrxyfjcovgtw.supabase.co/functions/v1/execute-all-runs',
    headers:='{"Content-Type": "application/json", "Authorization": "Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InVtdGZjcG9wanJ4eWZqY292Z3R3Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzAzODU0MTEsImV4cCI6MjA4NTk2MTQxMX0.uvuoonRKHz37OMRGM1b-n6aVo1h9IvxBmWrIxlCojBs"}'::jsonb,
    body:='{}'::jsonb
  ) AS request_id;
  $$
);

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
SELECT cron.schedule(
  'check-subscription-expiry',
  '0 * * * *', -- Every hour at minute 0
  $$
  SELECT net.http_post(
    url := 'https://umtfcpopjrxyfjcovgtw.supabase.co/functions/v1/check-subscription-expiry',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || current_setting('supabase.service_role_key', true)
    ),
    body := '{}'::jsonb
  ) AS request_id;
  $$
);

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
CREATE TABLE public.chat_messages (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  conversation_id UUID NOT NULL REFERENCES public.chat_conversations(id) ON DELETE CASCADE,
  sender_id UUID NOT NULL,
  sender_role TEXT NOT NULL CHECK (sender_role IN ('user', 'admin')),
  message TEXT NOT NULL,
  is_read BOOLEAN DEFAULT false,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- Enable RLS
ALTER TABLE public.chat_conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.chat_messages ENABLE ROW LEVEL SECURITY;

-- RLS policies for chat_conversations
CREATE POLICY "Users can view their own conversations"
  ON public.chat_conversations FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Users can create their own conversations"
  ON public.chat_conversations FOR INSERT
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update their own conversations"
  ON public.chat_conversations FOR UPDATE
  USING (auth.uid() = user_id);

CREATE POLICY "Admins can view all conversations"
  ON public.chat_conversations FOR SELECT
  USING (public.has_role(auth.uid(), 'admin'));

CREATE POLICY "Admins can update all conversations"
  ON public.chat_conversations FOR UPDATE
  USING (public.has_role(auth.uid(), 'admin'));

-- RLS policies for chat_messages
CREATE POLICY "Users can view messages in their conversations"
  ON public.chat_messages FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM public.chat_conversations
      WHERE id = conversation_id AND user_id = auth.uid()
    )
  );

CREATE POLICY "Users can create messages in their conversations"
  ON public.chat_messages FOR INSERT
  WITH CHECK (
    auth.uid() = sender_id AND
    EXISTS (
      SELECT 1 FROM public.chat_conversations
      WHERE id = conversation_id AND user_id = auth.uid()
    )
  );

CREATE POLICY "Admins can view all messages"
  ON public.chat_messages FOR SELECT
  USING (public.has_role(auth.uid(), 'admin'));

CREATE POLICY "Admins can create messages"
  ON public.chat_messages FOR INSERT
  WITH CHECK (
    auth.uid() = sender_id AND
    public.has_role(auth.uid(), 'admin')
  );

CREATE POLICY "Admins can update messages"
  ON public.chat_messages FOR UPDATE
  USING (public.has_role(auth.uid(), 'admin'));

-- Create indexes for performance
CREATE INDEX idx_chat_conversations_user_id ON public.chat_conversations(user_id);
CREATE INDEX idx_chat_conversations_status ON public.chat_conversations(status);
CREATE INDEX idx_chat_messages_conversation_id ON public.chat_messages(conversation_id);
CREATE INDEX idx_chat_messages_created_at ON public.chat_messages(created_at);

-- Enable realtime for messages
ALTER PUBLICATION supabase_realtime ADD TABLE public.chat_messages;
ALTER PUBLICATION supabase_realtime ADD TABLE public.chat_conversations;

-- Trigger to update conversation last_message_at
CREATE OR REPLACE FUNCTION public.update_conversation_last_message()
RETURNS TRIGGER AS $$
BEGIN
  UPDATE public.chat_conversations
  SET last_message_at = NEW.created_at, updated_at = now()
  WHERE id = NEW.conversation_id;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

CREATE TRIGGER on_new_chat_message
  AFTER INSERT ON public.chat_messages
  FOR EACH ROW
  EXECUTE FUNCTION public.update_conversation_last_message();

-- === FILE: 20260208091906_466b35b7-c1f3-4ab3-9262-ec5476fc6f36.sql ===
-- Add INSERT policy for users to create their own transactions
CREATE POLICY "Users can insert own transactions"
ON public.transactions
FOR INSERT
WITH CHECK (auth.uid() = user_id);

-- === FILE: 20260208094831_6152aabe-4b5b-4e8d-b913-db6f12126cb0.sql ===
-- Add INSERT policy for organic_run_schedule so users can create runs for their own engagement orders
CREATE POLICY "Users can insert runs for own engagement orders"
ON public.organic_run_schedule
FOR INSERT
WITH CHECK (
  EXISTS (
    SELECT 1
    FROM engagement_order_items eoi
    JOIN engagement_orders eo ON eo.id = eoi.engagement_order_id
    WHERE eoi.id = organic_run_schedule.engagement_order_item_id
      AND eo.user_id = auth.uid()
  )
);

-- Also add INSERT policy for legacy orders
CREATE POLICY "Users can insert runs for own orders"
ON public.organic_run_schedule
FOR INSERT
WITH CHECK (
  EXISTS (
    SELECT 1
    FROM orders
    WHERE orders.id = organic_run_schedule.order_id
      AND orders.user_id = auth.uid()
  )
);

-- === FILE: 20260208100326_35fcb158-623d-4d09-be35-90c4ae48ac8d.sql ===
-- Enable realtime for wallets table so balance updates are broadcasted instantly
ALTER PUBLICATION supabase_realtime ADD TABLE public.wallets;

-- === FILE: 20260208114910_aa1363e2-3d1d-477f-8284-9bc425ae6536.sql ===
-- Add retry_count column to organic_run_schedule for tracking automatic retries
ALTER TABLE public.organic_run_schedule 
ADD COLUMN IF NOT EXISTS retry_count integer DEFAULT 0;

-- Add comment for documentation
COMMENT ON COLUMN public.organic_run_schedule.retry_count IS 'Number of times this run has been automatically retried after failure';

-- === FILE: 20260208224444_a4883446-0c9c-4697-8f0e-36d3a4139a97.sql ===
-- Provider Accounts (multiple API keys per provider)
CREATE TABLE public.provider_accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_id text NOT NULL,
  name text NOT NULL,
  api_key text NOT NULL,
  api_url text NOT NULL,
  priority int DEFAULT 1,
  is_active bool DEFAULT true,
  last_used_at timestamptz,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

-- Service to Provider Account mapping (many-to-many)
CREATE TABLE public.service_provider_mapping (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  service_id uuid REFERENCES public.services(id) ON DELETE CASCADE,
  provider_account_id uuid REFERENCES public.provider_accounts(id) ON DELETE CASCADE,
  provider_service_id text NOT NULL,
  sort_order int DEFAULT 0,
  is_active bool DEFAULT true,
  created_at timestamptz DEFAULT now(),
  UNIQUE(service_id, provider_account_id)
);

-- Track which account was used for each run
ALTER TABLE public.organic_run_schedule 
ADD COLUMN provider_account_id uuid REFERENCES public.provider_accounts(id);

-- Enable RLS
ALTER TABLE public.provider_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.service_provider_mapping ENABLE ROW LEVEL SECURITY;

-- RLS Policies (admin only)
CREATE POLICY "Admins can manage provider accounts" ON public.provider_accounts
  FOR ALL USING (has_role(auth.uid(), 'admin'::app_role));

CREATE POLICY "Admins can manage service mappings" ON public.service_provider_mapping
  FOR ALL USING (has_role(auth.uid(), 'admin'::app_role));

-- Trigger for updated_at on provider_accounts
CREATE TRIGGER update_provider_accounts_updated_at
BEFORE UPDATE ON public.provider_accounts
FOR EACH ROW
EXECUTE FUNCTION public.update_updated_at_column();

-- === FILE: 20260209091540_ed56ade6-c706-47dc-9450-28f9af7164af.sql ===
-- Fix RLS policies for all tables to prevent public access

-- 1. profiles table - only own profile access
DROP POLICY IF EXISTS "Users can view own profile" ON public.profiles;
DROP POLICY IF EXISTS "Users can view their own profile" ON public.profiles;
CREATE POLICY "Users can view own profile" ON public.profiles FOR SELECT USING (auth.uid() = user_id);

-- 2. subscription_requests - only own requests
DROP POLICY IF EXISTS "Users can view own requests" ON public.subscription_requests;
DROP POLICY IF EXISTS "Users can view their requests" ON public.subscription_requests;
CREATE POLICY "Users can view own subscription requests" ON public.subscription_requests FOR SELECT USING (auth.uid() = user_id OR public.has_role(auth.uid(), 'admin'));

-- 3. chat_conversations - only own conversations
DROP POLICY IF EXISTS "Users can view own conversations" ON public.chat_conversations;
CREATE POLICY "Users can view own chat conversations" ON public.chat_conversations FOR SELECT USING (auth.uid() = user_id OR public.has_role(auth.uid(), 'admin'));

-- 4. provider_accounts - admin only
DROP POLICY IF EXISTS "Admin can manage provider accounts" ON public.provider_accounts;
DROP POLICY IF EXISTS "Admins can manage provider accounts" ON public.provider_accounts;
CREATE POLICY "Admin only access provider accounts" ON public.provider_accounts FOR ALL USING (public.has_role(auth.uid(), 'admin'));

-- 5. providers - admin only  
DROP POLICY IF EXISTS "Admin can manage providers" ON public.providers;
DROP POLICY IF EXISTS "Admins can manage providers" ON public.providers;
CREATE POLICY "Admin only access providers" ON public.providers FOR ALL USING (public.has_role(auth.uid(), 'admin'));

-- 6. orders - only own orders
DROP POLICY IF EXISTS "Users can view own orders" ON public.orders;
DROP POLICY IF EXISTS "Users can view their own orders" ON public.orders;
CREATE POLICY "Users can view own orders" ON public.orders FOR SELECT USING (auth.uid() = user_id OR public.has_role(auth.uid(), 'admin'));

-- 7. engagement_orders - only own orders
DROP POLICY IF EXISTS "Users can view own engagement orders" ON public.engagement_orders;
DROP POLICY IF EXISTS "Users can view their engagement orders" ON public.engagement_orders;
CREATE POLICY "Users can view own engagement orders" ON public.engagement_orders FOR SELECT USING (auth.uid() = user_id OR public.has_role(auth.uid(), 'admin'));

-- 8. transactions - only own transactions
DROP POLICY IF EXISTS "Users can view own transactions" ON public.transactions;
DROP POLICY IF EXISTS "Users can view their transactions" ON public.transactions;
CREATE POLICY "Users can view own transactions" ON public.transactions FOR SELECT USING (auth.uid() = user_id OR public.has_role(auth.uid(), 'admin'));

-- 9. wallets - only own wallet
DROP POLICY IF EXISTS "Users can view own wallet" ON public.wallets;
DROP POLICY IF EXISTS "Users can view their wallet" ON public.wallets;
CREATE POLICY "Users can view own wallet" ON public.wallets FOR SELECT USING (auth.uid() = user_id);

-- 10. support_tickets - only own tickets
DROP POLICY IF EXISTS "Users can view own tickets" ON public.support_tickets;
DROP POLICY IF EXISTS "Users can view their tickets" ON public.support_tickets;
CREATE POLICY "Users can view own support tickets" ON public.support_tickets FOR SELECT USING (auth.uid() = user_id OR public.has_role(auth.uid(), 'admin'));

-- 11. subscriptions - only own subscriptions
DROP POLICY IF EXISTS "Users can view own subscription" ON public.subscriptions;
DROP POLICY IF EXISTS "Users can view their subscription" ON public.subscriptions;
CREATE POLICY "Users can view own subscription" ON public.subscriptions FOR SELECT USING (auth.uid() = user_id OR public.has_role(auth.uid(), 'admin'));

-- 12. user_roles - admin only for viewing all, users can see own
DROP POLICY IF EXISTS "Users can view own role" ON public.user_roles;
CREATE POLICY "Users can view own role" ON public.user_roles FOR SELECT USING (auth.uid() = user_id OR public.has_role(auth.uid(), 'admin'));

-- 13. chat_messages - only participants can view
DROP POLICY IF EXISTS "Users can view conversation messages" ON public.chat_messages;
CREATE POLICY "Users can view own conversation messages" ON public.chat_messages FOR SELECT 
USING (
  EXISTS (
    SELECT 1 FROM public.chat_conversations 
    WHERE id = conversation_id 
    AND (user_id = auth.uid() OR public.has_role(auth.uid(), 'admin'))
  )
);

-- 14. engagement_order_items - only own items
DROP POLICY IF EXISTS "Users can view own items" ON public.engagement_order_items;
CREATE POLICY "Users can view own engagement order items" ON public.engagement_order_items FOR SELECT 
USING (
  EXISTS (
    SELECT 1 FROM public.engagement_orders 
    WHERE id = engagement_order_id 
    AND (user_id = auth.uid() OR public.has_role(auth.uid(), 'admin'))
  )
);

-- 15. organic_run_schedule - only own runs
DROP POLICY IF EXISTS "Users can view own runs" ON public.organic_run_schedule;
CREATE POLICY "Users can view own organic runs" ON public.organic_run_schedule FOR SELECT 
USING (
  EXISTS (
    SELECT 1 FROM public.orders WHERE id = order_id AND user_id = auth.uid()
  )
  OR
  EXISTS (
    SELECT 1 FROM public.engagement_order_items eoi
    JOIN public.engagement_orders eo ON eoi.engagement_order_id = eo.id
    WHERE eoi.id = engagement_order_item_id AND eo.user_id = auth.uid()
  )
  OR public.has_role(auth.uid(), 'admin')
);

-- === FILE: 20260209091744_7573599a-7af3-4909-b9c6-88d76abc7c91.sql ===
-- Add public read access for services and bundles (these are meant to be public)

-- Services table - everyone can view active services
DROP POLICY IF EXISTS "Anyone can view active services" ON public.services;
CREATE POLICY "Anyone can view active services" ON public.services FOR SELECT USING (is_active = true);

-- Admin can manage services
DROP POLICY IF EXISTS "Admin can manage services" ON public.services;
CREATE POLICY "Admin can manage all services" ON public.services FOR ALL USING (public.has_role(auth.uid(), 'admin'));

-- Engagement bundles - everyone can view active bundles
DROP POLICY IF EXISTS "Anyone can view active bundles" ON public.engagement_bundles;
CREATE POLICY "Anyone can view active bundles" ON public.engagement_bundles FOR SELECT USING (is_active = true);

-- Admin can manage bundles
DROP POLICY IF EXISTS "Admin can manage bundles" ON public.engagement_bundles;
CREATE POLICY "Admin can manage all bundles" ON public.engagement_bundles FOR ALL USING (public.has_role(auth.uid(), 'admin'));

-- Bundle items - everyone can view
DROP POLICY IF EXISTS "Anyone can view bundle items" ON public.bundle_items;
CREATE POLICY "Anyone can view bundle items" ON public.bundle_items FOR SELECT USING (true);

-- Admin can manage bundle items
DROP POLICY IF EXISTS "Admin can manage bundle items" ON public.bundle_items;
CREATE POLICY "Admin can manage all bundle items" ON public.bundle_items FOR ALL USING (public.has_role(auth.uid(), 'admin'));

-- Service provider mapping - admin only (contains sensitive provider info)
DROP POLICY IF EXISTS "Admin can manage service mappings" ON public.service_provider_mapping;
CREATE POLICY "Admin only service provider mapping" ON public.service_provider_mapping FOR ALL USING (public.has_role(auth.uid(), 'admin'));

-- === FILE: 20260209092203_34f0c018-c6e1-4f19-a2c7-b7a6343de275.sql ===
-- Clean up duplicate RLS policies to prevent conflicts

-- bundle_items - remove duplicates
DROP POLICY IF EXISTS "Admins can manage bundle items" ON public.bundle_items;
DROP POLICY IF EXISTS "Everyone can view bundle items" ON public.bundle_items;

-- engagement_bundles - remove duplicates  
DROP POLICY IF EXISTS "Admins can manage bundles" ON public.engagement_bundles;
DROP POLICY IF EXISTS "Everyone can view active bundles" ON public.engagement_bundles;

-- services - remove duplicates
DROP POLICY IF EXISTS "Admins can manage services" ON public.services;
DROP POLICY IF EXISTS "Everyone can view active services" ON public.services;

-- chat_conversations - remove duplicates
DROP POLICY IF EXISTS "Users can view their own conversations" ON public.chat_conversations;

-- chat_messages - remove duplicate
DROP POLICY IF EXISTS "Users can view messages in their conversations" ON public.chat_messages;

-- engagement_order_items - remove duplicate
DROP POLICY IF EXISTS "Users can view own order items" ON public.engagement_order_items;

-- organic_run_schedule - remove duplicates
DROP POLICY IF EXISTS "Users can view own order runs" ON public.organic_run_schedule;
DROP POLICY IF EXISTS "Users can view own engagement run schedules" ON public.organic_run_schedule;

-- user_roles - remove duplicate
DROP POLICY IF EXISTS "Users can view own roles" ON public.user_roles;

-- service_provider_mapping - remove duplicate
DROP POLICY IF EXISTS "Admins can manage service mappings" ON public.service_provider_mapping;

-- providers - remove duplicate
DROP POLICY IF EXISTS "Admins can view all provider details" ON public.providers;

-- === FILE: 20260209092313_e1f28282-21d4-45f7-bd72-b4a35d6f04d7.sql ===
-- Recreate all RLS policies as PERMISSIVE (drop and recreate)
-- This fixes the "no policies preventing unauthenticated access" warnings

-- profiles table
DROP POLICY IF EXISTS "Users can view own profile" ON public.profiles;
DROP POLICY IF EXISTS "Admins can view all profiles" ON public.profiles;
DROP POLICY IF EXISTS "Users can insert own profile" ON public.profiles;
DROP POLICY IF EXISTS "Users can update own profile" ON public.profiles;

CREATE POLICY "Users can view own profile" ON public.profiles FOR SELECT TO authenticated USING (auth.uid() = user_id);
CREATE POLICY "Admins can view all profiles" ON public.profiles FOR SELECT TO authenticated USING (public.has_role(auth.uid(), 'admin'));
CREATE POLICY "Users can insert own profile" ON public.profiles FOR INSERT TO authenticated WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Users can update own profile" ON public.profiles FOR UPDATE TO authenticated USING (auth.uid() = user_id);

-- chat_conversations table
DROP POLICY IF EXISTS "Users can view own chat conversations" ON public.chat_conversations;
DROP POLICY IF EXISTS "Admins can view all conversations" ON public.chat_conversations;
DROP POLICY IF EXISTS "Admins can update all conversations" ON public.chat_conversations;
DROP POLICY IF EXISTS "Users can create their own conversations" ON public.chat_conversations;
DROP POLICY IF EXISTS "Users can update their own conversations" ON public.chat_conversations;

CREATE POLICY "Users can view own conversations" ON public.chat_conversations FOR SELECT TO authenticated USING (auth.uid() = user_id OR public.has_role(auth.uid(), 'admin'));
CREATE POLICY "Users can create conversations" ON public.chat_conversations FOR INSERT TO authenticated WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Users can update conversations" ON public.chat_conversations FOR UPDATE TO authenticated USING (auth.uid() = user_id OR public.has_role(auth.uid(), 'admin'));

-- subscription_requests table
DROP POLICY IF EXISTS "Users can view own subscription requests" ON public.subscription_requests;
DROP POLICY IF EXISTS "Admins can manage all requests" ON public.subscription_requests;
DROP POLICY IF EXISTS "Users can create own requests" ON public.subscription_requests;

CREATE POLICY "Users can view own requests" ON public.subscription_requests FOR SELECT TO authenticated USING (auth.uid() = user_id OR public.has_role(auth.uid(), 'admin'));
CREATE POLICY "Users can create requests" ON public.subscription_requests FOR INSERT TO authenticated WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Admins can manage requests" ON public.subscription_requests FOR ALL TO authenticated USING (public.has_role(auth.uid(), 'admin'));

-- providers table
DROP POLICY IF EXISTS "Admin only access providers" ON public.providers;
CREATE POLICY "Admin only providers" ON public.providers FOR ALL TO authenticated USING (public.has_role(auth.uid(), 'admin'));

-- provider_accounts table
DROP POLICY IF EXISTS "Admin only access provider accounts" ON public.provider_accounts;
CREATE POLICY "Admin only provider_accounts" ON public.provider_accounts FOR ALL TO authenticated USING (public.has_role(auth.uid(), 'admin'));

-- orders table
DROP POLICY IF EXISTS "Users can view own orders" ON public.orders;
DROP POLICY IF EXISTS "Admins can manage all orders" ON public.orders;
DROP POLICY IF EXISTS "Users can create own orders" ON public.orders;

CREATE POLICY "Users view own orders" ON public.orders FOR SELECT TO authenticated USING (auth.uid() = user_id OR public.has_role(auth.uid(), 'admin'));
CREATE POLICY "Users create own orders" ON public.orders FOR INSERT TO authenticated WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Admins manage orders" ON public.orders FOR ALL TO authenticated USING (public.has_role(auth.uid(), 'admin'));

-- engagement_orders table
DROP POLICY IF EXISTS "Users can view own engagement orders" ON public.engagement_orders;
DROP POLICY IF EXISTS "Admins can manage all engagement orders" ON public.engagement_orders;
DROP POLICY IF EXISTS "Users can create own engagement orders" ON public.engagement_orders;

CREATE POLICY "Users view own engagement_orders" ON public.engagement_orders FOR SELECT TO authenticated USING (auth.uid() = user_id OR public.has_role(auth.uid(), 'admin'));
CREATE POLICY "Users create own engagement_orders" ON public.engagement_orders FOR INSERT TO authenticated WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Admins manage engagement_orders" ON public.engagement_orders FOR ALL TO authenticated USING (public.has_role(auth.uid(), 'admin'));

-- transactions table
DROP POLICY IF EXISTS "Users can view own transactions" ON public.transactions;
DROP POLICY IF EXISTS "Admins can manage all transactions" ON public.transactions;
DROP POLICY IF EXISTS "Users can insert own transactions" ON public.transactions;

CREATE POLICY "Users view own transactions" ON public.transactions FOR SELECT TO authenticated USING (auth.uid() = user_id OR public.has_role(auth.uid(), 'admin'));
CREATE POLICY "Users insert own transactions" ON public.transactions FOR INSERT TO authenticated WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Admins manage transactions" ON public.transactions FOR ALL TO authenticated USING (public.has_role(auth.uid(), 'admin'));

-- wallets table
DROP POLICY IF EXISTS "Users can view own wallet" ON public.wallets;
DROP POLICY IF EXISTS "Admins can manage all wallets" ON public.wallets;
DROP POLICY IF EXISTS "Users can update own wallet" ON public.wallets;

CREATE POLICY "Users view own wallet" ON public.wallets FOR SELECT TO authenticated USING (auth.uid() = user_id);
CREATE POLICY "Users update own wallet" ON public.wallets FOR UPDATE TO authenticated USING (auth.uid() = user_id);
CREATE POLICY "Admins manage wallets" ON public.wallets FOR ALL TO authenticated USING (public.has_role(auth.uid(), 'admin'));

-- support_tickets table
DROP POLICY IF EXISTS "Users can view own support tickets" ON public.support_tickets;
DROP POLICY IF EXISTS "Admins can manage all tickets" ON public.support_tickets;
DROP POLICY IF EXISTS "Users can create own tickets" ON public.support_tickets;

CREATE POLICY "Users view own tickets" ON public.support_tickets FOR SELECT TO authenticated USING (auth.uid() = user_id OR public.has_role(auth.uid(), 'admin'));
CREATE POLICY "Users create own tickets" ON public.support_tickets FOR INSERT TO authenticated WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Admins manage tickets" ON public.support_tickets FOR ALL TO authenticated USING (public.has_role(auth.uid(), 'admin'));

-- subscriptions table
DROP POLICY IF EXISTS "Users can view own subscription" ON public.subscriptions;
DROP POLICY IF EXISTS "Admins can manage all subscriptions" ON public.subscriptions;

CREATE POLICY "Users view own subscription" ON public.subscriptions FOR SELECT TO authenticated USING (auth.uid() = user_id OR public.has_role(auth.uid(), 'admin'));
CREATE POLICY "Admins manage subscriptions" ON public.subscriptions FOR ALL TO authenticated USING (public.has_role(auth.uid(), 'admin'));

-- user_roles table
DROP POLICY IF EXISTS "Users can view own role" ON public.user_roles;
DROP POLICY IF EXISTS "Admins can manage all roles" ON public.user_roles;

CREATE POLICY "Users view own role" ON public.user_roles FOR SELECT TO authenticated USING (auth.uid() = user_id OR public.has_role(auth.uid(), 'admin'));
CREATE POLICY "Admins manage roles" ON public.user_roles FOR ALL TO authenticated USING (public.has_role(auth.uid(), 'admin'));

-- === FILE: 20260209092911_7a05ba9f-5e2f-4e00-9a6e-66850a1f5a69.sql ===
-- Fix 1: Profiles Table - Only authenticated users can access
DROP POLICY IF EXISTS "Admins can view all profiles" ON public.profiles;
DROP POLICY IF EXISTS "Users can view own profile" ON public.profiles;

-- Users can only view their own profile (authenticated only)
CREATE POLICY "Users can view own profile" 
ON public.profiles FOR SELECT TO authenticated
USING (auth.uid() = user_id);

-- Admins can view all profiles (authenticated only)  
CREATE POLICY "Admins can view all profiles"
ON public.profiles FOR SELECT TO authenticated
USING (public.has_role(auth.uid(), 'admin'));

-- Fix 2: Providers Public View - Enable security invoker
ALTER VIEW public.providers_public SET (security_invoker = on);

-- === FILE: 20260209093031_081cf525-25e9-4c2a-9610-2718d67e3bc1.sql ===
-- Comprehensive fix: Ensure all SELECT policies have "TO authenticated" clause
-- This prevents anonymous/unauthenticated access to any table

-- ========== PROFILES ==========
-- (Already fixed in previous migration)

-- ========== CHAT_CONVERSATIONS ==========
DROP POLICY IF EXISTS "Users can view own conversations" ON public.chat_conversations;
CREATE POLICY "Users can view own conversations" 
ON public.chat_conversations FOR SELECT TO authenticated
USING ((auth.uid() = user_id) OR public.has_role(auth.uid(), 'admin'));

-- ========== CHAT_MESSAGES ==========
DROP POLICY IF EXISTS "Users can view own conversation messages" ON public.chat_messages;
DROP POLICY IF EXISTS "Admins can view all messages" ON public.chat_messages;

CREATE POLICY "Users can view own conversation messages" 
ON public.chat_messages FOR SELECT TO authenticated
USING (EXISTS (
  SELECT 1 FROM chat_conversations
  WHERE chat_conversations.id = chat_messages.conversation_id
  AND (chat_conversations.user_id = auth.uid() OR public.has_role(auth.uid(), 'admin'))
));

CREATE POLICY "Admins can view all messages" 
ON public.chat_messages FOR SELECT TO authenticated
USING (public.has_role(auth.uid(), 'admin'));

-- ========== SUBSCRIPTION_REQUESTS ==========
DROP POLICY IF EXISTS "Users can view own requests" ON public.subscription_requests;
CREATE POLICY "Users can view own requests" 
ON public.subscription_requests FOR SELECT TO authenticated
USING ((auth.uid() = user_id) OR public.has_role(auth.uid(), 'admin'));

-- ========== WALLETS ==========
DROP POLICY IF EXISTS "Users view own wallet" ON public.wallets;
CREATE POLICY "Users view own wallet" 
ON public.wallets FOR SELECT TO authenticated
USING (auth.uid() = user_id);

-- ========== TRANSACTIONS ==========
DROP POLICY IF EXISTS "Users view own transactions" ON public.transactions;
CREATE POLICY "Users view own transactions" 
ON public.transactions FOR SELECT TO authenticated
USING ((auth.uid() = user_id) OR public.has_role(auth.uid(), 'admin'));

-- ========== ORDERS ==========
DROP POLICY IF EXISTS "Users view own orders" ON public.orders;
CREATE POLICY "Users view own orders" 
ON public.orders FOR SELECT TO authenticated
USING ((auth.uid() = user_id) OR public.has_role(auth.uid(), 'admin'));

-- ========== ENGAGEMENT_ORDERS ==========
DROP POLICY IF EXISTS "Users view own engagement_orders" ON public.engagement_orders;
CREATE POLICY "Users view own engagement_orders" 
ON public.engagement_orders FOR SELECT TO authenticated
USING ((auth.uid() = user_id) OR public.has_role(auth.uid(), 'admin'));

-- ========== ENGAGEMENT_ORDER_ITEMS ==========
DROP POLICY IF EXISTS "Users can view own engagement order items" ON public.engagement_order_items;
CREATE POLICY "Users can view own engagement order items" 
ON public.engagement_order_items FOR SELECT TO authenticated
USING (EXISTS (
  SELECT 1 FROM engagement_orders
  WHERE engagement_orders.id = engagement_order_items.engagement_order_id
  AND (engagement_orders.user_id = auth.uid() OR public.has_role(auth.uid(), 'admin'))
));

-- ========== SUPPORT_TICKETS ==========
DROP POLICY IF EXISTS "Users view own tickets" ON public.support_tickets;
CREATE POLICY "Users view own tickets" 
ON public.support_tickets FOR SELECT TO authenticated
USING ((auth.uid() = user_id) OR public.has_role(auth.uid(), 'admin'));

-- ========== SUBSCRIPTIONS ==========
DROP POLICY IF EXISTS "Users view own subscription" ON public.subscriptions;
CREATE POLICY "Users view own subscription" 
ON public.subscriptions FOR SELECT TO authenticated
USING ((auth.uid() = user_id) OR public.has_role(auth.uid(), 'admin'));

-- ========== USER_ROLES ==========
DROP POLICY IF EXISTS "Users view own role" ON public.user_roles;
CREATE POLICY "Users view own role" 
ON public.user_roles FOR SELECT TO authenticated
USING ((auth.uid() = user_id) OR public.has_role(auth.uid(), 'admin'));

-- ========== ORGANIC_RUN_SCHEDULE ==========
DROP POLICY IF EXISTS "Users can view own organic runs" ON public.organic_run_schedule;
CREATE POLICY "Users can view own organic runs" 
ON public.organic_run_schedule FOR SELECT TO authenticated
USING (
  (EXISTS (SELECT 1 FROM orders WHERE orders.id = organic_run_schedule.order_id AND orders.user_id = auth.uid()))
  OR (EXISTS (
    SELECT 1 FROM engagement_order_items eoi
    JOIN engagement_orders eo ON eoi.engagement_order_id = eo.id
    WHERE eoi.id = organic_run_schedule.engagement_order_item_id AND eo.user_id = auth.uid()
  ))
  OR public.has_role(auth.uid(), 'admin')
);

-- === FILE: 20260209093150_927e3438-4185-4bd2-b9a7-0558b7fa8937.sql ===
-- Add RESTRICTIVE policies to explicitly deny anonymous/unauthenticated access
-- Correct syntax: CREATE POLICY name ON table AS RESTRICTIVE FOR command TO role USING (...)

-- ========== PROFILES ==========
CREATE POLICY "Deny anonymous access to profiles" 
ON public.profiles 
AS RESTRICTIVE 
FOR SELECT 
TO public
USING (auth.uid() IS NOT NULL);

-- ========== CHAT_CONVERSATIONS ==========
CREATE POLICY "Deny anonymous access to chat_conversations" 
ON public.chat_conversations 
AS RESTRICTIVE 
FOR SELECT 
TO public
USING (auth.uid() IS NOT NULL);

-- ========== CHAT_MESSAGES ==========
CREATE POLICY "Deny anonymous access to chat_messages" 
ON public.chat_messages 
AS RESTRICTIVE 
FOR SELECT 
TO public
USING (auth.uid() IS NOT NULL);

-- ========== SUBSCRIPTION_REQUESTS ==========
CREATE POLICY "Deny anonymous access to subscription_requests" 
ON public.subscription_requests 
AS RESTRICTIVE 
FOR SELECT 
TO public
USING (auth.uid() IS NOT NULL);

-- ========== WALLETS ==========
CREATE POLICY "Deny anonymous access to wallets" 
ON public.wallets 
AS RESTRICTIVE 
FOR SELECT 
TO public
USING (auth.uid() IS NOT NULL);

-- ========== TRANSACTIONS ==========
CREATE POLICY "Deny anonymous access to transactions" 
ON public.transactions 
AS RESTRICTIVE 
FOR SELECT 
TO public
USING (auth.uid() IS NOT NULL);

-- ========== ORDERS ==========
CREATE POLICY "Deny anonymous access to orders" 
ON public.orders 
AS RESTRICTIVE 
FOR SELECT 
TO public
USING (auth.uid() IS NOT NULL);

-- ========== ENGAGEMENT_ORDERS ==========
CREATE POLICY "Deny anonymous access to engagement_orders" 
ON public.engagement_orders 
AS RESTRICTIVE 
FOR SELECT 
TO public
USING (auth.uid() IS NOT NULL);

-- ========== ENGAGEMENT_ORDER_ITEMS ==========
CREATE POLICY "Deny anonymous access to engagement_order_items" 
ON public.engagement_order_items 
AS RESTRICTIVE 
FOR SELECT 
TO public
USING (auth.uid() IS NOT NULL);

-- ========== SUPPORT_TICKETS ==========
CREATE POLICY "Deny anonymous access to support_tickets" 
ON public.support_tickets 
AS RESTRICTIVE 
FOR SELECT 
TO public
USING (auth.uid() IS NOT NULL);

-- ========== SUBSCRIPTIONS ==========
CREATE POLICY "Deny anonymous access to subscriptions" 
ON public.subscriptions 
AS RESTRICTIVE 
FOR SELECT 
TO public
USING (auth.uid() IS NOT NULL);

-- ========== USER_ROLES ==========
CREATE POLICY "Deny anonymous access to user_roles" 
ON public.user_roles 
AS RESTRICTIVE 
FOR SELECT 
TO public
USING (auth.uid() IS NOT NULL);

-- ========== ORGANIC_RUN_SCHEDULE ==========
CREATE POLICY "Deny anonymous access to organic_run_schedule" 
ON public.organic_run_schedule 
AS RESTRICTIVE 
FOR SELECT 
TO public
USING (auth.uid() IS NOT NULL);

-- === FILE: 20260210135923_e1cbf44a-979f-4ede-a784-911360610379.sql ===

-- =============================================
-- PERFORMANCE INDEXES FOR 10,000+ CONCURRENT USERS
-- =============================================

-- Orders: Most frequently queried table
CREATE INDEX IF NOT EXISTS idx_orders_user_id ON public.orders(user_id);
CREATE INDEX IF NOT EXISTS idx_orders_status ON public.orders(status);
CREATE INDEX IF NOT EXISTS idx_orders_user_status ON public.orders(user_id, status);
CREATE INDEX IF NOT EXISTS idx_orders_created_at ON public.orders(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_orders_is_organic ON public.orders(is_organic_mode) WHERE is_organic_mode = true;

-- Organic Run Schedule: Heavy read/write during cron execution
CREATE INDEX IF NOT EXISTS idx_organic_runs_order_status ON public.organic_run_schedule(order_id, status);
CREATE INDEX IF NOT EXISTS idx_organic_runs_status_scheduled ON public.organic_run_schedule(status, scheduled_at) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_organic_runs_started ON public.organic_run_schedule(status) WHERE status = 'started';
CREATE INDEX IF NOT EXISTS idx_organic_runs_engagement_item ON public.organic_run_schedule(engagement_order_item_id);

-- Transactions: Wallet history lookups
CREATE INDEX IF NOT EXISTS idx_transactions_user_id ON public.transactions(user_id);
CREATE INDEX IF NOT EXISTS idx_transactions_user_created ON public.transactions(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_transactions_type ON public.transactions(type);

-- Wallets: Balance lookups
CREATE INDEX IF NOT EXISTS idx_wallets_user_id ON public.wallets(user_id);

-- Profiles: Auth lookups
CREATE INDEX IF NOT EXISTS idx_profiles_user_id ON public.profiles(user_id);

-- Engagement Orders
CREATE INDEX IF NOT EXISTS idx_engagement_orders_user ON public.engagement_orders(user_id);
CREATE INDEX IF NOT EXISTS idx_engagement_orders_status ON public.engagement_orders(status);
CREATE INDEX IF NOT EXISTS idx_engagement_order_items_order ON public.engagement_order_items(engagement_order_id);
CREATE INDEX IF NOT EXISTS idx_engagement_order_items_status ON public.engagement_order_items(status);

-- Services: Browsing
CREATE INDEX IF NOT EXISTS idx_services_active ON public.services(is_active) WHERE is_active = true;
CREATE INDEX IF NOT EXISTS idx_services_category ON public.services(category);

-- Subscriptions: Auth guard checks
CREATE INDEX IF NOT EXISTS idx_subscriptions_user ON public.subscriptions(user_id);
CREATE INDEX IF NOT EXISTS idx_subscriptions_user_status ON public.subscriptions(user_id, status);

-- User Roles: Permission checks (called on every request)
CREATE INDEX IF NOT EXISTS idx_user_roles_user ON public.user_roles(user_id);
CREATE INDEX IF NOT EXISTS idx_user_roles_user_role ON public.user_roles(user_id, role);

-- Chat: Real-time lookups
CREATE INDEX IF NOT EXISTS idx_chat_conversations_user ON public.chat_conversations(user_id);
CREATE INDEX IF NOT EXISTS idx_chat_messages_conversation ON public.chat_messages(conversation_id, created_at DESC);

-- Service Provider Mapping
CREATE INDEX IF NOT EXISTS idx_spm_service ON public.service_provider_mapping(service_id) WHERE is_active = true;

-- Support Tickets
CREATE INDEX IF NOT EXISTS idx_support_tickets_user ON public.support_tickets(user_id);

-- === FILE: 20260212120818_17156e36-983a-4298-879a-d8e4aa639010.sql ===

CREATE POLICY "Users can update own order items"
ON public.engagement_order_items FOR UPDATE
USING (
  EXISTS (
    SELECT 1 FROM engagement_orders
    WHERE engagement_orders.id = engagement_order_items.engagement_order_id
    AND engagement_orders.user_id = auth.uid()
  )
);

-- === FILE: 20260212124715_19a17a9f-d4f6-4d9e-871a-051e1f6b4026.sql ===

-- Update handle_new_user to auto-create 7-day trial subscription
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
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
  
  -- Auto-create 7-day free trial subscription
  INSERT INTO public.subscriptions (user_id, plan_type, status, activated_at, expires_at)
  VALUES (NEW.id, 'trial', 'active', now(), now() + interval '7 days')
  ON CONFLICT (user_id) DO UPDATE 
  SET plan_type = 'trial', 
      status = 'active', 
      activated_at = now(), 
      expires_at = now() + interval '7 days'
  WHERE subscriptions.status = 'inactive' AND subscriptions.plan_type = 'none';
  
  RETURN NEW;
END;
$$;

-- Also update create_user_subscription to default to trial
CREATE OR REPLACE FUNCTION public.create_user_subscription()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  INSERT INTO public.subscriptions (user_id, plan_type, status, activated_at, expires_at)
  VALUES (NEW.id, 'trial', 'active', now(), now() + interval '7 days')
  ON CONFLICT (user_id) DO NOTHING;
  RETURN NEW;
END;
$$;

-- === FILE: 20260212125910_6362ef06-0309-43d5-b69b-c3b248205ec6.sql ===

-- Create platform_settings table for global admin configurations
CREATE TABLE public.platform_settings (
  id TEXT PRIMARY KEY DEFAULT 'global',
  global_markup_percent NUMERIC NOT NULL DEFAULT 0,
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_by UUID REFERENCES auth.users(id)
);

-- Insert default row
INSERT INTO public.platform_settings (id, global_markup_percent) VALUES ('global', 0);

-- Enable RLS
ALTER TABLE public.platform_settings ENABLE ROW LEVEL SECURITY;

-- Everyone can read settings (needed for price display)
CREATE POLICY "Anyone can read platform settings"
ON public.platform_settings FOR SELECT
USING (true);

-- Only admins can update
CREATE POLICY "Only admins can update platform settings"
ON public.platform_settings FOR UPDATE
USING (public.has_role(auth.uid(), 'admin'));

-- === FILE: 20260212131514_832a8987-4912-46a8-b264-9859349a7401.sql ===
ALTER TABLE public.platform_settings ADD COLUMN maintenance_mode boolean NOT NULL DEFAULT false;

-- === FILE: 20260212132136_d9873cab-4a0f-4a22-9de4-581b2371e7d6.sql ===
ALTER PUBLICATION supabase_realtime ADD TABLE public.platform_settings;

-- === FILE: 20260212144537_c4c513aa-cf59-42da-8fa2-df4d86b26ffa.sql ===

-- Create a public view that hides sensitive api_key
CREATE VIEW public.provider_accounts_public
WITH (security_invoker = on) AS
  SELECT id, name, provider_id, is_active, created_at
  FROM public.provider_accounts;

-- Allow all authenticated users to SELECT from the view via base table
-- But ONLY through the view (which excludes api_key)
CREATE POLICY "Authenticated users can view provider account names"
  ON public.provider_accounts
  FOR SELECT
  TO authenticated
  USING (true);

-- === FILE: 20260212144554_aea8b70b-3bec-4206-8d34-bee472b3a5fc.sql ===

-- Drop the broad SELECT policy (too permissive - exposes api_key)
DROP POLICY "Authenticated users can view provider account names" ON public.provider_accounts;

-- === FILE: 20260212144605_f78fd674-09e3-4304-96b3-a6e75936282b.sql ===

-- Add a column to organic_run_schedule to cache provider account name
-- This way users can see it without needing access to provider_accounts table
ALTER TABLE public.organic_run_schedule 
ADD COLUMN IF NOT EXISTS provider_account_name text;

-- Backfill existing data
UPDATE public.organic_run_schedule ors
SET provider_account_name = pa.name
FROM public.provider_accounts pa
WHERE ors.provider_account_id = pa.id
AND ors.provider_account_name IS NULL;

-- === FILE: 20260212144615_605a845c-9184-4928-a18c-55c3d4a957cd.sql ===
DROP VIEW IF EXISTS public.provider_accounts_public;

-- === FILE: 20260213130756_7720fed2-bbe6-4d77-967d-785182980c7a.sql ===
-- Drop the old check constraint and recreate with 'trial' included
ALTER TABLE public.subscriptions DROP CONSTRAINT subscriptions_plan_type_check;
ALTER TABLE public.subscriptions ADD CONSTRAINT subscriptions_plan_type_check CHECK (plan_type = ANY (ARRAY['none'::text, 'monthly'::text, 'lifetime'::text, 'trial'::text]));

-- === FILE: 20260223_fix_yoyo_provider_key.sql ===
-- Update yoyo provider API key and URL
UPDATE provider_accounts 
SET 
  api_key = '1bf4919406baace233cda2aa0cd195d8e28a92c14cd2f082bb7e1b4f0411a862',
  api_url = 'https://yoyomedia.in/api/v2'
WHERE name ILIKE '%yoyo%' OR provider_id ILIKE '%yoyo%';

UPDATE providers 
SET 
  api_key = '1bf4919406baace233cda2aa0cd195d8e28a92c14cd2f082bb7e1b4f0411a862',
  api_url = 'https://yoyomedia.in/api/v2'
WHERE name ILIKE '%yoyo%' OR id ILIKE '%yoyo%';

