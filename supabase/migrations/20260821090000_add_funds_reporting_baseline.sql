-- Admin-only reporting baseline for the historical "Total Funds Added" metric.
-- This deliberately does not alter wallet balances or transaction history.
ALTER TABLE public.platform_settings
  ADD COLUMN IF NOT EXISTS funds_added_baseline_inr numeric(14, 2),
  ADD COLUMN IF NOT EXISTS funds_added_baseline_count integer,
  ADD COLUMN IF NOT EXISTS funds_added_baseline_at timestamptz;