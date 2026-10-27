-- Model mix (opt-in per publication): buckets gain a model dimension; '' is the across-models total.
ALTER TABLE cloud_publications ADD COLUMN share_models boolean NOT NULL DEFAULT false;
ALTER TABLE cloud_buckets ADD COLUMN model text NOT NULL DEFAULT '' CHECK (length(model) <= 128);
ALTER TABLE cloud_buckets DROP CONSTRAINT cloud_buckets_pkey;
ALTER TABLE cloud_buckets ADD PRIMARY KEY (account_id, day_key, tool, model);
