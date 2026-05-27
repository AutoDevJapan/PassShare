export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS connect_vaults (
  id VARCHAR(26) PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  type TEXT NOT NULL DEFAULT 'USER_CREATED',
  content_version INTEGER NOT NULL DEFAULT 1,
  attribute_version INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS connect_items (
  id VARCHAR(26) PRIMARY KEY,
  vault_id VARCHAR(26) NOT NULL REFERENCES connect_vaults(id) ON DELETE CASCADE,
  document JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS connect_item_files (
  id VARCHAR(26) PRIMARY KEY,
  item_id VARCHAR(26) NOT NULL REFERENCES connect_items(id) ON DELETE CASCADE,
  name TEXT NOT NULL DEFAULT '',
  size BIGINT NOT NULL DEFAULT 0,
  content BYTEA,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_connect_items_vault_id ON connect_items(vault_id);
CREATE INDEX IF NOT EXISTS idx_connect_item_files_item_id ON connect_item_files(item_id);
`;
