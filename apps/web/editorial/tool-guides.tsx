import React from 'react';

const fixtures = 'https://github.com/AuvreyDurelle/tokentracky/tree/96621c89bf8b1d5a666c654fb945ee6ab1e01450/fixtures/';
const file = 'https://github.com/AuvreyDurelle/tokentracky/blob/96621c89bf8b1d5a666c654fb945ee6ab1e01450/fixtures/';

export const toolGuides = [
  {
    slug: 'claude-code-cache-read-write-tokens',
    title: 'How to read Claude Code’s cache tokens',
    description: 'Reconcile a 161-token Claude Code request with separate cache reads, five-minute and one-hour cache writes, and reasoning tokens.',
    body: <>
      <p>A Claude Code usage record in our synthetic test has just 11 ordinary input tokens, yet the request totals 161. Most of the input came from a cache. To reproduce the total, separate the counters that add tokens from the counters that describe tokens already counted.</p>
      <h2>Reconstruct the input</h2>
      <p>The record reports 11 ordinary input tokens and 100 cache-read tokens. It has no top-level cache-creation total. Instead, the creation details contain 10 tokens written with a five-minute lifetime and 20 written with a one-hour lifetime. Together those writes add 30. The input side of the request is therefore 11 + 100 + 30, or 141 tokens.</p>
      <table><caption>Reading the remaining fields in the synthetic request</caption><thead><tr><th scope="col">Field</th><th scope="col">Count</th><th scope="col">How to use it</th></tr></thead><tbody>
        <tr><th scope="row">Output</th><td>20</td><td>Add to the 141 input-side tokens.</td></tr>
        <tr><th scope="row">Reasoning</th><td>7</td><td>Describes seven of the 20 output tokens.</td></tr>
        <tr><th scope="row">One-hour writes</th><td>20</td><td>Describes twenty of the 30 cache-write tokens.</td></tr>
      </tbody></table>
      <p>The final count is 141 + 20 = 161. Adding the two descriptive fields again would inflate it to 188. Keeping those fields still matters. The one-hour figure tells the pricing calculation how many writes had that lifetime. The reasoning figure tells the person reading the report something about the output.</p>
      <h2>Reconcile a local total</h2>
      <p>Start with ordinary input, output, cache reads, and cache writes from the same request. Add them once. Then check the one-hour and reasoning figures against their respective parent categories. To follow the exact example without opening personal transcripts, compare the fixture’s one-line session with the Rust summary. The summary keeps the breakdown even though this particular test has no cost estimate.</p>
    </>,
    sources: [
      { label: 'Raw Claude Code fixture', url: file + 'claude/cache-creation-subcategories/root/session.jsonl' },
      { label: 'Expected Rust accounting summary', url: file + 'claude/cache-creation-subcategories/rust-expected/summary.json' },
    ],
  },
  {
    slug: 'gemini-cli-tool-use-tokens',
    title: 'Where Gemini CLI’s tool-use tokens go',
    description: 'Read two Gemini CLI messages and reproduce the collector’s 565-token total, including cached input and tokens used in a tool prompt.',
    body: <>
      <p>Suppose you are adding a Gemini CLI session by hand. One message says it used 500 input tokens, 20 output tokens, 100 cached tokens, and 30 tool tokens. Adding those four numbers gives 650. The collector records 550 for that message. The difference is the 100 tokens the input field already includes.</p>
      <h2>Separate the cached part, then add the tool prompt</h2>
      <p>The synthetic message contains 500 input tokens including 100 cached. That leaves 400 ordinary input tokens. Gemini’s 30 tool-use prompt tokens belong on the input side as well, bringing the ordinary input figure to 430. The final accounting for this message is 430 ordinary input + 100 cache reads + 20 output = 550.</p>
      <p>The test deliberately gives this message a reported <code>total</code> of 999,999. Reading that field as an extra charge, or trusting it over the component counts here, would swamp the entire session. You can see the outlier directly in the raw JSONL file.</p>
      <h2>Check the neighboring messages</h2>
      <p>The next message uses 10 input and five output tokens. Its cached and thought counters are null, so those optional quantities contribute zero. A third message has zero usage. The session ends at 565 tokens. Its aggregate shows 440 ordinary input, 100 cache reads, and 25 output. Those three figures sum back to 565.</p>
      <p>When investigating a discrepancy, compare one message at a time before adding the whole file. Check whether the tool wrote its cache count inside the input figure and whether it supplied a separate tool-prompt count. Counter names that look familiar across tools can describe different parts of a request.</p>
    </>,
    sources: [
      { label: 'Gemini CLI fixture and raw messages', url: fixtures + 'gemini/tool-use-and-optional-counters' },
      { label: 'Expected Gemini Rust summary', url: file + 'gemini/tool-use-and-optional-counters/rust-expected/summary.json' },
    ],
  },
  {
    slug: 'goose-session-totals-and-usage-ledger',
    title: 'When a Goose session moves into the usage ledger',
    description: 'Trace a Goose database through two scans and see why a 13,200-token carried-forward row adds only 2,200 new tokens.',
    body: <>
      <p>A Goose database can tell the same story in two places. An older session may have an accumulated token total. Later, its usage ledger can acquire a row that carries earlier usage forward. Counting every newly discovered row in full would make old work appear again on the day the ledger changed.</p>
      <h2>The first scan</h2>
      <p>In the synthetic database, one session has accumulated 11,000 tokens and has no ledger rows. Another has two valid ledger entries worth 5,400 and 2,100 tokens. A third ledger entry claims 175 total for 100 input and 50 output. Its component counts do not support the claimed total, so the reader skips it. Together the valid records account for 18,500 tokens.</p>
      <h2>The second scan</h2>
      <p>The older session now has a carried-forward ledger row for 13,200 tokens. The collector already recorded 11,000 from that session. The carried-forward row therefore contributes 2,200 newly observed tokens. A separate, fresh ledger row contributes another 3,300. The session reaches 16,500, and the total across the database grows from 18,500 to 24,000.</p>
      <p>Adding both new rows to the old database total would produce 35,000. The difference between 35,000 and the expected 24,000 is exactly the old session’s 11,000. This is a useful way to recognize a carry-forward error in a report.</p>
      <h2>Inspect the transition</h2>
      <p>The public example includes two short SQL files. In the first, follow the session with the 11,000-token accumulated total. In the second, find its <code>carried_forward</code> entry and the distinct row for fresh use. You can trace the entire adjustment from token and session fields without reading conversation text.</p>
    </>,
    sources: [
      { label: 'First synthetic Goose database', url: file + 'goose/ledger-and-session-totals/steps/01-first-scan/root/sessions.db.sql' },
      { label: 'Ledger additions on the second scan', url: file + 'goose/ledger-and-session-totals/steps/02-ledger-takes-over/root/sessions.db.sql' },
      { label: 'Expected total after reconciliation', url: file + 'goose/ledger-and-session-totals/steps/02-ledger-takes-over/step.json' },
    ],
  },
  {
    slug: 'grok-build-token-cost-receipts',
    title: 'Where a Grok Build cost figure comes from',
    description: 'Follow a completed Grok Build turn from xAI’s cost ticks into microdollars, then inspect what changes when usage is marked incomplete.',
    body: <>
      <p>Grok Build writes a cost alongside a completed turn. That gives the collector more information than token counts and a public price table alone. Our synthetic session contains both a complete usage record and an incomplete one. They take different paths to the cost column.</p>
      <h2>A completed turn with a reported cost</h2>
      <p>One turn records 1,000 input and 50 output tokens. Of the input, 600 were cache reads. Of the output, 20 were reasoning tokens. Splitting those fields leaves 400 ordinary input, 600 cache reads, and 50 output, for 1,050 tokens.</p>
      <p>The same turn records 12,345,678 in <code>costUsdTicks</code>. Each tick is one ten-billionth of a US dollar. That gives $0.0012345678, which the collector rounds to 1,235 microdollars. Another turn in the fixture names two models. Their individual usages and reported costs let the reader assign each part to the right model without adding the combined turn total again.</p>
      <h2>A turn marked incomplete</h2>
      <p>A later turn has 300 input tokens, including 100 cache reads, and 10 output tokens. The update sets <code>usageIsIncomplete</code>. The test supplies synthetic prices of two microdollars per ordinary input token, one per cache-read token, and six per output token. The resulting estimate is 200 × 2 + 100 × 1 + 10 × 6 = 560 microdollars. These are fixture rates, unsuitable for predicting a real Grok bill.</p>
      <p>The session also contains a cancelled turn with no recorded usage. It contributes zero observed tokens. For a discrepancy in your own report, look for a completed turn with a usage block and check whether it is marked incomplete. A message or cancellation by itself cannot supply a token count.</p>
    </>,
    sources: [
      { label: 'Grok Build test session and synthetic prices', url: fixtures + 'grok/turn-usage' },
      { label: 'Expected per-model tokens and costs', url: file + 'grok/turn-usage/rust-expected/events.json' },
    ],
  },
  {
    slug: 'zed-thread-usage-after-model-switch',
    title: 'What happens to a Zed thread’s tokens when you switch models?',
    description: 'Follow one edited Zed thread across three scans. Its original usage stays with the first model and only the newly observed growth changes the totals.',
    body: <>
      <p>Imagine returning to a Zed thread the next morning and choosing another model. The stored thread now names the new model and has a larger running token count. Assigning the entire thread to its current model would rewrite yesterday’s model chart every time you switched.</p>
      <h2>Read the change between scans</h2>
      <p>Our synthetic database starts at 6,127 tokens across several threads. Of those, one thread accounts for 6,000 under <code>claude-sonnet-4-6</code>. On the next scan, that thread has changed model and its counters have grown. The new work consists of 300 ordinary input, 2,000 cache reads, and 150 output, or 2,450 tokens.</p>
      <p>The collector gives those 2,450 to the thread’s current model, <code>gpt-5.6-terra</code>, at the update time of the thread. Yesterday’s 6,000 stay with Claude. The other threads still account for 127, bringing the database total to 8,577. This accounting relies on the earlier observation. A cumulative figure by itself cannot reconstruct every model switch or request time between scans.</p>
      <h2>Deleting a thread after it was observed</h2>
      <p>In the third scan the fixture replaces a thread with a lower counter and deletes another. The expected total stays at 8,577. Removing a conversation from Zed does not subtract usage the collector previously observed. The same principle lets the local daily breakdown survive changes to the list of visible threads.</p>
      <p>To check this behavior, open the three expected summaries in order. Compare the model entries as well as the overall total. An unchanged grand total could otherwise hide an error that silently moved yesterday’s tokens from one model to another.</p>
    </>,
    sources: [
      { label: 'Zed fixture and three scan states', url: fixtures + 'zed/thread-totals-grow' },
      { label: 'Model breakdown after the thread grows', url: file + 'zed/thread-totals-grow/steps/02-thread-grows/expected/summary.json' },
      { label: 'Model breakdown after replacement and deletion', url: file + 'zed/thread-totals-grow/steps/03-thread-replaced-and-deleted/expected/summary.json' },
    ],
  },
];
