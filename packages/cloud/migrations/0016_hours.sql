-- The leaderboard's 24-hour column (PublicProfile.last24hTokens): each computer's tokens per UTC hour and tool over
-- about the last day. An upload's hours replace its computer's, and every upload deletes hours older than the window.
CREATE TABLE cloud_hours (
  account_id text NOT NULL REFERENCES cloud_publications(account_id) ON DELETE CASCADE,
  device_id uuid NOT NULL REFERENCES cloud_devices(id),
  hour timestamptz NOT NULL CHECK (hour = date_trunc('hour', hour AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'),
  tool text NOT NULL,
  tokens bigint NOT NULL CHECK (tokens BETWEEN 0 AND 9007199254740991),
  PRIMARY KEY (account_id, device_id, hour, tool)
);
CREATE INDEX cloud_hours_by_hour ON cloud_hours(hour);
-- When the computer last sent hours. Members whose computers never have (apps from before hours) show no figure.
ALTER TABLE cloud_devices ADD COLUMN hours_at timestamptz;
-- As cloud_account_buckets: an hour two of a member's computers report identically (copied logs) counts once.
CREATE VIEW cloud_account_hours WITH (security_invoker = true) AS
  SELECT DISTINCT account_id, hour, tool, tokens FROM cloud_hours;
