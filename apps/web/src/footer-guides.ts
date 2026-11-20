/* Only link metadata goes into the interactive app. Article bodies stay in the static build. */
const budget = {
  'monthly-ai-token-budget': 'Set a monthly AI token budget you can check each week',
  'forecast-ai-token-spend': 'Forecast next month’s AI coding spend from usage history',
  'api-cost-per-completed-task': 'Measure AI cost per completed coding task',
  'investigate-ai-spend-spike': 'Investigate an unexpected spike in AI token spend',
  'reconcile-ai-usage-with-invoice': 'Reconcile AI token estimates with a provider invoice',
  'subscription-versus-api-cost': 'Compare a coding subscription with pay-as-you-go API usage',
};

const context = {
  'reduce-repeated-chat-history': 'When starting a new AI chat saves tokens',
  'token-efficient-session-handoff': 'Resume an unfinished coding task with a shorter handoff',
  'send-relevant-code-context': 'Choose which files to send an AI coding assistant',
  'trim-logs-for-ai-debugging': 'Cut a debugging log down before sending it to an AI assistant',
  'compact-repository-instructions': 'Reduce the token cost of repository instructions',
  'context-window-token-budget': 'Fit a coding task inside a model’s context window',
};

const cache = {
  'prompt-caching-break-even': 'Calculate when a prompt cache pays for itself',
  'stable-prompt-prefix': 'Structure a prompt so repeated input can be cached',
  'measure-prompt-cache-hits': 'Measure prompt cache effectiveness from token counts',
  'choose-prompt-cache-ttl': 'Choose a cache lifetime for repeated AI requests',
  'batch-api-cost': 'When to use a batch API to cut token spend',
  'reuse-completed-ai-answers': 'Reuse a completed AI answer without making another request',
};

const outputs = {
  'cap-output-tokens': 'Set an output token limit without truncating the useful answer',
  'ask-for-diffs-to-save-tokens': 'Ask for a patch instead of regenerating a whole file',
  'shorten-structured-ai-output': 'Reduce token spend on repeated structured outputs',
  'set-reasoning-effort': 'Choose reasoning effort for a coding task',
  'route-tasks-between-models': 'Route simple and difficult coding tasks to different models',
  'compare-model-tokenizers': 'Why the same text uses different token counts across models',
};

const tools = {
  'limit-agent-tool-output': 'Limit tool output before it fills an AI coding session',
  'reduce-tool-schema-overhead': 'Reduce the input cost of tool definitions',
  'budget-agent-retries': 'Set a retry budget for AI coding agents',
  'budget-parallel-ai-agents': 'Budget a task before launching parallel AI agents',
  'reduce-retrieval-token-spend': 'Tune retrieval depth to spend fewer tokens per answer',
  'image-input-token-cost': 'Decide when a screenshot is worth its input tokens',
};

const evaluation = {
  'benchmark-token-savings': 'Run a fair before-and-after test of token savings',
  'token-cost-of-few-shot-examples': 'Decide how many examples a prompt needs',
  'preflight-token-count': 'Count input tokens before sending a large request',
  'reduce-translation-token-cost': 'Reduce the token cost of AI translation jobs',
  'token-efficient-code-review': 'Spend fewer tokens on AI pull request reviews',
  'handle-token-rate-limits': 'Handle token-per-minute limits without wasting retries',
};

const setup = {
  'private-token-dashboard': 'Read your first token report without joining the leaderboard',
  'install-tokentracky-linux': 'Install the Tokentracky CLI on Linux without Node',
  'first-launch-on-macos': 'Open Tokentracky for the first time on an Apple Silicon Mac',
  'windows-background-tracking': 'Manage Tokentracky background tracking on Windows',
  'combine-usage-from-two-computers': 'Combine two computers on one leaderboard profile',
  'diagnose-missing-token-usage': 'Find out why a coding session is missing from your token count',
  'build-open-source-token-tracker': 'Build the open-source Tokentracky CLI from source',
  'unlink-token-tracker-device': 'Disconnect a computer from the Tokentracky leaderboard',
};

const reports = {
  'understand-estimated-token-cost': 'What the estimated cost next to your token count means',
  'add-token-badge-to-github-readme': 'Put a Tokentracky badge in your GitHub README',
  'export-ai-token-usage-csv': 'Export AI coding token usage to CSV',
  'ai-token-usage-by-project': 'Track AI coding token usage by project',
  'ai-coding-usage-heatmap': 'How to read your AI coding activity heatmap',
  'share-ai-coding-year-in-review': 'Share your AI coding year in review with Tokentracky',
  'ai-token-pricing-offline': 'How Tokentracky estimates AI token costs offline',
};

const accounting = {
  'claude-code-cache-read-write-tokens': 'How to read Claude Code’s cache tokens',
  'gemini-cli-tool-use-tokens': 'Where Gemini CLI’s tool-use tokens go',
  'goose-session-totals-and-usage-ledger': 'When a Goose session moves into the usage ledger',
  'grok-build-token-cost-receipts': 'Where a Grok Build cost figure comes from',
  'zed-thread-usage-after-model-switch': 'What happens to a Zed thread’s tokens when you switch models?',
  'copilot-chat-token-usage': 'Track GitHub Copilot Chat token usage alongside the CLI',
  'lm-studio-local-token-usage': 'Read LM Studio token usage from local server logs',
  'cline-checkpoint-token-usage': 'What happens to Cline token usage after a checkpoint restore?',
  'opencode-compaction-token-usage': 'How OpenCode compaction affects your token count',
  'test-ai-token-counter-with-fixtures': 'Test AI token counting with a synthetic session fixture',
};

export const footerGuideGroups = {
  'Budgets and billing': budget,
  'Managing context': context,
  'Caching and batch processing': cache,
  'Models and output': outputs,
  'Tools and agents': tools,
  'Testing token savings': evaluation,
  'Installation and devices': setup,
  'Reports and sharing': reports,
  'How tools count tokens': accounting,
};

const titles = { ...budget, ...context, ...cache, ...outputs, ...tools, ...evaluation, ...setup, ...reports, ...accounting };

export function guide(slug: keyof typeof titles) {
  return { slug, title: titles[slug] };
}
