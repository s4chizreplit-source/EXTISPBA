CREATE TABLE IF NOT EXISTS public.security_audit_log (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  category TEXT NOT NULL,
  source TEXT NOT NULL,
  reason TEXT NOT NULL,
  provider TEXT,
  order_id TEXT,
  track_id TEXT,
  user_id UUID,
  http_status INT,
  ip TEXT,
  user_agent TEXT,
  request_path TEXT,
  payload JSONB,
  metadata JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

GRANT SELECT ON public.security_audit_log TO authenticated;
GRANT ALL ON public.security_audit_log TO service_role;

ALTER TABLE public.security_audit_log ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Admins can read security audit log"
  ON public.security_audit_log
  FOR SELECT
  TO authenticated
  USING (public.has_role(auth.uid(), 'admin'));

CREATE INDEX IF NOT EXISTS security_audit_log_created_at_idx
  ON public.security_audit_log (created_at DESC);
CREATE INDEX IF NOT EXISTS security_audit_log_category_idx
  ON public.security_audit_log (category, created_at DESC);
CREATE INDEX IF NOT EXISTS security_audit_log_provider_idx
  ON public.security_audit_log (provider, created_at DESC);
CREATE INDEX IF NOT EXISTS security_audit_log_user_idx
  ON public.security_audit_log (user_id, created_at DESC)
  WHERE user_id IS NOT NULL;
