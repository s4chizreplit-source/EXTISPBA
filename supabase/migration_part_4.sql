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
-- [REMOVED: Old provider keys - set up providers from admin panel]

