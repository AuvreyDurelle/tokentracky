BEGIN TRANSACTION;
CREATE TABLE usage (id INTEGER PRIMARY KEY, session_id TEXT, model TEXT, input_tokens INTEGER, output_tokens INTEGER, prompt TEXT);
INSERT INTO usage VALUES(1,'copilot-session-1','gpt-5',999999,999999,'PRIVATE_PROMPT_MARKER');
COMMIT;
