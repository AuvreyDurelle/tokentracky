/* Only link metadata goes into the interactive app. Article bodies stay in the static build. */
export const footerTitles = {
  'private-token-dashboard': 'Read your first token report without joining the leaderboard',
  'install-tokentracky-linux': 'Install the Tokentracky CLI on Linux without Node',
  'first-launch-on-macos': 'Open Tokentracky for the first time on an Apple Silicon Mac',
  'windows-background-tracking': 'Manage Tokentracky background tracking on Windows',
  'combine-usage-from-two-computers': 'Combine two computers on one leaderboard profile',
  'understand-estimated-token-cost': 'What the estimated cost next to your token count means',
  'add-token-badge-to-github-readme': 'Put a Tokentracky badge in your GitHub README',
  'diagnose-missing-token-usage': 'Find out why a coding session is missing from your token count',
  'claude-code-cache-read-write-tokens': 'How to read Claude Code’s cache tokens',
  'gemini-cli-tool-use-tokens': 'Where Gemini CLI’s tool-use tokens go',
  'goose-session-totals-and-usage-ledger': 'When a Goose session moves into the usage ledger',
  'grok-build-token-cost-receipts': 'Where a Grok Build cost figure comes from',
  'zed-thread-usage-after-model-switch': 'What happens to a Zed thread’s tokens when you switch models?',
  'copilot-chat-token-usage': 'Track GitHub Copilot Chat token usage alongside the CLI',
  'lm-studio-local-token-usage': 'Read LM Studio token usage from local server logs',
  'cline-checkpoint-token-usage': 'What happens to Cline token usage after a checkpoint restore?',
  'opencode-compaction-token-usage': 'How OpenCode compaction affects your token count',
  'export-ai-token-usage-csv': 'Export AI coding token usage to CSV',
  'ai-token-usage-by-project': 'Track AI coding token usage by project',
  'ai-coding-usage-heatmap': 'How to read your AI coding activity heatmap',
  'share-ai-coding-year-in-review': 'Share your AI coding year in review with Tokentracky',
  'build-open-source-token-tracker': 'Build the open-source Tokentracky CLI from source',
  'test-ai-token-counter-with-fixtures': 'Test AI token counting with a synthetic session fixture',
  'unlink-token-tracker-device': 'Disconnect a computer from the Tokentracky leaderboard',
  'ai-token-pricing-offline': 'How Tokentracky estimates AI token costs offline',
};

export function guide(slug: keyof typeof footerTitles) {
  return { slug, title: footerTitles[slug] };
}
