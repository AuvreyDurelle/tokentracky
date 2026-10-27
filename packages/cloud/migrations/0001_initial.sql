-- Accounts, opt-in publications, publishing devices and daily aggregate buckets.
CREATE TABLE cloud_migrations (version integer PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE cloud_accounts (
  id text PRIMARY KEY,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE cloud_publications (
  account_id text PRIMARY KEY REFERENCES cloud_accounts(id) ON DELETE CASCADE,
  alias text NOT NULL UNIQUE CHECK (alias ~ '^[a-z0-9][a-z0-9_-]{2,29}$'),
  history_start timestamptz,
  share_tools boolean NOT NULL,
  share_cost boolean NOT NULL,
  generation uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (history_start IS NULL OR history_start = date_trunc('day', history_start AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')
);
CREATE TABLE cloud_devices (
  id uuid PRIMARY KEY,
  account_id text NOT NULL REFERENCES cloud_accounts(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
  token_hash text NOT NULL UNIQUE,
  revoked_at timestamptz,
  last_seen_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX cloud_one_active_device ON cloud_devices(account_id) WHERE revoked_at IS NULL;
CREATE TABLE cloud_buckets (
  account_id text NOT NULL REFERENCES cloud_publications(account_id) ON DELETE CASCADE,
  device_id uuid NOT NULL REFERENCES cloud_devices(id),
  day_key text NOT NULL CHECK (day_key = 'unknown' OR day_key ~ '^\d{4}-\d{2}-\d{2}$'),
  tool text NOT NULL CONSTRAINT cloud_buckets_tool_check CHECK (tool IN ('all', 'claude', 'codex', 'cursor', 'gemini')),
  tokens bigint NOT NULL CHECK (tokens BETWEEN 0 AND 9007199254740991),
  cost_microusd bigint CHECK (cost_microusd BETWEEN 0 AND 9007199254740991),
  revision bigint NOT NULL CHECK (revision BETWEEN 0 AND 9007199254740991),
  PRIMARY KEY (account_id, day_key, tool)
);
