-- Fixed sharing: every publication covers all history with the tool
-- split, model mix and cost. Each narrower one is widened as a save would: a new generation, no old buckets and fresh
-- device receipts, so its collector stops at the widening review until the member reconnects.
WITH widened AS (
  UPDATE cloud_publications
  SET history_start = NULL, share_tools = true, share_cost = true, share_models = true, generation = gen_random_uuid(), updated_at = now()
  WHERE history_start IS NOT NULL OR NOT share_tools OR NOT share_cost OR NOT share_models
  RETURNING account_id
), cleared AS (
  DELETE FROM cloud_buckets WHERE account_id IN (SELECT account_id FROM widened)
)
UPDATE cloud_devices SET collector_id = NULL, receipt = NULL, checkpoint = 0 WHERE account_id IN (SELECT account_id FROM widened);
