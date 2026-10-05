export const AUTH_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS sessions (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_token_hash ON sessions(token_hash);

CREATE TABLE IF NOT EXISTS connect_tokens (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  vault_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
  expires_at TIMESTAMPTZ NOT NULL,
  label TEXT NOT NULL DEFAULT 'session',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_connect_tokens_user_id ON connect_tokens(user_id);
CREATE INDEX IF NOT EXISTS idx_connect_tokens_token_hash ON connect_tokens(token_hash);

CREATE TABLE IF NOT EXISTS vault_memberships (
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  vault_id VARCHAR(26) NOT NULL REFERENCES connect_vaults(id) ON DELETE CASCADE,
  role TEXT NOT NULL DEFAULT 'owner',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, vault_id)
);

CREATE INDEX IF NOT EXISTS idx_vault_memberships_vault_id ON vault_memberships(vault_id);

CREATE TABLE IF NOT EXISTS vault_invitations (
  id UUID PRIMARY KEY,
  vault_id VARCHAR(26) NOT NULL REFERENCES connect_vaults(id) ON DELETE CASCADE,
  inviter_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  invitee_email TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'member',
  status TEXT NOT NULL DEFAULT 'pending',
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  responded_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_vault_invitations_vault_id ON vault_invitations(vault_id);
-- Legacy invitations cannot be accepted without independently delivered proof.
ALTER TABLE vault_invitations ADD COLUMN IF NOT EXISTS confirmation_hash TEXT;
CREATE INDEX IF NOT EXISTS idx_vault_invitations_invitee ON vault_invitations(invitee_email, status);
CREATE UNIQUE INDEX IF NOT EXISTS idx_vault_invitations_pending_unique
  ON vault_invitations(vault_id, invitee_email)
  WHERE status = 'pending';

-- Login failure lockout state, shared across backend instances and durable
-- across restarts (#378). expires_at = last activity + lockout window; rows
-- past it are treated as absent and swept opportunistically by the pg store.
CREATE TABLE IF NOT EXISTS login_failures (
  email TEXT PRIMARY KEY,
  failures INTEGER NOT NULL DEFAULT 0,
  locked_until TIMESTAMPTZ,
  expires_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_login_failures_expires_at ON login_failures(expires_at);

-- Per-IP login request timestamps for the sliding-window throttle (#378). One
-- row per request; expires_at = requested_at + window, used for eviction.
CREATE TABLE IF NOT EXISTS login_ip_requests (
  id BIGSERIAL PRIMARY KEY,
  ip TEXT NOT NULL,
  requested_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_login_ip_requests_ip ON login_ip_requests(ip, requested_at);
CREATE INDEX IF NOT EXISTS idx_login_ip_requests_expires_at ON login_ip_requests(expires_at);
`;
