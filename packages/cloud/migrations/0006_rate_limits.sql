-- Shared short-lived rate-limit counters across Cloud Run instances. No raw IPs or request content.
CREATE TABLE cloud_rate_limits (
  key_hash text PRIMARY KEY,
  hits integer NOT NULL CHECK (hits > 0),
  expires_at timestamptz NOT NULL
);
CREATE INDEX cloud_rate_limits_expiry ON cloud_rate_limits(expires_at);
