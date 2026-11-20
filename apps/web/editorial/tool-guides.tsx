import React from 'react';
import { guide } from '../src/footer-guides';

const fixtures = 'https://github.com/AuvreyDurelle/tokentracky/tree/96621c89bf8b1d5a666c654fb945ee6ab1e01450/fixtures/';
const file = 'https://github.com/AuvreyDurelle/tokentracky/blob/96621c89bf8b1d5a666c654fb945ee6ab1e01450/fixtures/';

export const toolGuides = [
  {
    ...guide('claude-code-cache-read-write-tokens'),
    description: 'Add ordinary input, cache reads, cache writes, and output to recover a Claude Code request total. A 161-token example shows which fields overlap.',
    body: <>
      <h2>Which Claude Code counters go into the total?</h2>
      <p>Add ordinary input, cache reads, cache writes, and output once each. In Tokentracky’s synthetic Claude Code request, those four numbers are 11 + 100 + 30 + 20 = <strong>161 tokens</strong>. The reasoning count is part of output. The one-hour writes are part of cache writes.</p>
      <table><caption>How to read the request’s usage fields</caption><thead><tr><th scope="col">Usage field</th><th scope="col">Tokens</th><th scope="col">Contribution</th></tr></thead><tbody>
        <tr><th scope="row">Ordinary input</th><td>11</td><td>New input outside the cache.</td></tr>
        <tr><th scope="row">Cache reads</th><td>100</td><td>Input retrieved from the cache.</td></tr>
        <tr><th scope="row">Cache writes</th><td>30</td><td>10 written for five minutes and 20 for one hour.</td></tr>
        <tr><th scope="row">Output</th><td>20</td><td>Includes the seven reasoning tokens.</td></tr>
      </tbody></table>
      <h2>Where to find the cache-write total</h2>
      <p>Start with <code>cache_creation_input_tokens</code> in the assistant message’s usage record. If that field is absent, as it is in this example, look under <code>cache_creation</code> and add the five-minute and one-hour counts. When the total is present, the one-hour field tells you how many writes qualify for that pricing tier.</p>
      <p>To check your arithmetic, sum the three input categories first. Here they give 141, and the 20 output tokens bring the request to 161. A total of 188 means you have added the 20 one-hour writes and seven reasoning tokens twice. You can verify the token count even when the summary shows an unknown cost.</p>
      <p>The <a href="/blog/how-tokentracky-counts-tokens">open-source token counting walkthrough</a> follows the next question a report raises, which is how to count usage that appears in more than one session.</p>
    </>,
    sources: [
      { label: 'Inspect the raw Claude Code usage record', url: file + 'claude/cache-creation-subcategories/root/session.jsonl' },
      { label: 'Compare the expected total and cache breakdown', url: file + 'claude/cache-creation-subcategories/rust-expected/summary.json' },
    ],
  },
  {
    ...guide('gemini-cli-tool-use-tokens'),
    description: 'Gemini CLI includes cached tokens in input and reports tool-prompt tokens separately. Follow three messages from raw counters to a 565-token session.',
    body: <>
      <h2>How do tool-use tokens change a Gemini CLI total?</h2>
      <p>Tokentracky adds Gemini CLI’s <code>tool</code> count to input and separates cache reads already included in <code>input</code>. For the first message in the synthetic session, 500 input + 30 tool-prompt + 20 output gives <strong>550 tokens</strong>. Its 100 cached tokens explain how some of the input was supplied. Adding them again would give 650.</p>
      <h2>Reconcile the three messages</h2>
      <table><caption>Token counts from the Gemini CLI test session</caption><thead><tr><th scope="col">Message</th><th scope="col">Collector breakdown</th><th scope="col">Total</th></tr></thead><tbody>
        <tr><th scope="row">First</th><td>430 ordinary input, 100 cache reads, 20 output</td><td>550</td></tr>
        <tr><th scope="row">Second</th><td>10 ordinary input, 5 output</td><td>15</td></tr>
        <tr><th scope="row">Third</th><td>Zero reported usage</td><td>0</td></tr>
      </tbody></table>
      <p>For the first message, subtracting the 100 cached tokens from 500 leaves 400. Adding the tool-prompt tokens gives the 430 ordinary input tokens in the breakdown. On the second message the optional cached and thought counters are null and contribute zero. Across the session, 440 ordinary input + 100 cache reads + 25 output = 565.</p>
      <h2>What to check when the reported total differs</h2>
      <p>Open the raw JSONL and compare the counters for the same message ID. In message <code>a</code>, the fixture deliberately sets <code>total</code> to 999,999. Tokentracky calculates usage from the components, so that field contributes nothing extra. Only after each message balances should you compare your sum with the session summary.</p>
      <p>If several sessions contain copies of the same activity, see <a href="/blog/how-tokentracky-counts-tokens">how the collector reconciles a forked session</a> for a worked Codex example.</p>
    </>,
    sources: [
      { label: 'Inspect the three Gemini CLI messages', url: file + 'gemini/tool-use-and-optional-counters/root/project-slug/chats/session-2026-10-23T09-00-abcd1234.jsonl' },
      { label: 'Compare the expected 565-token session summary', url: file + 'gemini/tool-use-and-optional-counters/rust-expected/summary.json' },
    ],
  },
  {
    ...guide('goose-session-totals-and-usage-ledger'),
    description: 'A Goose usage ledger can carry forward tokens already observed in a session. Reconcile two scans and see why a 13,200-token row adds only 2,200.',
    body: <>
      <h2>How much does a carried-forward Goose ledger row add?</h2>
      <p>Subtract the usage already counted for that Goose session. In the synthetic database, the collector first reads 11,000 tokens from a session’s running total. When Goose later writes a <code>carried_forward</code> ledger entry for 13,200, only <strong>2,200 tokens</strong> are new.</p>
      <h2>Use the first scan as your starting point</h2>
      <p>The older session, <code>20261020_3</code>, has no ledger rows at first. Its 11,000 tokens come from the accumulated session counters. A different session already has a ledger. Two of its rows contribute 5,400 and 2,100 tokens. A third claims 175 for 100 input and 50 output, so the collector skips the inconsistent row. The total across sessions is 11,000 + 5,400 + 2,100 = 18,500.</p>
      <h2>Match the second scan by session and row type</h2>
      <ol>
        <li>Find the older session’s 13,200-token ledger entry. Its <code>cost_source</code> is <code>carried_forward</code>. Subtract the previously observed 11,000 to get the 2,200-token increase.</li>
        <li>Find the separate 3,300-token request for the same session. Count it in full. That session now accounts for 11,000 + 2,200 + 3,300 = 16,500 tokens.</li>
        <li>Add both increases to the first database total. The result is <strong>24,000</strong>. If your result is 35,000, the exact 11,000-token difference points back to the opening session balance.</li>
      </ol>
      <p>The SQL files below contain both scans. Follow the session ID and the numeric fields to check the transition. The <a href="/blog/what-joining-the-leaderboard-shares">publication guide</a> explains how the local session detail becomes an aggregate when a computer joins the board.</p>
    </>,
    sources: [
      { label: 'Read both SQL snapshots and their expected totals', url: fixtures + 'goose/ledger-and-session-totals/steps' },
      { label: 'Inspect the carried-forward row and the fresh request', url: file + 'goose/ledger-and-session-totals/steps/02-ledger-takes-over/root/sessions.db.sql' },
    ],
  },
  {
    ...guide('grok-build-token-cost-receipts'),
    description: 'Convert Grok Build’s costUsdTicks to dollars, identify incomplete usage, and follow a two-model turn through Tokentracky’s cost accounting.',
    body: <>
      <h2>When does Tokentracky use Grok Build’s reported cost?</h2>
      <p>For a completed Grok Build turn with complete usage and a positive reported cost, Tokentracky converts <code>costUsdTicks</code> to microdollars. One tick is $0.0000000001. In the synthetic session, 12,345,678 ticks means $0.0012345678, which rounds to <strong>1,235 microdollars</strong>.</p>
      <h2>Match the reported amount to the model that used it</h2>
      <p>Open the <code>turn_completed</code> record in <code>updates.jsonl</code>. The example above has 1,000 input tokens including 600 cache reads, plus 50 output tokens including 20 reasoning tokens. Its total is 400 ordinary input + 600 cache reads + 50 output = 1,050 tokens.</p>
      <p>When <code>modelUsage</code> lists several models, read each model’s entry once. The next turn in the fixture assigns 2,100 tokens and 3,000 microdollars to one model, and 530 tokens and 160 microdollars to the other. Those entries already account for the combined turn total. A cancelled turn with no usage block contributes zero observed tokens.</p>
      <h2>Price a turn with incomplete usage</h2>
      <p>Check for <code>usageIsIncomplete</code> or <code>costIsPartial</code>. Either flag means the collector falls back to model pricing when available. The fixture’s incomplete turn includes a 999-tick amount. It has 300 input tokens, including 100 cache reads, and ten output tokens.</p>
      <p>Using the test’s synthetic rates of two microdollars per ordinary input token, one per cache-read token, and six per output token gives 200 × 2 + 100 × 1 + 10 × 6 = <strong>560 microdollars</strong>. Use this arithmetic to check how the estimate was derived. For what dollar figures mean on a public profile, see <a href="/blog/how-to-read-the-token-leaderboard">how to read the leaderboard</a>.</p>
    </>,
    sources: [
      { label: 'Inspect the Grok Build updates and synthetic price table', url: fixtures + 'grok/turn-usage' },
      { label: 'Match the computed costs to the per-model events', url: file + 'grok/turn-usage/rust-expected/events.json' },
    ],
  },
  {
    ...guide('zed-thread-usage-after-model-switch'),
    description: 'See how Tokentracky attributes new Zed thread tokens after a model switch and what happens when a later scan finds a lower counter or a deleted thread.',
    body: <>
      <h2>Which model gets the new tokens in a Zed thread?</h2>
      <p>Tokentracky assigns growth since the last scan to the model recorded at the thread’s update. Tokens already observed stay with their original model and day. In the synthetic Zed example, a thread’s first 6,000 tokens stay with Claude and its next <strong>2,450 tokens</strong> go to the newly selected model.</p>
      <h2>Follow the same thread across three scans</h2>
      <table><caption>Usage across the synthetic Zed database</caption><thead><tr><th scope="col">Scan</th><th scope="col">What the collector observes</th><th scope="col">Database total</th></tr></thead><tbody>
        <tr><th scope="row">First</th><td>6,000 tokens for <code>claude-sonnet-4-6</code> in this thread. Other threads account for 127.</td><td>6,127</td></tr>
        <tr><th scope="row">Second</th><td>The thread now names <code>gpt-5.6-terra</code>. Growth is 300 ordinary input + 2,000 cache reads + 150 output.</td><td>8,577</td></tr>
        <tr><th scope="row">Third</th><td>A replacement thread has lower counters and another thread has been deleted. Both contribute zero additional tokens.</td><td>8,577</td></tr>
      </tbody></table>
      <h2>What two observations can tell you about a model switch</h2>
      <p>The expected daily breakdown keeps 6,127 on October 22 and assigns the 2,450-token increase to October 23, the date of the thread update. A cumulative counter records the total at a point in time. If several model switches happen between scans, the final value alone cannot tell you which model handled each request or when it ran.</p>
      <p>When checking a report, compare the per-model and per-day entries as well as the grand total. Moving all 8,450 tokens in the growing thread to its new model would leave the overall sum looking correct and erase the earlier Claude usage. Deleting a thread from Zed also leaves previously observed usage in the local history. Public data removal is a separate operation described in <a href="/blog/what-joining-the-leaderboard-shares">what joining the leaderboard shares</a>.</p>
    </>,
    sources: [
      { label: 'Compare the three Zed scan states and expected summaries', url: fixtures + 'zed/thread-totals-grow/steps' },
      { label: 'Inspect the model and day breakdown after the switch', url: file + 'zed/thread-totals-grow/steps/02-thread-grows/expected/summary.json' },
    ],
  },
];
