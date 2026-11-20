import React from 'react';
import { guide } from '../src/footer-guides';

const source = 'https://github.com/AuvreyDurelle/tokentracky/blob/96621c89bf8b1d5a666c654fb945ee6ab1e01450';

export const contributorGuides = [
  {
    ...guide('build-open-source-token-tracker'),
    description: 'Build Tokentracky’s native CLI and embedded dashboard from the public source, then use an isolated status check to verify the executable you compiled.',
    body: <>
      <h2>Build the dashboard before the Rust executable</h2>
      <p>Tokentracky’s open-source token tracker fits in a single executable. The build has two parts. npm produces the local dashboard’s HTML, JavaScript, and CSS. Cargo embeds those files alongside the Rust collector. You can check the finished CLI without importing a session or connecting a leaderboard account.</p>
      <p>On macOS or Linux, install Git, Node 22.18 or newer with npm, and Rust through rustup. Bundled SQLite also needs a C compiler and linker. On macOS, Xcode Command Line Tools supply the native build tools. The checkout selects its Rust toolchain through <code>rust-toolchain.toml</code>. The commands pin the public revision used for the build below, so Cargo embeds the matching dashboard assets.</p>
      <pre><code>{'git clone https://github.com/AuvreyDurelle/tokentracky.git\ncd tokentracky\ngit checkout --detach 96621c89bf8b1d5a666c654fb945ee6ab1e01450\nnpm ci\nnpm run build --workspace=@tokentracky/web\ncargo build --locked --release -p tokentracky-cli --features embed-web'}</code></pre>
      <p>The last command produces <code>target/release/tokentracky</code>. If Cargo reports a missing dashboard asset, check that the npm build completed in this checkout. The embedding step checks the assets referenced by <code>apps/web/dist/index.html</code>. An index file left over from a partial build is insufficient.</p>
      <h2>Check the binary with a fresh tracking folder</h2>
      <pre><code>{'tracker_check=$(mktemp -d)\nTOKENTRACKY_HOME="$tracker_check" ./target/release/tokentracky status --json\nrmdir "$tracker_check"'}</code></pre>
      <p>Using the explicit executable path makes this a test of your build even if you already installed Tokentracky. <code>TOKENTRACKY_HOME</code> isolates the usage database and the saved device credential for this invocation. Look for the temporary path in <code>dataDir</code>, a zero <code>totals.allTime</code>, and <code>leaderboard.linked</code> set to <code>false</code>. On our build of this revision the report showed <code>version</code> 0.2.1 and <code>lastRefreshAt</code> was null. The status command reads existing state and does no scan.</p>
      <p>To use the build for your own tracking afterward, run <code>./target/release/tokentracky serve</code> from the checkout. It opens the local dashboard and collects usage from the supported tools it finds. On an existing installation it uses your usual data folder and link settings. The <a href="/blog/what-joining-the-leaderboard-shares">guide to device approval</a> explains when those totals can be uploaded.</p>
    </>,
    sources: [
      { label: 'Native CLI build, commands, and data folders', url: source + '/crates/cli/README.md' },
      { label: 'Dashboard files the Rust build checks and embeds', url: source + '/crates/cli/build.rs' },
    ],
  },
  {
    ...guide('test-ai-token-counter-with-fixtures'),
    description: 'Run one Rust fixture test for a DeepSeek session log cut off during a write. Follow the token counter through a good scan, damaged data, and recovery.',
    body: <>
      <h2>Test an interrupted write with a synthetic session</h2>
      <p>To test a token counter that reads coding sessions, run a fixture through the collector and compare its saved total after each change to the file. Tokentracky’s Rust test for an interrupted DeepSeek write records <strong>540 tokens</strong>, encounters a truncated DeepSeek archive, then recovers the missing 100 tokens when the write finishes.</p>
      <p>From the root of the public Tokentracky checkout, run this command with the Rust toolchain specified in the repository. Cargo builds the collector and one integration-test target. The test writes synthetic data to its own temporary folder and reads it through the ingestion service.</p>
      <pre><code>{'cargo test --locked -p tokentracky-collector --test deepseek_archives \\\n  keeps_the_usage_of_a_log_whose_last_frame_is_torn_until_it_is_complete -- --exact'}</code></pre>
      <p>Look for <code>running 1 test</code>, the full test name followed by <code>ok</code>, and <code>1 passed</code>. Cargo can exit successfully with zero matching tests. If you see <code>running 0 tests</code>, list the target’s names with <code>cargo test -p tokentracky-collector --test deepseek_archives -- --list</code> and compare the spelling.</p>
      <h2>Follow one log through four scans</h2>
      <table><caption>Expected results for the same DeepSeek archive</caption><thead><tr><th scope="col">What the Rust test puts on disk</th><th scope="col">Recorded tokens</th><th scope="col">Diagnostic</th></tr></thead><tbody>
        <tr><th scope="row">Header and complete first turn</th><td>540</td><td>None</td></tr>
        <tr><th scope="row">First turn plus half the next compressed frame</th><td>540</td><td><code>archive_unreadable</code></td></tr>
        <tr><th scope="row">First turn plus bytes that cannot form a frame</th><td>540</td><td><code>archive_unreadable</code></td></tr>
        <tr><th scope="row">First turn plus the complete second turn</th><td>640</td><td>None</td></tr>
      </tbody></table>
      <p>The two middle assertions matter as much as the final sum. Dropping to zero on a damaged append would erase previously observed usage. Recording 640 before the final frame was readable would count a turn without a complete record. The last scan checks that the collector recovers the extra 100 exactly once.</p>
      <h2>Capture a counting bug someone else can reproduce</h2>
      <p>Use the smallest synthetic log that crosses the boundary you suspect. Write down the file change, expected total, and expected diagnostic at each scan. Include the exact test command in the report so a contributor can distinguish a failing assertion from a filter that ran nothing. For a different failure involving copied counters, follow the <a href="/blog/how-tokentracky-counts-tokens">worked example of a forked Codex session</a>.</p>
    </>,
    sources: [
      { label: 'Read the archive test and its four assertions', url: source + '/crates/collector/tests/deepseek_archives.rs' },
      { label: 'Inspect the synthetic DeepSeek messages used to make the frames', url: source + '/fixtures/deepseek/copies-across-generations-and-forks/root/--synthetic-dsh-project--/dsh-session-b/session.v4.jsonl' },
    ],
  },
  {
    ...guide('unlink-token-tracker-device'),
    description: 'Remove a saved Tokentracky credential locally or revoke a computer’s upload permission on the leaderboard. See which actions preserve local history and which remove public totals.',
    body: <>
      <h2>Choose what you want to remove</h2>
      <p>Run <code>tokentracky unlink</code> on a computer you still have to remove its saved leaderboard credential. If you no longer have that computer, sign in to <a href="/you">your Tokentracky account</a>, find it under <strong>Computers</strong>, and select <strong>Disconnect</strong>. Both actions let you keep the usage the computer already contributed.</p>
      <table><caption>What happens to history after each action</caption><thead><tr><th scope="col">Action</th><th scope="col">Published profile and totals</th><th scope="col">History on the computer</th></tr></thead><tbody>
        <tr><th scope="row">Unlink locally</th><td>Stay public. The computer loses its saved upload credential.</td><td>Stays on disk.</td></tr>
        <tr><th scope="row">Disconnect under Computers</th><td>Stay public. The service revokes the selected device’s permission to upload.</td><td>Stays on disk, even if the computer is offline.</td></tr>
        <tr><th scope="row">Delete Tokentracky data</th><td>The service removes the account’s profile and uploaded totals, and revokes all its device credentials.</td><td>Stays on each computer.</td></tr>
      </tbody></table>
      <h2>Check that the local credential is gone</h2>
      <pre><code>{'tokentracky unlink\ntokentracky status --json'}</code></pre>
      <p>Use the same operating-system user and <code>TOKENTRACKY_HOME</code> setting you used to link the CLI. When <code>leaderboard.linked</code> is <code>false</code> with no credential error, subsequent syncs cannot load a saved credential. A sync that read the credential before you ran <code>unlink</code> can still finish. To revoke the credential at the service, choose <strong>Disconnect</strong> under <strong>Computers</strong> in your account. The <code>sources</code> and <code>totals</code> fields can still show a full tracking history. If you revoked the device on the website instead, the CLI can still find a credential on disk. The server checks whether that credential is valid before accepting an upload.</p>
      <h2>Retire one laptop or leave the leaderboard</h2>
      <p>Suppose you replace a laptop and still track usage on a desktop. Disconnect the old laptop under Computers. Its previously uploaded days still count, and the desktop keeps its own connection. If you later want to remove the whole public record, use <strong>Delete Tokentracky data</strong> in the account’s <strong>Danger zone</strong> and read the confirmation before proceeding.</p>
      <p>Account deletion affects every linked computer. The separate CLI command <code>uninstall</code> deletes the local data folder after confirmation, so it serves a different purpose. The <a href="/privacy">privacy policy</a> explains backup retention, and the <a href="/blog/what-joining-the-leaderboard-shares">publication guide</a> shows which data you shared when you first connected.</p>
    </>,
    sources: [
      { label: 'CLI unlink, status, and uninstall behavior', url: source + '/crates/cli/README.md' },
      { label: 'How the public project describes multi-computer history', url: source + '/README.md#join-the-leaderboard' },
    ],
  },
  {
    ...guide('ai-token-pricing-offline'),
    description: 'Tokentracky prices recorded AI usage offline with bundled or cached model rates. Find the active version in Settings and compare the tables from the CLI.',
    body: <>
      <h2>Choose the source of your offline token prices</h2>
      <p>Every Tokentracky binary includes a LiteLLM price snapshot for the input, output, and cache usage your coding tools record. If daily refresh is enabled, a valid newer table saved on your computer can supply the rates instead. Turning daily refresh off selects the bundled snapshot, even if a more recent download is on disk.</p>
      <p>To see which table the running collector is using, open its local dashboard and go to <strong>Settings → Pricing &amp; data</strong>. Look for the version beneath <strong>Refresh price table daily</strong> or in the <strong>Price table</strong> row. It comes from the local service. Settings shows the identifier without the CLI’s <code>litellm:</code> prefix.</p>
      <h2>Compare the cached and bundled prices from the CLI</h2>
      <p>In a macOS or Linux shell, run the first command with your usual CLI environment, then run the second with price refresh disabled for that invocation. Compare the <code>pricingVersion</code> field in the two reports. Each command chooses a table from its own environment and the cache on disk. Neither makes a price request. The first can show a cached version even when the running collector’s saved setting selects the bundled table.</p>
      <pre><code>{'tokentracky status --json\nTOKENTRACKY_PRICING_REFRESH=off tokentracky status --json'}</code></pre>
      <ul>
        <li>If the versions differ, the first command found a usable cached table with different pricing data. The second shows the version shipped in this binary.</li>
        <li>If they match, both reports identify the same pricing data. A successful daily download can return unchanged rates, so the version alone cannot tell you when the last download succeeded.</li>
        <li>With the same environment prefix, <code>tokentracky doctor --json</code> reports a <code>pricing</code> check whose detail includes <code>daily refresh off</code>. That setting applies to the command you started. A collector already running has its own settings.</li>
      </ul>
      <h2>Price a session when the network is unavailable</h2>
      <p>Imagine a laptop with a price table downloaded on Monday morning. With daily refresh enabled and that cache newer than the binary’s snapshot, the collector can use Monday’s rates on Tuesday’s train journey. When the table is due for a refresh, a failed download leaves the active table in place. With a missing, invalid, or older cache, startup uses the bundled rates.</p>
      <p>To use the bundled table while collecting, start the CLI as <code>TOKENTRACKY_PRICING_REFRESH=off tokentracky serve</code> when no other collector owns that data folder. For the same choice in the Mac app, turn off <strong>Refresh price table daily</strong> in Settings. Changing price tables can reprice stored usage while the underlying token counts stay the same.</p>
      <h2>Read a zero or missing price</h2>
      <p>The price table assigns $0 to LM Studio usage, model IDs starting with <code>local/</code>, free tiers identified by a <code>-free</code> suffix, and events with zero tokens. Other events need rates for the token types they actually used. If a required rate is missing and the record has no reported cost to use, the estimate stays unknown. The token count is still available.</p>
      <p>The setting controls price downloads. Leaderboard uploads have their own device approval and connection, as explained in <a href="/blog/what-joining-the-leaderboard-shares">what joining the leaderboard shares</a>.</p>
    </>,
    sources: [
      { label: 'Price snapshot, cache validation, and unknown rates', url: source + '/crates/pricing/README.md' },
      { label: 'CLI pricing setting and status fields', url: source + '/crates/cli/README.md' },
      { label: 'When the collector applies a changed price table', url: source + '/crates/collector/src/collector.rs' },
    ],
  },
];
