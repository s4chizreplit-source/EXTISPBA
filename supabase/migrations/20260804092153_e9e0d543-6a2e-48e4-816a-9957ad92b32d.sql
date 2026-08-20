CREATE INDEX IF NOT EXISTS idx_orders_user_created_desc ON public.orders(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_engagement_orders_user_created_desc ON public.engagement_orders(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_organic_runs_pending_last_check ON public.organic_run_schedule(last_status_check, scheduled_at) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_organic_runs_failed_completed ON public.organic_run_schedule(completed_at) WHERE status = 'failed';