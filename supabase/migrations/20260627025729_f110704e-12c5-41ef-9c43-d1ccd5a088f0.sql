
-- Drop user-write policies on financial tables (defense in depth — even if grants exist, no policy = no access)

-- deposits
DROP POLICY IF EXISTS "Users create deposits" ON public.deposits;

-- orders
DROP POLICY IF EXISTS "Users create own orders" ON public.orders;

-- engagement_orders
DROP POLICY IF EXISTS "Users create own engagement_orders" ON public.engagement_orders;
DROP POLICY IF EXISTS "Users can update own engagement_orders status" ON public.engagement_orders;

-- engagement_order_items
DROP POLICY IF EXISTS "Users create own order items" ON public.engagement_order_items;
DROP POLICY IF EXISTS "Users can update own engagement_order_items status" ON public.engagement_order_items;

-- organic_run_schedule
DROP POLICY IF EXISTS "Users insert runs for own engagement orders" ON public.organic_run_schedule;
DROP POLICY IF EXISTS "Users update own pending runs" ON public.organic_run_schedule;

-- transactions
DROP POLICY IF EXISTS "Users create own deposit transactions" ON public.transactions;

-- wallets
DROP POLICY IF EXISTS "Users insert own wallet" ON public.wallets;
