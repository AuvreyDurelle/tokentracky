PRAGMA journal_mode=WAL;
PRAGMA foreign_keys=OFF;
BEGIN TRANSACTION;
CREATE TABLE session(id TEXT PRIMARY KEY, directory TEXT, title TEXT);
CREATE TABLE message(id TEXT PRIMARY KEY, session_id TEXT NOT NULL, agent_id TEXT NOT NULL DEFAULT 'main', time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL);
CREATE TABLE part(id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT);
INSERT INTO message VALUES('msg_D1','ses_D1','main',1792746070000,1792746075000,'{"role":"assistant","time":{"created":1792746070000,"completed":1792746075000},"parentID":"msg_00USER","modelID":"mimo-v2.5-pro","providerID":"mimo","mode":"build","agent":"build","path":{"cwd":"/synthetic/mimo-dev-project","root":"/synthetic/mimo-dev-project"},"summary":{"title":"PRIVATE_PROMPT_MARKER"},"cost":0,"tokens":{"total":15,"input":10,"output":5,"reasoning":0,"cache":{"read":0,"write":0}},"finish":"stop"}');
COMMIT;
