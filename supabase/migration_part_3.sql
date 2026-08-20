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
