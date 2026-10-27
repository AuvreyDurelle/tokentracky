PRAGMA journal_mode=WAL;
BEGIN TRANSACTION;
CREATE TABLE threads(id TEXT PRIMARY KEY, summary TEXT NOT NULL, updated_at TEXT NOT NULL, data_type TEXT NOT NULL, data BLOB NOT NULL);
INSERT INTO threads VALUES('t1','PRIVATE_TITLE','2026-10-22T09:00:00+00:00','json',CAST('{"title":"PRIVATE_TITLE","messages":[{"User":{"id":"u1","content":[{"Text":"PRIVATE_PROMPT"}]}}],"model":{"provider":"zed.dev","model":"claude-sonnet-4-6"},"cumulative_token_usage":{"input_tokens":100,"output_tokens":20}}' AS BLOB));
COMMIT;
