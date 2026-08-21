CREATE SCHEMA IF NOT EXISTS replit_ops;

CREATE TABLE IF NOT EXISTS replit_ops.database_mirror_runs (
  id BIGSERIAL PRIMARY KEY,
  status TEXT NOT NULL CHECK (status IN ('running', 'succeeded', 'failed')),
  source_environment TEXT NOT NULL CHECK (source_environment IN ('development', 'production')),
  target_project_ref TEXT,
  source_table_count INTEGER,
  source_row_count BIGINT,
  source_user_count BIGINT,
  archive_sha256 CHAR(64),
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ,
  error_message TEXT
);

CREATE INDEX IF NOT EXISTS database_mirror_runs_status_completed_idx
  ON replit_ops.database_mirror_runs (status, completed_at DESC);