CREATE TABLE IF NOT EXISTS database_backup_runs (
  id BIGSERIAL PRIMARY KEY,
  status TEXT NOT NULL CHECK (status IN ('running', 'succeeded', 'failed')),
  object_name TEXT,
  manifest_name TEXT,
  size_bytes BIGINT,
  sha256 CHAR(64),
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ,
  error_message TEXT
);

CREATE INDEX IF NOT EXISTS database_backup_runs_status_completed_idx
  ON database_backup_runs (status, completed_at DESC);