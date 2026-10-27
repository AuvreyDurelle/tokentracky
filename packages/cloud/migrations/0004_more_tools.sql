-- M6 batch 1 tools.
ALTER TABLE cloud_buckets DROP CONSTRAINT cloud_buckets_tool_check;
ALTER TABLE cloud_buckets ADD CONSTRAINT cloud_buckets_tool_check CHECK (tool IN ('all', 'claude', 'codex', 'cursor', 'gemini', 'cline', 'roo', 'kilo', 'opencode'));
