-- Several computers per account. Every bucket already names the computer
-- that uploaded it; each computer now keeps its own buckets, up to 10 active computers per account.
DROP INDEX cloud_one_active_device;
ALTER TABLE cloud_buckets DROP CONSTRAINT cloud_buckets_pkey;
ALTER TABLE cloud_buckets ADD PRIMARY KEY (account_id, device_id, day_key, tool, model);
-- SHA-256 of the computer's hardware id and a fixed salt, so a reinstall replaces its computer instead of adding one.
ALTER TABLE cloud_devices ADD COLUMN machine_id text CHECK (machine_id ~ '^[0-9a-f]{64}$');
ALTER TABLE cloud_device_authorizations ADD COLUMN machine_id text CHECK (machine_id ~ '^[0-9a-f]{64}$');
CREATE UNIQUE INDEX cloud_one_active_machine ON cloud_devices(account_id, machine_id) WHERE revoked_at IS NULL AND machine_id IS NOT NULL;
-- Every public read uses this. Copied log folders give two computers identical past days: a bucket with exactly the
-- same tokens and token-type breakdown for the same day, tool and model counts once. Real use on two computers practically never matches.
CREATE VIEW cloud_account_buckets AS
  SELECT account_id, day_key, tool, model, tokens,
    input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, reasoning_tokens,
    CASE WHEN bool_or(cost_microusd IS NULL) THEN NULL ELSE max(cost_microusd) END AS cost_microusd
  FROM cloud_buckets GROUP BY account_id, day_key, tool, model, tokens,
    input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, reasoning_tokens;
