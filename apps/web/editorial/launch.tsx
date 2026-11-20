import React from 'react';

const project = 'https://github.com/AuvreyDurelle/tokentracky';
const revision = '96621c89bf8b1d5a666c654fb945ee6ab1e01450';
const source = project + '/blob/' + revision;
const codexCase = 'fixtures/codex/forked-rollout-copies';

export const launchArticles = [
  {
    slug: 'how-tokentracky-counts-tokens',
    title: 'How Tokentracky counts AI coding tokens',
    description: 'Trace 605 Codex tokens through the open-source Rust collector. See how it counts a parent session, a fork, and a subagent without counting copied history twice.',
    body: <>
      <h2>How does Tokentracky count a Codex session?</h2>
      <p>Tokentracky reads the usage counters Codex writes on your computer. When a fork inherits earlier work, the collector counts the new tokens each session contributed. In the public test below, the final counters add up to 1,045 tokens. Of those, 440 appear a second time in copied history, leaving 605 tokens of work.</p>
      <h2>Trace the 605 tokens across three files</h2>
      <p>In our synthetic October 20, 2026 example, the parent’s first request uses 100 input and 10 output tokens. The second uses 200 input and 20 output. The second request used 220 tokens, and the session’s running counter now reads 330.</p>
      <table><caption>Final counters from the three Codex rollouts</caption><thead><tr><th scope="col">Session</th><th scope="col">Final counter minus copied tokens</th><th scope="col">New tokens</th></tr></thead>
        <tbody><tr><th scope="row">Parent</th><td>330 − 0</td><td>330</td></tr><tr><th scope="row">Fork</th><td>550 − 330</td><td>220</td></tr><tr><th scope="row">Subagent</th><td>165 − 110</td><td>55</td></tr></tbody></table>
      <p>The fork inherits both requests. The subagent inherits only the first. Their new work brings the combined count to 330 + 220 + 55, or 550 input and 55 output tokens.</p>
      <p>Notice that the parent’s second request and the fork’s fresh request both used 220 tokens. Dropping every repeated amount would erase one real request. Codex records which session a child came from. When the parent rollout is available, the collector compares the running counters against that history. The Rust tests cover copied records and fresh subagent work that even share a timestamp. If the parent file is missing, the collector has less evidence. In a separate test where every entry has the fork’s timestamp and the parent is absent, the fallback skips genuine subagent work too.</p>
      <h2>Reproduce the count from the open-source fixture</h2>
      <ol>
        <li>Open the fixture listed below. Its <code>root</code> directory contains the parent, fork, and subagent logs. Find the last <code>total_token_usage</code> in each file.</li>
        <li>Compare those counters with <code>rust-expected/sessions.json</code>. It lists the 330, 220, and 55 tokens attributed to each session by the current Rust collector. The adjacent <code>expected</code> directory preserves the earlier result.</li>
        <li>Compare your own usage privately in the local dashboard. If you report a discrepancy in the public issue tracker, replace the personal log with a synthetic example and specify the total you expected.</li>
      </ol>
      <p>The project publishes the collector, local API, CLI, and Mac shell under the MIT license. It maintains the hosted website and leaderboard API in a separate private repository. You can <a href="/join">install the local tracker</a> to inspect your numbers, then read <a href="/blog/what-joining-the-leaderboard-shares">what becomes public when you connect a computer</a>.</p>
    </>,
    sources: [
      { label: 'Codex test fixture, raw logs, and expected Rust totals', url: project + '/tree/' + revision + '/' + codexCase },
      { label: 'Rust tests for forks, counters, and timestamps', url: source + '/crates/collector/tests/codex_forks.rs' },
      { label: 'Public project, license, and hosted repository scope', url: source + '/README.md#native-release-status' },
    ],
  },
  {
    slug: 'what-joining-the-leaderboard-shares',
    title: 'What becomes public when you join the leaderboard?',
    description: 'Approving a computer publishes eligible token totals by tool and model. See the actual upload fields, which history is included, and what stays on your device.',
    body: <>
      <h2>What leaves your computer when you connect it?</h2>
      <p>Approving a computer publishes eligible usage, including history from before you created your account. Your profile can show daily totals, tool and model names, token types, and estimated cost. Prompts, responses, code, project paths, and session identifiers stay on your computer. You can inspect usage by project in the local dashboard before connecting. Creating an account also leaves your computer unlinked until you approve it.</p>
      <h2>One day of Codex usage, before and after upload</h2>
      <p>Our <a href="/blog/how-tokentracky-counts-tokens">worked Codex example</a> has three local sessions. Each has an identifier, a model, a project path, and timestamps. Their respective contributions of 330, 220, and 55 tokens become one daily record because they share the same UTC day, tool, and model.</p>
      <table><caption>Selected fields in the synthetic public record</caption><thead><tr><th scope="col">Field</th><th scope="col">Published value</th></tr></thead><tbody>
        <tr><th scope="row">UTC date</th><td>October 20, 2026</td></tr><tr><th scope="row">Tool and model</th><td>Codex · gpt-5-codex</td></tr><tr><th scope="row">Usage</th><td>605 tokens, including 550 input and 55 output</td></tr><tr><th scope="row">Estimated cost</th><td>Unknown in this example</td></tr>
      </tbody></table>
      <p>Connected computers also send recent hourly totals by tool. The last-24-hours chart can therefore reveal which hours you were active. If you use GitHub sign-in, your verified GitHub login may appear alongside your leaderboard alias.</p>
      <h2>Why your local export can show more tokens</h2>
      <p>Some Kilo databases save forked messages under new IDs and leave no durable link to their parent. Two equal counters could be independent requests or copies of one request. Tokentracky recognizes the Kilo v1 database by its <code>message(id, session_id, time_created, data)</code> table. New uploads exclude every event from that database, even when the v1 table is empty or the same database also contains v2 records. Your local export keeps those events.</p>
      <p>If an older collector already uploaded affected history, the old totals can still appear on your profile. If the collector reports <code>PUBLICATION_REVIEW_REQUIRED</code>, open <a href="/you">your account</a>. Under <strong>Your listing</strong>, enter a different available leaderboard name and select <strong>Save name</strong>. This changes your public name and clears previously uploaded totals across the account. Reconnect the affected device, then let each connected computer sync its own eligible history. Totals from a removed computer stay cleared unless you reconnect it and sync its history again.</p>
      <h2>What to check before approving a device</h2>
      <p>Read the device name, match the short code on your computer with the one on the approval page, and check the alias you intend to publish under. Approval shares eligible history with its tool, model, and cost breakdown together. To keep usage private, continue using the local dashboard without approving a device.</p>
      <p>If you later delete your Tokentracky account, the service removes the public profile and totals. Your local history remains, and other people may still have copies they saved. The <a href="/join">connection guide</a> walks through joining, and the <a href="/privacy">privacy policy</a> covers device data, deletion, and retention.</p>
    </>,
    sources: [
      { label: 'Local sessions in the synthetic example', url: source + '/' + codexCase + '/rust-expected/sessions.json' },
      { label: 'Public buckets in the same example', url: source + '/' + codexCase + '/rust-expected/public-buckets.json' },
      { label: 'Accounting and publication scope', url: source + '/docs/ACCOUNTING_PUBLICATION_SCOPE.md' },
    ],
  },
  {
    slug: 'token-town-development-diary',
    title: 'How Token Town turns AI coding tokens into a town',
    description: 'Inside the Token Town development build, a million-token example shows how usage becomes four resources, what fits in storage, and where a town can expand.',
    body: <>
      <h2>What is Token Town?</h2>
      <p>Token Town is a city-building game in development that turns eligible usage from your Tokentracky leaderboard account into resources. You collect a harvest, use your stores to build or upgrade, and claim neighboring land. Two players can publish the same number of AI coding tokens and come away with different supplies because the game also looks at how those tokens were used.</p>
      <h2>How the same token total can yield different resources</h2>
      <p>In the November 20, 2026 development build, total tokens feed Bricks, output feeds Power, input and cache writes feed Water, and reasoning feeds Crystals. One session can supply several resources. Buildings and bonuses affect the harvest you see in town.</p>
      <p>For an illustrative calculation, suppose a million tokens yield one Brick, 10,000 output tokens yield one Power, and 50,000 input tokens yield one Water. With those example rates, 800,000 input and 200,000 output yield one Brick, 20 Power, and 16 Water. Swap the two counts and you get one Brick, 80 Power, and four Water. Both examples have zero reasoning tokens and yield no Crystals. The players tie on token volume, yet their harvests favor different buildings.</p>
      <h2>When to collect and where to build</h2>
      <p>A new town starts with a Town Hall at the edge of the settled area. Compare your harvest with the room left in each store. Collecting more of a resource than fits can spill the excess. Builds, upgrades, and land claims collect first. If you have room for ten Water and the harvest offers twelve, two spill before the building cost comes out of storage.</p>
      <figure><img src="/assets/editorial/town-click-1440.webp" alt="Token Town with the Town Hall selected, its upgrade control, and a harvest spill warning" width={1120} height={700} loading="lazy" /><figcaption>The four-plot local-tester town on November 19. The Town Hall is selected, and the harvest panel flags a storage limit. Local development build, subject to change.</figcaption></figure>
      <p>A plot must be free, on land, and share an edge with your territory. Suppose there’s a river east of the Town Hall and an unclaimed forest square immediately north. You can expand into the forest. Reaching the far bank takes a route around the water, and land already claimed by another player is occupied.</p>
      <figure><img src="/assets/editorial/town-map-1440.webp" alt="The highlighted local-tester territory with neighboring settlements on the town map" width={1120} height={700} loading="lazy" /><figcaption>The same town in the November 19 development build, seen from the map. Highlighting picks out its territory among its neighbors.</figcaption></figure>
      <h2>Where can you see the game?</h2>
      <p>These images come from the local development build. An owner’s town view shows stores and building choices. Visitors can explore the map and open read-only views of neighboring towns. For availability in an installable version, check its public release notes.</p>
      <p>To see why the mix matters, open the <a href="/">token leaderboard</a> and compare the input and output counts on a public profile. The in-game harvest panel shows the resources a player can actually collect. The <a href="/blog/what-joining-the-leaderboard-shares">guide to public usage data</a> explains where those figures come from.</p>
    </>,
    sources: [
      { label: 'Published usage fields that supply the game', url: source + '/README.md#privacy' },
      { label: 'Public app releases', url: project + '/releases' },
    ],
  },
  {
    slug: 'how-to-read-the-token-leaderboard',
    title: 'How to read the AI token leaderboard',
    description: 'Tokentracky ranks builders by client-reported tokens. See when the weekly board resets, how tool filters affect rank, and what cost sorting changes.',
    body: <>
      <h2>What does a leaderboard rank measure?</h2>
      <p>A Tokentracky rank shows how a builder’s published token usage compares with other builders for the selected period and tool. The weekly board starts over on Monday at 00:00 UTC. All-time rankings still include earlier usage, so the same builder can be first all time and second this week.</p>
      <h2>Compare the weekly and all-time views</h2>
      <p>Imagine a two-person board with only two days of activity. On Sunday, November 15, 2026, Ash published 900,000 tokens and River published 40,000. On Monday Ash added 10,000 and River added 80,000. These invented totals put a different builder in first place in each view.</p>
      <table><caption>Illustrative standings on Monday, November 16, 2026</caption><thead><tr><th scope="col">Builder</th><th scope="col">This week</th><th scope="col">All time</th></tr></thead><tbody>
        <tr><th scope="row">Ash</th><td>#2 · 10,000</td><td>#1 · 910,000</td></tr><tr><th scope="row">River</th><td>#1 · 80,000</td><td>#2 · 120,000</td></tr>
      </tbody></table>
      <p>The monthly total begins on the first day of the UTC calendar month. The last-24-hours view uses the 24 completed UTC hours before the current hour. At 14:30 UTC, the window starts at 14:00 UTC the previous day and includes the 24 completed hours ending just before 14:00 UTC today. In the Americas a new weekly period can already be under way on Sunday evening local time. When comparing a screenshot with a live board, check both the period selector and the date the screenshot was taken.</p>
      <figure><img src="/assets/editorial/leaderboard.webp" alt="Weekly Tokentracky leaderboard with one builder listed and about 2.3 billion tokens" width={1120} height={692} loading="lazy" /><figcaption>The project’s October 2026 board screenshot. Week is selected. The large token figure is rounded, and the adjacent dollar figure is an estimate for that period.</figcaption></figure>
      <h2>What tool filters, alias search, and cost sorting change</h2>
      <ul>
        <li><strong>Choose a tool</strong> to rank builders by that tool’s tokens. Someone with a high all-tools rank may place lower in Codex if most of their published usage came from Claude Code.</li>
        <li><strong>Search an alias</strong> to find it in the current rankings. The search narrows the visible rows and preserves each builder’s rank in the selected group.</li>
        <li><strong>Sort by estimated cost</strong> in the weekly, monthly, or all-time view to rank the rows by dollar amount across all tools. Builders with unknown estimates appear last. The rank printed beside each builder still follows token volume. Model and cache prices can differ, a missing price leaves a cost unknown, and subscriptions or discounts may change what the builder actually paid.</li>
      </ul>
      <h2>How to quote a rank someone else can check</h2>
      <p>For the example above, write “Ash ranked second with 10,000 tokens across all tools for the UTC week beginning November 16, observed that Monday.” Include the actual alias, period, tool filter, total, and observation date when sharing a live figure. Client-reported usage alone cannot establish what someone shipped, how long they worked, or what they spent.</p>
      <p><a href="/">Open the weekly board</a> or <a href="/?period=all">compare all-time totals</a>.</p>
    </>,
    sources: [
      { label: 'UTC ranking window calculation', url: source + '/packages/core/src/ranking.ts' },
      { label: 'Leaderboard and cost behavior', url: source + '/README.md#features' },
    ],
  },
];
