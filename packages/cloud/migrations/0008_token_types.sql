-- Token types: each bucket's tokens by kind. Input, output, cache read and cache
-- write add up to tokens; reasoning is the part of output spent reasoning. All five are set, or all five are null for
-- uploads from apps that predate types, which stay valid. The one-hour cache-write part and the service tier stay local.
-- Adding these nullable columns preserves uploads from older clients without resetting publication.
ALTER TABLE cloud_buckets
  ADD COLUMN input_tokens bigint CHECK (input_tokens BETWEEN 0 AND 9007199254740991),
  ADD COLUMN output_tokens bigint CHECK (output_tokens BETWEEN 0 AND 9007199254740991),
  ADD COLUMN cache_read_tokens bigint CHECK (cache_read_tokens BETWEEN 0 AND 9007199254740991),
  ADD COLUMN cache_write_tokens bigint CHECK (cache_write_tokens BETWEEN 0 AND 9007199254740991),
  ADD COLUMN reasoning_tokens bigint CHECK (reasoning_tokens BETWEEN 0 AND 9007199254740991),
  ADD CONSTRAINT cloud_buckets_kinds_all_or_none CHECK
    (num_nulls(input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, reasoning_tokens) IN (0, 5)),
  ADD CONSTRAINT cloud_buckets_kinds_add_up CHECK
    (input_tokens + output_tokens + cache_read_tokens + cache_write_tokens = tokens AND reasoning_tokens <= output_tokens);
