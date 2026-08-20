CREATE TABLE public.oxapay_activity_log (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  source TEXT NOT NULL,
  event TEXT NOT NULL,
  order_id TEXT,
  user_id UUID,
  plan_type TEXT,
  purpose TEXT,
  amount_usd NUMERIC,
  provider_status TEXT,
  http_status INT,
  ok BOOLEAN NOT NULL DEFAULT true,
  message TEXT,
  payload JSONB
);

CREATE INDEX idx_oxapay_activity_log_created_at ON public.oxapay_activity_log (created_at DESC);
CREATE INDEX idx_oxapay_activity_log_order_id ON public.oxapay_activity_log (order_id);
CREATE INDEX idx_oxapay_activity_log_ok ON public.oxapay_activity_log (ok);

GRANT SELECT ON public.oxapay_activity_log TO authenticated;
GRANT ALL ON public.oxapay_activity_log TO service_role;

ALTER TABLE public.oxapay_activity_log ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Admins can view oxapay activity log"
  ON public.oxapay_activity_log
  FOR SELECT
  TO authenticated
  USING (public.has_role(auth.uid(), 'admin'));