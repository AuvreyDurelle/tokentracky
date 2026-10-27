BEGIN;
UPDATE sessions SET updated_at = '2026-10-23 10:00:00', accumulated_total_tokens = 16500, accumulated_input_tokens = 15000, accumulated_output_tokens = 1500, accumulated_cache_read_tokens = 9500, accumulated_cache_write_tokens = 1000 WHERE id = '20261020_3';
INSERT INTO usage_ledger(session_id, created_timestamp, model, input_tokens, output_tokens, total_tokens, cache_read_tokens, cache_write_tokens, cost, cost_source, is_compaction) VALUES('20261020_3',1792749600,NULL,12000,1200,13200,7000,1000,NULL,'carried_forward',0);
INSERT INTO usage_ledger(session_id, created_timestamp, model, input_tokens, output_tokens, total_tokens, cache_read_tokens, cache_write_tokens, cost, cost_source, is_compaction) VALUES('20261020_3',1792749600,'gpt-5.6-terra',3000,300,3300,2500,0,NULL,NULL,0);
COMMIT;
