-- Collector identity and sync receipts: a reset or restored collector must re-review before uploading.
ALTER TABLE cloud_devices ADD COLUMN collector_id uuid;
ALTER TABLE cloud_devices ADD COLUMN receipt uuid;
ALTER TABLE cloud_devices ADD COLUMN checkpoint bigint NOT NULL DEFAULT 0 CHECK (checkpoint BETWEEN 0 AND 9007199254740991);
UPDATE cloud_devices d SET checkpoint = greatest(d.checkpoint, coalesce((SELECT max(b.revision) FROM cloud_buckets b WHERE b.device_id = d.id), 0)) WHERE d.collector_id IS NULL;
