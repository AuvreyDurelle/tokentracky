-- Supported tools whose usage the Rust collector reads.
ALTER TABLE cloud_buckets DROP CONSTRAINT cloud_buckets_tool_check;
ALTER TABLE cloud_buckets ADD CONSTRAINT cloud_buckets_tool_check CHECK (tool IN ('all', 'claude', 'codex', 'cursor', 'gemini', 'cline', 'roo', 'kilo', 'opencode',
  'everycode', 'mimo', 'dumate', 'pi', 'omp', 'omo', 'primeagent', 'minimax', 'codebuddy', 'kimi', 'commandcode', 'deepseek',
  'lmstudio', 'copilot', 'unsloth', 'zcode', 'zed', 'openclaw', 'reasonix', 'hermes', 'goose'));
