CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('user', 'admin')),
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  email_verified_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_users_email ON users (LOWER(email));

CREATE TABLE IF NOT EXISTS email_verification_tokens (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  used_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_email_verification_user ON email_verification_tokens (user_id);

CREATE TABLE IF NOT EXISTS password_reset_tokens (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  used_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_password_reset_user ON password_reset_tokens (user_id);

CREATE TABLE IF NOT EXISTS refresh_tokens (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_refresh_tokens_user ON refresh_tokens (user_id);

CREATE TABLE IF NOT EXISTS api_keys (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  name TEXT NOT NULL DEFAULT '',
  key_prefix TEXT NOT NULL,
  key_hash TEXT NOT NULL,
  last_used_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  revoked_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_api_keys_user ON api_keys (user_id);
CREATE INDEX IF NOT EXISTS idx_api_keys_prefix ON api_keys (key_prefix);

CREATE TABLE IF NOT EXISTS user_provider_credentials (
  user_id UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  provider_id TEXT NOT NULL,
  encrypted_payload TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, provider_id)
);

CREATE TABLE IF NOT EXISTS user_balances (
  user_id UUID PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
  balance NUMERIC(14, 4) NOT NULL DEFAULT 0,
  currency TEXT NOT NULL DEFAULT 'RUB',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS user_limits (
  user_id UUID PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
  daily_queries INTEGER,
  monthly_queries INTEGER,
  max_batch_size INTEGER,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- --- Пополнения через Robokassa ---
-- inv_id — числовой идентификатор счёта (Robokassa InvId требует integer).
CREATE TABLE IF NOT EXISTS robokassa_invoices (
  inv_id BIGSERIAL PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  amount_rub NUMERIC(14, 2) NOT NULL CHECK (amount_rub > 0),
  tokens NUMERIC(14, 4) NOT NULL CHECK (tokens > 0),
  status TEXT NOT NULL DEFAULT 'created' CHECK (status IN ('created', 'paid', 'failed')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  paid_at TIMESTAMPTZ,
  raw_result JSONB
);

CREATE INDEX IF NOT EXISTS idx_robokassa_invoices_user_created ON robokassa_invoices (user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS search_history (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  query_text TEXT,
  providers JSONB NOT NULL DEFAULT '[]'::jsonb,
  batch BOOLEAN NOT NULL DEFAULT FALSE,
  query_count INTEGER NOT NULL DEFAULT 1,
  result_summary JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_search_history_user_created ON search_history (user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS usage_counters (
  user_id UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  period_type TEXT NOT NULL CHECK (period_type IN ('day', 'month')),
  period_start DATE NOT NULL,
  query_count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, period_type, period_start)
);
