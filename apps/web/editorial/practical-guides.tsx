import React from 'react';
import { guide } from '../src/footer-guides';

const source = 'https://github.com/AuvreyDurelle/tokentracky/blob/3fcbe4c6fdfd16cf9fecee88041d97df56fd74a3';
const release = 'https://github.com/AuvreyDurelle/tokentracky/releases/tag/v0.2.1';

export const practicalGuides = [
  {
    ...guide('private-token-dashboard'),
    description: 'Run tokentracky serve to open your private token dashboard. Check today’s count, the last scan, and whether your computer is linked to the leaderboard.',
    body: <React.Fragment>
      <h2>Open the local dashboard</h2>
      <p>On a fresh installation, run <code>tokentracky serve</code> to see your AI coding token usage without creating an account. You need a supported tool with recorded activity and the CLI on your PATH. Choose the binary for your system from the <a href={release}>standalone CLI downloads</a>, or follow the <a href="/join">installation guide</a>. Leave the computer unlinked to keep its usage on this device.</p>
      <pre><code>tokentracky serve</code></pre>
      <p>Leave that terminal open. The command starts a server on this computer’s loopback address, scans the supported tools it finds, and opens a browser tab when run interactively. The printed launch link expires after five minutes and works once. Press Enter in the terminal for a fresh link, or use <code>tokentracky open</code> to reopen the running dashboard.</p>
      <h2>Read the same collection from a second terminal</h2>
      <pre><code>tokentracky status --json</code></pre>
      <ul>
        <li><code>lastRefreshAt</code> gives the last scan time. The collector normally checks again every five minutes.</li>
        <li><code>totals.today</code> and <code>totals.allTime</code> answer different questions. If you first opened Tokentracky today to import yesterday’s activity, all-time tokens can be positive while today’s count is zero. The CLI uses local time for today, the week beginning Monday, and the calendar month.</li>
        <li><code>leaderboard.linked</code> reads <code>false</code> on an unlinked computer. The <a href="/blog/what-joining-the-leaderboard-shares">publication walkthrough</a> shows what linking would share.</li>
      </ul>
      <p>Press Ctrl-C in the terminal running the dashboard when you are finished. Your existing local history will be there next time.</p>
    </React.Fragment>,
    sources: [
      {label: 'CLI commands and the status report', url: source + '/crates/cli/README.md'},
      {label: 'How the CLI opens the local dashboard', url: source + '/crates/cli/src/serve.rs'},
    ],
  },
  {
    ...guide('install-tokentracky-linux'),
    description: 'Install the standalone x86_64 or Arm64 Linux binary, verify it against SHA256SUMS, and choose foreground tracking or a systemd user service.',
    body: <>
      <h2>Choose the binary for your Linux machine</h2>
      <p>You can install Tokentracky on Linux without Node by downloading one executable containing the tracker and its dashboard. Run <code>uname -m</code> on the machine where you will collect usage, then match its output to a release asset.</p>
      <ul>
        <li><code>x86_64</code> identifies 64-bit Intel or AMD. In release v0.2.1, choose <code>tokentracky-0.2.1-linux-x86_64</code>.</li>
        <li><code>aarch64</code> identifies 64-bit Arm. Choose <code>tokentracky-0.2.1-linux-aarch64</code> for that release.</li>
      </ul>
      <h2>Verify the checksum and install for your user</h2>
      <p>Download the matching executable and the same release’s <code>SHA256SUMS</code> into an empty directory. From that directory, use GNU coreutils to check the downloaded file against the list.</p>
      <pre><code>sha256sum --check --ignore-missing SHA256SUMS</code></pre>
      <p>Look for your exact filename followed by <code>OK</code>. For the x86_64 example, the following commands install it for your user and print its version. Substitute the aarch64 filename on Arm.</p>
      <pre><code>{'mkdir -p ~/.local/bin\ninstall -m 755 tokentracky-0.2.1-linux-x86_64 ~/.local/bin/tokentracky\n~/.local/bin/tokentracky --version'}</code></pre>
      <h2>Choose how it runs</h2>
      <p>Use <code>~/.local/bin/tokentracky serve</code> for a foreground dashboard. If you want to <a href="/blog/what-joining-the-leaderboard-shares">publish eligible usage</a>, stop the foreground instance with Ctrl-C, run <code>~/.local/bin/tokentracky login</code>, and approve this machine. On systems with a working systemd user manager, login installs a user service. Run <code>systemctl --user status tokentracky.service</code> to check whether it is active. It can keep running after you close the terminal. Signing out of your last Linux session normally stops user services unless lingering is enabled.</p>
    </>,
    sources: [
      {label: 'Download the v0.2.1 release and its checksums', url: release},
      {label: 'Linux user service and CLI lifecycle', url: source + '/crates/cli/README.md#background-job'},
    ],
  },
  {
    ...guide('first-launch-on-macos'),
    description: 'Install the Tokentracky menu-bar app from its Mac disk image. Check Apple Silicon compatibility and handle the v0.2.1 first-open prompt.',
    body: <>
      <h2>Install the menu-bar app from the disk image</h2>
      <p>On an Apple Silicon Mac running macOS 13 or later, download <code>Tokentracky.dmg</code>, open it, and drag Tokentracky into Applications. Launch the copy in Applications. Check the chip and OS version under Apple menu → About This Mac if you are unsure which Mac you have.</p>
      <p>The v0.2.1 release page below lists both the disk image and its checksum. The separate file ending in <code>macos-arm64</code> is the CLI. Choose the disk image for the counter that lives in the menu bar.</p>
      <h2>If macOS cannot verify the v0.2.1 app</h2>
      <p>This release uses ad-hoc signing and has no Apple notarization ticket. If you downloaded this release and see the first-open verification dialog, use the instructions for your macOS version.</p>
      <ul>
        <li><strong>macOS 15 and later.</strong> Dismiss the dialog, open System Settings → Privacy &amp; Security, and find Tokentracky under Security. Select Open Anyway for this app and confirm.</li>
        <li><strong>macOS 13 and 14.</strong> Control-click Tokentracky in Applications, select Open, and confirm Open.</li>
      </ul>
      <h2>Find the counter</h2>
      <p>Click Tokentracky in the menu bar to see today’s tokens and the longer periods that include earlier activity. Collection starts locally. To publish, open Settings and approve the computer after reviewing <a href="/blog/what-joining-the-leaderboard-shares">what joining shares</a>.</p>
    </>,
    sources: [
      {label: 'Mac app and checksums for v0.2.1', url: release},
      {label: 'Mac installation and first-launch instructions', url: source + '/README.md#quick-start'},
    ],
  },
  {
    ...guide('windows-background-tracking'),
    description: 'On Windows x64, tokentracky login can install a sign-in job. Check the running collector in PowerShell and control its next sign-in launch in Startup settings.',
    body: <>
      <h2>Find the background collector</h2>
      <p>On Windows x64, a successful <code>tokentracky login</code> can keep collecting after you close PowerShell. Once you <a href="/blog/what-joining-the-leaderboard-shares">approve this computer</a>, the CLI starts a copy of itself from <code>{'%LOCALAPPDATA%\\tokentracky\\bin'}</code>. A sign-in entry named <code>Tokentracky</code> launches that copy at sign-in while the entry is enabled.</p>
      <h2>Check whether it is running now</h2>
      <pre><code>{'tokentracky status --json\ntokentracky open'}</code></pre>
      <p>Run these commands in a new PowerShell window. In the JSON report, <code>running: true</code> means a collector owns the data folder. <code>lastRefreshAt</code> dates its last scan and <code>leaderboard.linked</code> shows the device link. The second command opens the running dashboard. One collector can write to the folder at a time.</p>
      <h2>Check what will happen at the next sign-in</h2>
      <p>This read-only query looks up the sign-in entry for your Windows user. If present, the value shows the registered command. Open Settings → Apps → Startup to see whether the Tokentracky entry is enabled. Use <code>tokentracky status --json</code> to see whether the collector is running now.</p>
      <pre><code>{'reg query HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run /v Tokentracky'}</code></pre>
      <p>If the background job could not start, login falls back to a foreground session. A custom <code>TOKENTRACKY_HOME</code> causes this on Windows because the sign-in entry cannot carry that setting. In that configuration, keep the original terminal open while you want collection to continue.</p>
      <h2>Stop background tracking</h2>
      <p>To stop this session, open Task Manager’s Details tab. If the Command line column is hidden, right-click a column header, choose Select columns, and enable Command line. Find the <code>tokentracky.exe</code> in the copied installation folder shown above, confirm its arguments include <code>serve --background</code>, and end that process. If you started it in the foreground, press Ctrl-C in its terminal instead.</p>
      <p>To keep it from starting at the next sign-in, open Settings → Apps → Startup and turn off the Tokentracky entry. This controls the next launch. End the current session separately if you also want collection to stop now. Your local usage history stays on disk.</p>
    </>,
    sources: [
      {label: 'Windows background-job implementation', url: source + '/crates/cli/src/background.rs'},
      {label: 'CLI status and background behavior', url: source + '/crates/cli/README.md'},
    ],
  },
  {
    ...guide('combine-usage-from-two-computers'),
    description: 'Approve both computers under one Tokentracky account. See how matching daily totals count once and what happens when you disconnect an old device.',
    body: <>
      <h2>Connect the second computer to the same account</h2>
      <p>To combine a laptop and a workstation under one leaderboard name, approve the second computer while signed into your existing Tokentracky account. Each device gets its own credential. Approval publishes <a href="/blog/what-joining-the-leaderboard-shares">eligible usage history</a>, including work that predates the connection.</p>
      <ol>
        <li>On the second computer, choose Join in the Mac app’s Settings or run <code>tokentracky login</code> with the CLI.</li>
        <li>On the approval page, check the account, match the short code and computer name, then choose Connect.</li>
        <li>Open <a href="/you">your account</a> and check that both computers appear. Give each a recognizable name so you can disconnect the right one later.</li>
      </ol>
      <h2>Work through one day of uploads</h2>
      <p>Suppose the laptop reports 800 input tokens and 200 output tokens for one model in Codex on Tuesday UTC. All other token types are zero. The workstation has a copy and reports the same day, tool, model, total, and breakdown. Those two matching daily records contribute 1,000 tokens to the account.</p>
      <p>Now suppose the workstation reports 400 tokens for a different tool that day. That record is distinct, so the combined example reaches 1,400. The matching rule applies to whole aggregates. Two partly overlapping copies with different totals can produce distinct records. The service receives no project names or session IDs with which to compare individual requests across computers.</p>
      <h2>Retire the old machine</h2>
      <p>An account supports up to ten active computers. Disconnecting one stops its future uploads and retains its published history. If you replace a laptop midway through the month, its earlier contribution can stay on the board after you remove that device from your account.</p>
    </>,
    sources: [
      {label: 'Device approval, reconnection, and removal', url: source + '/README.md#join-the-leaderboard'},
      {label: 'Fields used to combine account totals', url: source + '/docs/IMPLEMENTATION_CONTRACT.md'},
    ],
  },
  {
    ...guide('understand-estimated-token-cost'),
    description: 'Tokentracky estimates model usage at documented token rates. Follow a 2.8-cent example and learn when the cost is known, zero, or unavailable.',
    body: <>
      <h2>What an estimated token cost measures</h2>
      <p>Tokentracky estimates the API price of recorded usage by multiplying the count for each token type by the model’s applicable rate. Uncached input, output, cache reads, and cache writes can have different rates. Reasoning tokens already included in output are priced once. Your subscription fee or invoice may also reflect credits, discounts, or other activity.</p>
      <h2>Price a small example by hand</h2>
      <p>Suppose a request used 10,000 uncached input tokens and generated 1,000 output tokens. Apply these illustrative rates to each part.</p>
      <table>
        <caption>Estimated charge for one example request, in US dollars</caption>
        <thead><tr><th scope="col">Usage</th><th scope="col">Rate per million</th><th scope="col">Charge</th></tr></thead>
        <tbody>
          <tr><th scope="row">10,000 input</th><td>$2</td><td>$0.020</td></tr>
          <tr><th scope="row">1,000 output</th><td>$8</td><td>$0.008</td></tr>
        </tbody>
      </table>
      <p>The sum is $0.028, or 2.8 cents. For real models, supported context and service tiers can change those rates. Grok Build has an additional source of information. When its log records the complete cost xAI billed for a prompt, the collector uses that amount directly.</p>
      <h2>Read an unknown price differently from zero</h2>
      <p>Usage can have a measured token count even when the model or one of its used token categories lacks a documented rate. Its cost stays unknown. An LM Studio request running locally receives a known zero for the API-price estimate. Electricity, hardware, and your time fall outside that figure.</p>
      <p>To investigate a discrepancy, record the model ID, the token breakdown, and the <code>pricingVersion</code> from <code>tokentracky status --json</code>. For the count behind those prices, follow <a href="/blog/how-tokentracky-counts-tokens">one example from the collector’s public test data</a>.</p>
    </>,
    sources: [
      {label: 'Pricing rules, tiers, and missing prices', url: source + '/crates/pricing/README.md'},
      {label: 'Reported and estimated cost by tool', url: source + '/README.md#supported-tools'},
    ],
  },
  {
    ...guide('add-token-badge-to-github-readme'),
    description: 'Paste the badge Markdown from your public Tokentracky profile into a GitHub README. Set metric=rank and period=week to show your weekly position.',
    body: <>
      <h2>Copy the badge Markdown from your profile</h2>
      <p>Open your published Tokentracky profile, copy its badge Markdown, and paste it into your GitHub README. The default badge shows your all-time token count. Its image URL supplies the statistic, and the link around the image opens your profile when someone clicks.</p>
      <h2>Show weekly rank instead of all-time tokens</h2>
      <p>In the image address, set <code>metric=rank</code> and <code>period=week</code>. Replace both instances of <code>YOUR_NAME</code> in this example with your published alias.</p>
      <pre><code>{'[![My weekly AI token rank](https://tokentracky.com/badge/YOUR_NAME.svg?metric=rank&period=week)](https://tokentracky.com/u/YOUR_NAME?ref=readme)'}</code></pre>
      <p>“My weekly AI token rank” describes the image for readers who cannot see it. Keep <code>ref=readme</code> on the profile URL so the visit is identified as coming from a README. The <a href="/blog/how-to-read-the-token-leaderboard">leaderboard guide</a> explains how the weekly window affects the rank.</p>
      <h2>Check the preview before committing</h2>
      <ol>
        <li>In GitHub’s Markdown preview, inspect the badge image. If you see “private”, check the alias spelling and whether the name has been published. An unpublished name still returns an image.</li>
        <li>Click the badge. Check that the destination is your public profile. If the right image opens the wrong profile, correct the alias in the outer link.</li>
      </ol>
    </>,
    sources: [
      {label: 'Supported README badge and card options', url: source + '/README.md#readme-badges-and-cards'},
    ],
  },
  {
    ...guide('diagnose-missing-token-usage'),
    description: 'Check missing token usage with tokentracky doctor and status. Inspect the detected source, enabled state, scan time, and the local versus UTC day.',
    body: <>
      <h2>Check the machine where the session ran</h2>
      <p>When a coding session is missing, run <code>tokentracky doctor --json</code> and <code>tokentracky status --json</code> on the computer that recorded it. The first checks whether Tokentracky can find the tool’s folders. The second shows whether collection is enabled and when the tool last contributed records.</p>
      <pre><code>{'tokentracky doctor --json\ntokentracky status --json'}</code></pre>
      <h2>Read the two reports in order</h2>
      <ol>
        <li><strong>Detection.</strong> Look for the tool in the doctor report’s <code>detected</code> list. Detection checks known folders. A match establishes that a path exists. The tool still has to write a supported usage record for the collector to count it.</li>
        <li><strong>Collection.</strong> In the status report’s <code>sources</code> list, read <code>enabled</code>, <code>eventCount</code>, and <code>lastImportedAt</code> for that tool. If you keep records in a custom location, check the folder selected for that source in Settings.</li>
        <li><strong>Freshness.</strong> Compare <code>lastRefreshAt</code> with the session time. A running collector normally scans every five minutes. When it is stopped you can use <code>tokentracky refresh</code> to run one cycle. On a linked computer that command also syncs eligible totals.</li>
      </ol>
      <h2>Match the source and the clock</h2>
      <p>For example, opening Copilot Chat does not guarantee an importable Chat event. The documented Chat reader uses OpenTelemetry files written when Copilot’s file exporter is enabled. The Copilot CLI has its own session-store source. Check which product produced the session before investigating the wrong folder.</p>
      <p>If the event appears locally and only the public number looks low, compare the same time window. The CLI uses local dates, while the <a href="/blog/how-to-read-the-token-leaderboard">leaderboard uses UTC</a> and combines eligible uploads. For example, Monday at 00:30 in UTC+02:00 is still Sunday at 22:30 UTC.</p>
      <p>If you still see a gap after a fresh scan, <a href="/support">contact support</a> with the tool name, app version, expected window, and the relevant enabled state and scan time. Those details let someone investigate without a personal session transcript.</p>
    </>,
    sources: [
      {label: 'Status and diagnostic fields', url: source + '/crates/cli/README.md'},
      {label: 'Usage formats and locations by coding tool', url: source + '/README.md#supported-tools'},
    ],
  },
];
