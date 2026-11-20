import React from 'react';

const project = 'https://github.com/AuvreyDurelle/tokentracky';
const revision = '96621c89bf8b1d5a666c654fb945ee6ab1e01450';
const source = project + '/blob/' + revision;
const codexCase = 'fixtures/codex/forked-rollout-copies';

export const launchArticles = [
  {
    slug: 'how-tokentracky-counts-tokens',
    title: 'How Tokentracky counts AI coding tokens',
    description: 'Follow 605 tokens through a Codex session, a fork, and a subagent. The public Rust test shows exactly which usage belongs to each.',
    body: <>
      <p>A Codex session in our test data uses 330 tokens. Its owner forks the conversation, then starts a subagent. Both children open with some of the parent’s history. Add up the last counters in all three files and you get 1,045 tokens. The Rust collector records 605. You can account for every one of the 440 tokens between those answers.</p>
      <h2>Read the three files</h2>
      <p>The example uses synthetic records from October 20, 2026. In the parent file the first request uses 100 input tokens and 10 output tokens. The second uses 200 and 20. Its running total has reached 330. That distinction between the most recent request and the running total matters when reading a rollout.</p>
      <table><caption>Usage in the synthetic Codex rollouts</caption><thead><tr><th scope="col">Session</th><th scope="col">Final counter</th><th scope="col">Copied history</th><th scope="col">Own usage</th></tr></thead>
        <tbody><tr><th scope="row">Parent</th><td>330</td><td>0</td><td>330</td></tr><tr><th scope="row">Fork</th><td>550</td><td>330</td><td>220</td></tr><tr><th scope="row">Subagent</th><td>165</td><td>110</td><td>55</td></tr></tbody></table>
      <p>The fork starts with both parent requests and later does another 220 tokens of work. The subagent starts with just the first request and adds 55. Counting each session’s own contribution gives 330 + 220 + 55. In the Rust summary that is 550 input and 55 output tokens.</p>
      <h2>Why matching numbers alone would lose a real request</h2>
      <p>The parent’s second request and the fork’s new request each used 220 tokens. A rule that discarded every repeated amount would drop genuine work. Codex records the relationship between the sessions. Where the parent rollout is available, the collector can use its running counters to identify copied history. The Rust tests even cover a subagent whose copied records and fresh requests all carry the same timestamp.</p>
      <h2>Check the calculation yourself</h2>
      <p>Open the three files in the fixture’s <code>root</code> directory. Compare the final <code>total_token_usage</code> in each with the per-session totals in <code>rust-expected/sessions.json</code>. Use the Rust expectations for the current collector. The older expectations alongside them preserve the earlier result.</p>
      <p>The collector, local API, CLI, and Mac shell are published under the MIT license. The project maintains the hosted website and leaderboard API separately in a private repository. If you find a counting discrepancy, a small synthetic rollout and your expected arithmetic make a useful public issue. Keep the original personal log on your computer.</p>
      <p><a href="/join">Set up Tokentracky</a> to inspect your own usage in the local dashboard.</p>
    </>,
    sources: [
      { label: 'Three synthetic Codex rollouts', url: project + '/tree/' + revision + '/' + codexCase + '/root' },
      { label: 'Expected Rust session totals', url: source + '/' + codexCase + '/rust-expected/sessions.json' },
      { label: 'Rust tests for forks, counters, and timestamps', url: source + '/crates/collector/tests/codex_forks.rs' },
      { label: 'Project license', url: source + '/LICENSE' },
      { label: 'Repository and release scope', url: source + '/README.md#native-release-status' },
      { label: 'Public issue tracker', url: project + '/issues' },
    ],
  },
  {
    slug: 'what-joining-the-leaderboard-shares',
    title: 'What becomes public when you join the leaderboard?',
    description: 'See a synthetic session before and after aggregation, what approving a computer publishes, and why local and public totals can differ.',
    body: <>
      <p>You can open a private dashboard, inspect usage by project, and stop there. Creating a hosted account also leaves your local history in place. The action that publishes usage is approving a computer for the leaderboard. That first upload can include eligible history already on disk, including work from before you created the account.</p>
      <h2>Follow one day from the computer to the board</h2>
      <p>Consider the synthetic Codex example in our public tests. On the computer, the sessions have separate identifiers, a model, a project path, and timestamps. The three sessions contribute 330, 220, and 55 tokens. The published daily record groups their eligible usage together.</p>
      <table><caption>Selected fields from the October 20 fixture’s public record</caption><thead><tr><th scope="col">Field</th><th scope="col">Published value</th></tr></thead><tbody>
        <tr><th scope="row">UTC date</th><td>October 20, 2026</td></tr><tr><th scope="row">Tool and model</th><td>Codex · gpt-5-codex</td></tr><tr><th scope="row">Usage</th><td>605 tokens, including 550 input and 55 output</td></tr><tr><th scope="row">Estimated cost</th><td>Unknown in this fixture</td></tr>
      </tbody></table>
      <p>A profile can show daily totals, tools, models, token types, and estimated cost. A connected computer also sends recent hourly totals by tool. These support the last-24-hours figure and can show when you were active within a day. The public record carries no prompt, response, code, project path, or session identifier. If you use GitHub sign-in, your verified GitHub login may also appear on your public profile.</p>
      <h2>When private history is larger</h2>
      <p>Some Kilo databases preserve a fork with new message IDs and no durable link back to its parent. Two equal counters could represent a copied request or two independent requests. The collector retains observations from the affected database locally and excludes that history from publication. You can therefore see more tokens in your local export than on your profile after a successful sync.</p>
      <h2>Before approving a computer</h2>
      <p>Check the device name, match the short code shown on your computer, and read the publication details. A connected device shares the eligible tool, model, and cost breakdown together. To keep tracking privately, use the local dashboard without connecting it. If you later delete your Tokentracky account, the service removes the public profile and totals. The local history stays on your device, and copies that someone else saved can still exist.</p>
      <p><a href="/privacy">Read the privacy policy</a> for the account, device, and retention details.</p>
    </>,
    sources: [
      { label: 'Local sessions in the synthetic example', url: source + '/' + codexCase + '/rust-expected/sessions.json' },
      { label: 'Public buckets in the same example', url: source + '/' + codexCase + '/rust-expected/public-buckets.json' },
      { label: 'Accounting and publication scope', url: source + '/docs/ACCOUNTING_PUBLICATION_SCOPE.md' },
      { label: 'How to connect a computer', url: source + '/README.md#join-the-leaderboard' },
    ],
  },
  {
    slug: 'token-town-development-diary',
    title: 'Inside Token Town, from a token count to a town map',
    description: 'A development diary about turning published usage into a harvest, choosing a plot, and giving two towns with the same token total different resources.',
    body: <>
      <p>Imagine two people finishing the day with exactly the same token count. One spent most of it sending context to a model. The other got much longer replies. On a leaderboard the two numbers tie. In the local development build of Token Town, those two days can pay for different things.</p>
      <h2>Four resources from one harvest</h2>
      <p>Token Town uses eligible usage already published to a member’s leaderboard account. Bricks draw on the overall token count. Output contributes Power. Input and cache writes contribute Water. Reasoning contributes Crystals. A session can contribute to several resources. A player’s buildings and bonuses also affect the harvest.</p>
      <p>The prototype’s base rates include one Brick per million tokens, one Power per 10,000 output tokens, and one Water per 50,000 input or cache-write tokens. Take an invented million-token day with 800,000 ordinary input and 200,000 output, with no cache or reasoning tokens. Before bonuses, that mix gives one Brick, 20 Power, 16 Water, and zero Crystals. A day with the same total and more output would still yield one base Brick, but favor Power.</p>
      <h2>The first decision at the edge of the map</h2>
      <p>A new town starts at the edge of the settled area with a Town Hall. Open its harvest and compare the available resources with the room left in the stores. A full store can spill part of a collection. Before taking a large harvest, look at which resource is near its limit and what the next building or land claim costs.</p>
      <figure><img src="/assets/editorial/town-click-1440.webp" alt="Token Town with the Town Hall selected, its upgrade control, and a harvest spill warning" width={1120} height={700} loading="lazy" /><figcaption>The four-plot local-tester town on November 19. The Town Hall is selected, and the harvest panel flags a storage limit. Local development build, subject to change.</figcaption></figure>
      <p>Land has a physical constraint. A free plot must share an edge with your existing land, and water cannot be claimed. Imagine a river immediately east of the Town Hall and a free patch of forest to the north. The forest is a possible expansion. The far bank has to wait until your land reaches it another way. A second player may also have claimed an otherwise promising square.</p>
      <figure><img src="/assets/editorial/town-map-1440.webp" alt="The highlighted local-tester territory with neighboring settlements on the town map" width={1120} height={700} loading="lazy" /><figcaption>The same town in the November 19 development build, seen from the map. Highlighting picks out its territory among its neighbors.</figcaption></figure>
      <h2>What this build can show</h2>
      <p>The town view shows the owner’s stores and building choices. The map lets visitors see how neighboring settlements fit together, and a town visit is read-only. This diary describes the development build as of November 20, 2026. For an installable version and its supported features, check the public release notes.</p>
      <p>The underlying usage is already visible on the <a href="/">token leaderboard</a>. Pick a profile with a public token breakdown and consider which resource its usage would favor.</p>
    </>,
    sources: [
      { label: 'Published usage fields that supply the game', url: source + '/README.md#privacy' },
      { label: 'Public app releases', url: project + '/releases' },
    ],
  },
  {
    slug: 'how-to-read-the-token-leaderboard',
    title: 'How to read the AI token leaderboard',
    description: 'Compare two builders across a UTC week boundary, then see how tool filters and estimated costs change the way to read a ranking.',
    body: <>
      <p>On Monday morning a builder can drop from first to second without losing a single token from their account. The weekly board has started a new period. Open the all-time view and the older usage is still there.</p>
      <h2>A Sunday and a Monday</h2>
      <p>Here are two invented builders on a two-person board. Assume these are their only sessions. Sunday is November 15, 2026. Monday, November 16, begins a new UTC week.</p>
      <table><caption>Illustrative published tokens, with ranks as of Monday</caption><thead><tr><th scope="col">Builder</th><th scope="col">Sunday</th><th scope="col">Monday</th><th scope="col">This week</th><th scope="col">All time</th></tr></thead><tbody>
        <tr><th scope="row">Ash</th><td>900,000</td><td>10,000</td><td>#2 · 10,000</td><td>#1 · 910,000</td></tr><tr><th scope="row">River</th><td>40,000</td><td>80,000</td><td>#1 · 80,000</td><td>#2 · 120,000</td></tr>
      </tbody></table>
      <p>Weekly totals start at 00:00 UTC on Monday. Monthly totals start on the first day of the UTC calendar month. Someone reading on Sunday evening in the Americas may already be looking at Monday’s board. When comparing a screenshot with a live profile, match the period and check when each figure was recorded.</p>
      <figure><img src="/assets/editorial/leaderboard.webp" alt="Weekly Tokentracky leaderboard with one builder listed and about 2.3 billion tokens" width={1120} height={692} loading="lazy" /><figcaption>The project’s October 2026 board screenshot. Week is selected. The large token figure is rounded, and the adjacent dollar figure is an estimate for that period.</figcaption></figure>
      <h2>Change one control at a time</h2>
      <p>With the period fixed, select one tool to rank builders by usage in that tool. A builder with a large all-tools total can rank lower in Codex if most of their usage came from Claude Code. Searching for an alias narrows the displayed list while preserving its rank in the selected group.</p>
      <p>Sorting by estimated cost changes the order of the rows. The rank number still describes tokens. Different models and cache reads carry different prices, so two builders with identical token counts can have different estimates. A missing price leaves a cost unknown. Subscription charges and discounts can also differ from a list-price estimate.</p>
      <h2>Share enough context to reproduce the number</h2>
      <p>Quote the builder’s alias, token total, selected period, tool if filtered, and observation date. Those details let another reader repeat the comparison as new uploads arrive. The board measures client-reported usage. A rank alone cannot tell a reader what someone shipped, how long they worked, or what they paid.</p>
      <p><a href="/">Open the weekly board</a> or <a href="/?period=all">compare all-time totals</a>.</p>
    </>,
    sources: [
      { label: 'UTC ranking window calculation', url: source + '/packages/core/src/ranking.ts' },
      { label: 'Leaderboard and cost behavior', url: source + '/README.md#features' },
    ],
  },
];
