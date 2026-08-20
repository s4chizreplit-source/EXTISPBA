-- OrganicSMM Pro — self-hosted schema (PostgreSQL)

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS users (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email         TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  full_name     TEXT NOT NULL DEFAULT '',
  role          TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('user', 'admin')),
  is_active     BOOLEAN NOT NULL DEFAULT true,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS wallets (
  user_id         UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  balance         NUMERIC(14,4) NOT NULL DEFAULT 0 CHECK (balance >= 0),
  total_deposited NUMERIC(14,4) NOT NULL DEFAULT 0,
  total_spent     NUMERIC(14,4) NOT NULL DEFAULT 0,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS password_resets (
  token      TEXT PRIMARY KEY,
  user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TIMESTAMPTZ NOT NULL,
  used_at    TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS services (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  platform            TEXT NOT NULL CHECK (platform IN ('instagram','tiktok','youtube','telegram','facebook')),
  category            TEXT NOT NULL,
  name                TEXT NOT NULL,
  description         TEXT NOT NULL DEFAULT '',
  price_per_1k        NUMERIC(12,4) NOT NULL CHECK (price_per_1k >= 0),
  min_quantity        INTEGER NOT NULL DEFAULT 100,
  max_quantity        INTEGER NOT NULL DEFAULT 100000,
  provider_service_id TEXT,
  is_active           BOOLEAN NOT NULL DEFAULT true,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS services_platform_idx ON services (platform) WHERE is_active;

CREATE TABLE IF NOT EXISTS orders (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  service_id        UUID NOT NULL REFERENCES services(id),
  link              TEXT NOT NULL,
  quantity          INTEGER NOT NULL CHECK (quantity > 0),
  charge            NUMERIC(12,4) NOT NULL CHECK (charge >= 0),
  status            TEXT NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending','processing','completed','partial','cancelled','failed')),
  start_count       INTEGER,
  remains           INTEGER,
  provider_order_id TEXT,
  provider_response JSONB,
  error_message     TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS orders_user_created_idx ON orders (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS orders_status_idx ON orders (status);

CREATE TABLE IF NOT EXISTS transactions (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type          TEXT NOT NULL CHECK (type IN ('deposit','order','refund','adjustment')),
  amount        NUMERIC(12,4) NOT NULL,
  balance_after NUMERIC(14,4) NOT NULL,
  order_id      UUID REFERENCES orders(id) ON DELETE SET NULL,
  reference     TEXT,
  description   TEXT NOT NULL DEFAULT '',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS transactions_reference_uniq
  ON transactions (reference) WHERE reference IS NOT NULL;
CREATE INDEX IF NOT EXISTS transactions_user_created_idx ON transactions (user_id, created_at DESC);

-- express-session store (connect-pg-simple)
CREATE TABLE IF NOT EXISTS user_sessions (
  sid    VARCHAR NOT NULL COLLATE "default" PRIMARY KEY,
  sess   JSON NOT NULL,
  expire TIMESTAMP(6) NOT NULL
);
CREATE INDEX IF NOT EXISTS user_sessions_expire_idx ON user_sessions (expire);
