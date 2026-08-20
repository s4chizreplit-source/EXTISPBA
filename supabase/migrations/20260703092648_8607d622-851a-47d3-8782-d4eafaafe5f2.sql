
-- =========================================================
-- HIGH-SCALE PERFORMANCE INDEXES
-- Tuned to the top pg_stat_statements queries.
-- All are partial / composite / covering to keep hot paths
-- on index-only or narrow-scan plans as row counts grow.
-- =========================================================

-- Cron: "pending engagement runs due to fire"
CREATE INDEX IF NOT EXISTS idx_orschd_pending_due_engagement
  ON public.organic_run_schedule (scheduled_at, last_status_check NULLS FIRST)
  WHERE status = 'pending' AND engagement_order_item_id IS NOT NULL;

-- Cron: "pending runs" broad list scans (very frequent)
CREATE INDEX IF NOT EXISTS idx_orschd_pending_scheduled
  ON public.organic_run_schedule (scheduled_at)
  WHERE status = 'pending';

-- Cron: "processing runs, order by completed_at ASC, engagement only"
CREATE INDEX IF NOT EXISTS idx_orschd_processing_completed
  ON public.organic_run_schedule (completed_at)
  WHERE status = 'processing' AND engagement_order_item_id IS NOT NULL;

-- Cron: "processing runs with retry cap"
CREATE INDEX IF NOT EXISTS idx_orschd_processing_retry
  ON public.organic_run_schedule (retry_count, completed_at)
  WHERE status = 'processing' AND engagement_order_item_id IS NOT NULL;

-- Cron: status-poll pass ("processing runs recently polled")
CREATE INDEX IF NOT EXISTS idx_orschd_processing_lastcheck
  ON public.organic_run_schedule (last_status_check)
  WHERE status = 'processing';

-- Cron: "processing runs with provider_order_id (poll targets)"
CREATE INDEX IF NOT EXISTS idx_orschd_processing_provider
  ON public.organic_run_schedule (provider_status, last_status_check)
  WHERE status = 'processing' AND provider_order_id IS NOT NULL;

-- Cron: "started_at < X" stuck-run sweeper
CREATE INDEX IF NOT EXISTS idx_orschd_processing_started
  ON public.organic_run_schedule (started_at NULLS FIRST)
  WHERE status = 'processing';

-- Cron: orders in pending/processing filtered by organic mode
CREATE INDEX IF NOT EXISTS idx_orders_organic_status
  ON public.orders (status, is_organic_mode)
  WHERE status IN ('pending','processing');

-- Fast lookup by link for repeat/refill queries and dedup
CREATE INDEX IF NOT EXISTS idx_orders_link
  ON public.orders (link text_pattern_ops);

-- Engagement orders: pending/processing sweep
CREATE INDEX IF NOT EXISTS idx_engagement_orders_active
  ON public.engagement_orders (status, created_at DESC)
  WHERE status IN ('pending','processing');

-- Engagement orders: search-by-link (LIKE prefix / equality)
CREATE INDEX IF NOT EXISTS idx_engagement_orders_link
  ON public.engagement_orders (link text_pattern_ops);

-- Engagement order items: hot foreign-key + status filter
CREATE INDEX IF NOT EXISTS idx_eoi_order_status
  ON public.engagement_order_items (engagement_order_id, status);

-- Health history: fast per-order write throughput needs a lean index;
-- trim old bloat by covering recorded_at range scans.
CREATE INDEX IF NOT EXISTS idx_eng_health_recent
  ON public.engagement_health_history (recorded_at DESC);

-- Transactions: per-user wallet history is queried on every dashboard load
CREATE INDEX IF NOT EXISTS idx_transactions_user_type_created
  ON public.transactions (user_id, type, created_at DESC);

-- Transactions: order lookup for refunds / receipts
CREATE INDEX IF NOT EXISTS idx_transactions_order_id
  ON public.transactions (order_id)
  WHERE order_id IS NOT NULL;

-- ZapUPI deposits: webhook idempotency (order_id lookup) + user history
CREATE INDEX IF NOT EXISTS idx_zapupi_deposits_order
  ON public.zapupi_deposits (order_id);
CREATE INDEX IF NOT EXISTS idx_zapupi_deposits_user_created
  ON public.zapupi_deposits (user_id, created_at DESC);

-- Instagram media: per-account timeline scans
CREATE INDEX IF NOT EXISTS idx_ig_media_user_posted
  ON public.instagram_media (user_id, posted_at DESC NULLS LAST);

-- Subscription gate: read-heavy per user
CREATE INDEX IF NOT EXISTS idx_subscriptions_status
  ON public.subscriptions (user_id, status);

-- Referrals lookup used by set_referrer_by_code (case-insensitive)
CREATE INDEX IF NOT EXISTS idx_profiles_referral_code_upper
  ON public.profiles ((upper(referral_code)))
  WHERE referral_code IS NOT NULL;

-- Refresh planner statistics on the busiest tables so the new
-- indexes get picked up immediately.
ANALYZE public.organic_run_schedule;
ANALYZE public.orders;
ANALYZE public.engagement_orders;
ANALYZE public.engagement_order_items;
ANALYZE public.transactions;
ANALYZE public.engagement_health_history;
ANALYZE public.instagram_media;
ANALYZE public.zapupi_deposits;
ANALYZE public.subscriptions;
ANALYZE public.profiles;
