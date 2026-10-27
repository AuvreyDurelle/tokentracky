PRAGMA journal_mode=WAL;
PRAGMA foreign_keys=OFF;
BEGIN TRANSACTION;
CREATE TABLE schema_version (version INTEGER NOT NULL);
INSERT INTO schema_version VALUES(6);
CREATE TABLE sessions (id TEXT PRIMARY KEY, title TEXT, cwd TEXT, created_at TEXT);
INSERT INTO sessions VALUES('copilot-session-1','PRIVATE_PROMPT_MARKER','/synthetic/PRIVATE_PATH_MARKER','2026-10-20T10:00:00Z');
CREATE TABLE turns (id INTEGER PRIMARY KEY, session_id TEXT, content TEXT);
INSERT INTO turns VALUES(1,'copilot-session-1','PRIVATE_RESPONSE_MARKER');
CREATE TABLE assistant_usage_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  model TEXT NOT NULL,
  input_tokens INTEGER,
  output_tokens INTEGER,
  cache_read_tokens INTEGER,
  cache_write_tokens INTEGER,
  reasoning_tokens INTEGER,
  token_details_json TEXT,
  created_at TEXT
);
INSERT INTO assistant_usage_events VALUES(1,'copilot-session-1','claude-sonnet-4.5',12000,800,10000,1500,200,'[{"tokenType":"input","tokenCount":500,"batchSize":1000000,"costPerBatch":1},{"tokenType":"cache_read","tokenCount":10000,"batchSize":1000000,"costPerBatch":1},{"tokenType":"cache_write","tokenCount":1500,"batchSize":1000000,"costPerBatch":1},{"tokenType":"output","tokenCount":800,"batchSize":1000000,"costPerBatch":1}]','2026-10-20T10:00:00.000Z');
INSERT INTO assistant_usage_events VALUES(2,'copilot-session-1','gpt-5',3000,400,2000,0,150,'[{"tokenType":"input","tokenCount":900,"batchSize":1000000,"costPerBatch":1},{"tokenType":"cache_read","tokenCount":2000,"batchSize":1000000,"costPerBatch":1},{"tokenType":"output","tokenCount":400,"batchSize":1000000,"costPerBatch":1}]','2026-10-20T10:05:00.000Z');
INSERT INTO assistant_usage_events VALUES(3,'copilot-session-1','gpt-5',100,10,150,0,0,NULL,'2026-10-20T10:06:00.000Z');
INSERT INTO assistant_usage_events VALUES(4,'copilot-session-2','gpt-5-mini',0,0,0,0,0,'[]','2026-10-20T11:00:00.000Z');
INSERT INTO assistant_usage_events VALUES(5,'copilot-session-2','claude-haiku-4.5',600,50,NULL,NULL,NULL,NULL,'not-a-time');
COMMIT;
