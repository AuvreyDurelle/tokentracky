PRAGMA journal_mode=WAL;
PRAGMA foreign_keys=OFF;
BEGIN TRANSACTION;
CREATE TABLE message(id TEXT PRIMARY KEY, session_id TEXT NOT NULL, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL);
CREATE TABLE session_message(id TEXT PRIMARY KEY, session_id TEXT NOT NULL, type TEXT NOT NULL, seq INTEGER NOT NULL, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL);
INSERT INTO message VALUES('msg_01TEST','ses_kilo',1792746000000,1792746005000,'{"role":"assistant","time":{"created":1792746001000,"completed":1792746002000},"modelID":"claude-sonnet-4-6","providerID":"anthropic","path":{"cwd":"/synthetic/kilo-project"},"summary":{"title":"PRIVATE_PROMPT_MARKER"},"tokens":{"input":400,"output":200,"reasoning":50,"cache":{"read":1000,"write":100}}}');
COMMIT;
