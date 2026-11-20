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
};

export function guide(slug: keyof typeof footerTitles) {
  return { slug, title: footerTitles[slug] };
}
