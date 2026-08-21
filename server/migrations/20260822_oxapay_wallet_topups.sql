-- OxaPay wallet top-up schema.
--
-- This migration is intentionally compatible with both the imported
-- auth_users schema used by the current app and the legacy users schema
-- created by 001_init.sql. Replit Publish carries the development schema
-- diff to production.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- Align the legacy transaction table with the current payment ledger contract.
ALTER TABLE transactions
  ADD COLUMN IF NOT EXISTS status text DEFAULT 'pending',
  ADD COLUMN IF NOT EXISTS payment_method text,
  ADD COLUMN IF NOT EXISTS payment_reference text;

CREATE TABLE IF NOT EXISTS oxapay_deposits (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  purpose text NOT NULL DEFAULT 'wallet',
  plan_type text,
  track_id text,
  order_id text NOT NULL,
  pay_link text,
  amount_usd numeric(12,4) NOT NULL,
  amount_inr numeric(12,2),
  status text NOT NULL DEFAULT 'pending',
  credited boolean NOT NULL DEFAULT false,
  raw_response jsonb,
  webhook_payload jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  email text
);

CREATE UNIQUE INDEX IF NOT EXISTS oxapay_deposits_order_id_key
  ON oxapay_deposits (order_id);
CREATE UNIQUE INDEX IF NOT EXISTS oxapay_deposits_track_id_key
  ON oxapay_deposits (track_id);
CREATE INDEX IF NOT EXISTS idx_oxapay_deposits_user
  ON oxapay_deposits (user_id);
CREATE INDEX IF NOT EXISTS idx_oxapay_deposits_status
  ON oxapay_deposits (status);

CREATE TABLE IF NOT EXISTS webhook_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider text NOT NULL,
  order_id text NOT NULL,
  track_id text,
  payload_hash text NOT NULL,
  event_status text,
  outcome text NOT NULL DEFAULT 'received',
  http_status integer,
  message text,
  payload jsonb,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS webhook_events_provider_order_hash_uniq
  ON webhook_events (provider, order_id, payload_hash);
CREATE UNIQUE INDEX IF NOT EXISTS webhook_events_provider_track_status_uniq
  ON webhook_events (provider, track_id, event_status)
  WHERE track_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS webhook_events_provider_order_idx
  ON webhook_events (provider, order_id);
CREATE INDEX IF NOT EXISTS webhook_events_first_seen_idx
  ON webhook_events (first_seen_at DESC);

CREATE TABLE IF NOT EXISTS oxapay_activity_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at timestamptz NOT NULL DEFAULT now(),
  source text NOT NULL,
  event text NOT NULL,
  order_id text,
  user_id uuid,
  plan_type text,
  purpose text,
  amount_usd numeric(12,4),
  provider_status text,
  http_status integer,
  ok boolean NOT NULL DEFAULT true,
  message text,
  payload jsonb
);

CREATE INDEX IF NOT EXISTS oxapay_activity_log_created_at_idx
  ON oxapay_activity_log (created_at DESC);
CREATE INDEX IF NOT EXISTS oxapay_activity_log_order_id_idx
  ON oxapay_activity_log (order_id);
CREATE INDEX IF NOT EXISTS oxapay_activity_log_source_idx
  ON oxapay_activity_log (source);

-- The deposit lock is the primary idempotency guard. This partial unique index
-- is an independent ledger-level defense against accidental duplicate credits.
CREATE UNIQUE INDEX IF NOT EXISTS idx_transactions_oxapay_reference_uniq
  ON transactions (payment_reference)
  WHERE payment_method = 'oxapay' AND payment_reference IS NOT NULL;

-- Attach user ownership to whichever user table this schema provides.
DO $$
DECLARE
  user_table regclass;
BEGIN
  user_table := COALESCE(to_regclass('auth_users'), to_regclass('users'));
  IF user_table IS NULL THEN
    RAISE EXCEPTION 'OxaPay migration requires auth_users or users';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'oxapay_deposits'::regclass
       AND conname = 'oxapay_deposits_user_id_fkey'
  ) THEN
    EXECUTE format(
      'ALTER TABLE oxapay_deposits
         ADD CONSTRAINT oxapay_deposits_user_id_fkey
         FOREIGN KEY (user_id) REFERENCES %s(id) ON DELETE CASCADE NOT VALID',
      user_table
    );
    ALTER TABLE oxapay_deposits
      VALIDATE CONSTRAINT oxapay_deposits_user_id_fkey;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'oxapay_activity_log'::regclass
       AND conname = 'oxapay_activity_log_user_id_fkey'
  ) THEN
    EXECUTE format(
      'ALTER TABLE oxapay_activity_log
         ADD CONSTRAINT oxapay_activity_log_user_id_fkey
         FOREIGN KEY (user_id) REFERENCES %s(id) ON DELETE SET NULL NOT VALID',
      user_table
    );
    ALTER TABLE oxapay_activity_log
      VALIDATE CONSTRAINT oxapay_activity_log_user_id_fkey;
  END IF;
END
$$;