-- Universal webhook idempotency / replay protection
CREATE TABLE IF NOT EXISTS public.webhook_events (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  provider TEXT NOT NULL,
  order_id TEXT NOT NULL,
  track_id TEXT,
  payload_hash TEXT NOT NULL,
  event_status TEXT,
  outcome TEXT NOT NULL DEFAULT 'received',
  http_status INT,
  message TEXT,
  payload JSONB,
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  processed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

GRANT ALL ON public.webhook_events TO service_role;

ALTER TABLE public.webhook_events ENABLE ROW LEVEL SECURITY;

-- No anon / authenticated access — service_role only via GRANT.
-- (An empty policy set with RLS on = zero rows visible to normal roles.)

-- Exact-duplicate delivery guard: same provider + order + payload hash.
CREATE UNIQUE INDEX IF NOT EXISTS webhook_events_provider_order_hash_uniq
  ON public.webhook_events (provider, order_id, payload_hash);

-- Track-id based dedupe (per provider) when track_id is present.
CREATE UNIQUE INDEX IF NOT EXISTS webhook_events_provider_track_uniq
  ON public.webhook_events (provider, track_id)
  WHERE track_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS webhook_events_provider_order_idx
  ON public.webhook_events (provider, order_id);

CREATE INDEX IF NOT EXISTS webhook_events_first_seen_idx
  ON public.webhook_events (first_seen_at DESC);
