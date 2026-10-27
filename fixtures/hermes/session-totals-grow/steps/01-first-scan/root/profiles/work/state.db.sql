PRAGMA journal_mode=WAL;
PRAGMA foreign_keys=OFF;
BEGIN TRANSACTION;
CREATE TABLE sessions(id TEXT PRIMARY KEY, source TEXT NOT NULL, model TEXT, system_prompt TEXT, started_at REAL NOT NULL, ended_at REAL, input_tokens INTEGER DEFAULT 0, output_tokens INTEGER DEFAULT 0, cache_read_tokens INTEGER DEFAULT 0, cache_write_tokens INTEGER DEFAULT 0, reasoning_tokens INTEGER DEFAULT 0, cwd TEXT, title TEXT, last_activity_at REAL);
CREATE TABLE messages(id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL REFERENCES sessions(id), role TEXT NOT NULL, content TEXT, timestamp REAL NOT NULL);
INSERT INTO sessions VALUES('20261022_090000_dddd','cli','gpt-5.6-terra','PRIVATE_SYSTEM_PROMPT',1792659600.0,NULL,200,80,0,0,30,'/PRIVATE_PROJECT','PRIVATE_TITLE',NULL);
INSERT INTO messages(session_id, role, content, timestamp) VALUES('20261022_090000_dddd','user','PRIVATE_PROMPT',1792659600.0);
COMMIT;
