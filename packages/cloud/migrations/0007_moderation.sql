-- Moderation. Automatic checks only flag and hide; a person bans.
CREATE TABLE cloud_flags (
  account_id text NOT NULL REFERENCES cloud_accounts(id) ON DELETE CASCADE,
  day_key text NOT NULL CHECK (day_key = 'unknown' OR day_key ~ '^\d{4}-\d{2}-\d{2}$'),
  tokens bigint NOT NULL CHECK (tokens BETWEEN 0 AND 9007199254740991),
  rival_tokens bigint NOT NULL CHECK (rival_tokens BETWEEN 0 AND 9007199254740991),
  cohort_size integer NOT NULL CHECK (cohort_size >= 0),
  baseline_tokens bigint CHECK (baseline_tokens BETWEEN 0 AND 9007199254740991),
  reasons text[] NOT NULL CHECK (cardinality(reasons) > 0),
  status text NOT NULL CHECK (status IN ('review', 'hidden', 'cleared')),
  detected_at timestamptz NOT NULL DEFAULT now(),
  reviewed_at timestamptz,
  note text CHECK (length(note) <= 500),
  PRIMARY KEY (account_id, day_key)
);
-- No foreign key on purpose: a ban outlives account deletion, so the same sign-in cannot rejoin.
-- account_id is already a SHA-256 of the sign-in identity.
CREATE TABLE cloud_bans (
  account_id text PRIMARY KEY,
  reason text NOT NULL CHECK (length(reason) BETWEEN 1 AND 500),
  banned_at timestamptz NOT NULL DEFAULT now()
);
-- Every public read excludes these accounts. Only account ids, so publication columns can change freely.
CREATE VIEW cloud_hidden_accounts AS
  SELECT account_id FROM cloud_bans
  UNION
  SELECT account_id FROM cloud_flags WHERE status = 'hidden';
CREATE INDEX cloud_buckets_day ON cloud_buckets(day_key);
