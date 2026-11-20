import React from 'react';
import { guide } from '../src/footer-guides';

const source = 'https://github.com/AuvreyDurelle/tokentracky/blob/96621c89bf8b1d5a666c654fb945ee6ab1e01450/';

export const reportGuides = [
  {
    ...guide('export-ai-token-usage-csv'),
    description: 'Export AI token usage from the local dashboard, check the CSV against the selected period, and decide when the CLI’s JSON summary is enough.',
    body: <>
      <h2>Download the token records behind your chart</h2>
      <p>Open <strong>Tokens</strong> in your local Tokentracky dashboard, select the tool and period you want, then choose <strong>Export CSV</strong>. You get one row per usage event. Even when the screen shows a breakdown by model or project, the export gives you the underlying records so you can group them yourself.</p>
      <p>For a report on Claude Code over the last seven days, choose <strong>7d</strong> and <strong>Claude Code</strong> before downloading. For the 7d, 30d, 90d and 12m presets, the file name includes the first and last UTC dates, so two exports made on different weeks are easy to tell apart. The CSV includes the timestamp, project path and session identifier where available. Review those columns before sending a spreadsheet to someone else. The <a href="/blog/what-joining-the-leaderboard-shares">public leaderboard breakdown</a> uses a different set of fields.</p>
      <h2>Read one row before adding up the file</h2>
      <table><caption>Column names in the local CSV</caption><thead><tr><th scope="col">Columns</th><th scope="col">What you can do with them</th></tr></thead><tbody>
        <tr><th scope="row"><code>tool</code>, <code>model</code>, <code>timestamp</code></th><td>Identify the tool, model and time associated with the event.</td></tr>
        <tr><th scope="row"><code>project</code>, <code>session</code></th><td>Group events from the same folder or session. The project cell is empty when the tool supplied no folder.</td></tr>
        <tr><th scope="row"><code>input</code>, <code>output</code>, <code>cache_read</code>, <code>cache_write</code>, <code>reasoning</code>, <code>total</code></th><td>Sum the total column for usage. Reasoning is already included in output.</td></tr>
        <tr><th scope="row"><code>cost_microusd</code></th><td>Divide by one million for dollars. An empty cell means the cost is unknown. Keep it distinct from a recorded zero.</td></tr>
      </tbody></table>
      <p>In the public dashboard test, the rows dated October 22 and 23, 2026 each contain 11 input, 20 output, 100 cache reads and 30 cache writes. Each totals 161. Use the two rows in the linked fixture, or filter an exported spreadsheet that covers those two UTC dates. Their sum should be <strong>322 tokens</strong>. With the header in row 1 and just those two records underneath, enter <code>=SUM(K2:K3)</code> in an empty cell. Column K is <code>total</code>. A result of 336 means you added the seven reasoning tokens from each row a second time.</p>
      <h2>Choose CSV or a JSON status report</h2>
      <p>Use CSV to calculate a daily total or build a spreadsheet pivot. On the Tokens page, compare the sum of <code>total</code> with the token headline for the same tool and range. Hover over a rounded headline to see the exact count. For a script that only needs current totals, source health or the last refresh time, run <code>tokentracky status --json</code>. Its week starts on Monday in the computer’s time zone, so the JSON week can differ from the dashboard’s last seven UTC dates.</p>
    </>,
    sources: [
      { label: 'Inspect the dated export rows and expected query results', url: source + 'fixtures/claude/dashboard-queries/rust-expected/queries.json' },
      { label: 'Read the CLI status fields and time-window definitions', url: source + 'crates/cli/README.md' },
    ],
  },
  {
    ...guide('ai-token-usage-by-project'),
    description: 'Find which project used the most AI coding tokens on your computer, compare tools over the same dates, and account for usage with no project path.',
    body: <>
      <h2>Find the folder behind a busy week</h2>
      <p>On the local <strong>Tokens</strong> page, choose <strong>7d</strong> and <strong>All tools</strong>. Scroll to <strong>Breakdown</strong> and select <strong>Project</strong>. The first row is the named project with the most tokens in those seven UTC dates, including today. Its <strong>Share</strong> uses all the tokens counted for your selected tool and period.</p>
      <p>Start the private dashboard with <code>tokentracky serve</code>, or use <code>tokentracky open</code> if the collector is already running. An empty dashboard with the message “Tokentracky isn’t reading any tools yet” has a setup step first. Open Settings and choose the coding tools whose local records you want to read.</p>
      <h2>Compare two projects that each had one session</h2>
      <p>Tokentracky’s two-tool test logs both sessions at noon UTC on October 20, 2026. One Claude Code session ran in <code>/synthetic/private-project</code>. One Codex session ran in <code>/synthetic/codex-project</code>. For a range covering those records, the project breakdown works out as follows.</p>
      <table><caption>Project shares for the 271 tokens in the example</caption><thead><tr><th scope="col">Project</th><th scope="col">Tokens</th><th scope="col">Share with All tools</th></tr></thead><tbody>
        <tr><th scope="row">private-project</th><td>161</td><td>59%</td></tr>
        <tr><th scope="row">codex-project</th><td>110</td><td>41%</td></tr>
      </tbody></table>
      <p>The projects tie on session count. Their token usage differs by 51. Keep the dates fixed and switch the tool filter to <strong>Codex</strong>. The Codex project still has 110 tokens, and its share changes to 100% because those are all the Codex tokens in the example.</p>
      <p>To see which session contributed the 110, select <strong>Export CSV</strong>. In the spreadsheet, filter <code>project</code> to <code>/synthetic/codex-project</code>, group by <code>session</code>, and sum <code>total</code>. The fixture has one matching session, <code>codex-session</code>, with all 110 tokens.</p>
      <h2>Account for tokens without a project name</h2>
      <p>The table can only group events with a recorded project path. For example, Gemini CLI records a hash of its project folder. Tokentracky can count its tokens without assigning them to a named folder. If the project shares add up to less than 100%, export the same selection and check for empty <code>project</code> cells before attributing the difference to another repository. Small differences can also come from rounded percentages.</p>
      <p>Keep project comparisons on the computer that collected the records. The public profile receives aggregate token totals. Project names and paths stay local, as described in the <a href="/privacy">privacy policy</a>.</p>
    </>,
    sources: [
      { label: 'Inspect the two local usage records', url: source + 'fixtures/multi-tool/private-tool-split/expected/export.csv' },
      { label: 'See which coding tools record a project folder', url: source + 'README.md#supported-tools' },
    ],
  },
  {
    ...guide('ai-coding-usage-heatmap'),
    description: 'Read a Tokentracky activity heatmap by UTC day. Find exact token counts, interpret the four shades, and check why a day can differ from the 24-hour view.',
    body: <>
      <h2>Read the date and count behind a square</h2>
      <p>Open a builder’s public profile from the <a href="/">leaderboard</a> and find <strong>Activity</strong>. Each square shows the tokens published for one UTC day in the past 365 days. Hover over a square to read its date and exact token count. With a keyboard, tab to the grid. The left and right arrows move a week and the up and down arrows move a day.</p>
      <p>Weeks run down the column from Monday at the top to Sunday at the bottom. A session can contribute to two squares. For example, 120 tokens recorded at 23:58 UTC on November 10 and 240 at 00:03 UTC on November 11 add 120 to Tuesday and 240 to Wednesday, even if the local clock showed the same evening for both.</p>
      <h2>What the four shades measure</h2>
      <p>The scale groups active dates into four levels by token volume. A square can include many sessions, and a single long session can span several dates. Suppose the only four active days contain 120, 240, 360 and 24,000 tokens. They get successively stronger shades. Days with zero published tokens stay in the empty shade and do not affect the cutoffs. That large last day still leaves three visibly different levels for the smaller days.</p>
      <p>Two builders can have the same shade on a Tuesday and quite different token totals. To compare shorter windows, use the chart above <strong>Activity</strong>. Select <strong>Calendar</strong> and switch from <strong>30d</strong> to <strong>90d</strong>. A date can change shade because the chart recalculates its scale for the selected days. Read the numeric value beneath the grid when comparing dates or profiles.</p>
      <h2>Why today’s square differs from the last 24 hours</h2>
      <p>Today’s square begins at midnight UTC. The profile’s <strong>24h</strong> chart shows the most recent 24 completed UTC hours, which can span two dates. At 14:30 UTC on November 11, it covers November 10 at 14:00 up to, but excluding, November 11 at 14:00. Both records in the midnight example fall in that window, for 360 tokens across the two squares. If a computer has yet to sync hourly totals, the chart can show “No hourly totals synced yet.”</p>
    </>,
    sources: [
      { label: 'See how the calendar assigns shades to active days', url: source + 'packages/core/src/share.ts' },
      { label: 'Check the calendar’s UTC layout and keyboard controls', url: source + 'apps/web/src/Heatmap.tsx' },
    ],
  },
  {
    ...guide('share-ai-coding-year-in-review'),
    description: 'Get your AI coding year in review or monthly Tokentracky wrap. Choose the right link, read a partial year, and share a card with its dates and rank intact.',
    body: <>
      <h2>Get your annual or monthly wrap</h2>
      <p>On a computer connected to the leaderboard, run <code>tokentracky share</code> and open <strong>This year</strong> for your AI coding year in review. The command needs a network connection to look up your published alias. <strong>This month</strong> opens the monthly edition. You can also open your public profile and choose a period under <strong>Share this profile → Wrapped</strong>. It offers last month, this month and this year.</p>
      <p>For a script, <code>tokentracky share --json</code> returns the same two addresses under <code>year</code> and <code>month</code>. The CLI test uses the alias <code>cli-builder</code> on November 19, 2026. Its year link ends in <code>/wrapped/cli-builder/2026</code>, and its month link ends in <code>/wrapped/cli-builder/2026-11</code>. Use the URL printed for your own alias.</p>
      <h2>Put a year-to-date total in context</h2>
      <p>A year starts on January 1 UTC and a month on its first UTC day. An open period includes published usage through today. A year wrap viewed on November 19 therefore covers January 1 through November 19. The previous-year figure covers the whole preceding calendar year. For a comparison of complete periods, use the earlier-period button at the top of the wrap. A percentage change appears when the wrap reaches its final UTC date and the preceding period had tokens.</p>
      <p>Consider a completed October with 3.4 million tokens after 2 million in September. The gain is 1.4 million, or <strong>70%</strong>. A rank of #4 of 120 means fourth among builders with published usage that October. Sixteen active days means sixteen UTC dates with usage. If a priced total cannot be calculated for all the records, the wrap can show “Pricing unknown” while the token count remains available.</p>
      <h2>Share the period you actually read</h2>
      <p>Check the alias and year or month in the heading, then use <strong>Copy link</strong> on the wrap page. Someone opening that link later sees the same calendar period with the usage published at that time. Choose <strong>Save image</strong> if you want a PNG of the card as it stands today. For an unfinished year, include the cutoff in your caption, such as “AI coding tokens from January 1 through November 19 UTC.”</p>
      <p>To include usage from a computer you have kept private, you would need to approve that computer for publication. The <a href="/blog/what-joining-the-leaderboard-shares">leaderboard privacy guide</a> explains which history a connected computer publishes.</p>
    </>,
    sources: [
      { label: 'Inspect the CLI share links and example alias', url: source + 'crates/cli/src/share.rs' },
      { label: 'Check the calendar rules for monthly and yearly wraps', url: source + 'packages/core/src/share.ts' },
    ],
  },
];
