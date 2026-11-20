import React from 'react';

const source = 'https://github.com/AuvreyDurelle/tokentracky/blob/3fcbe4c6fdfd16cf9fecee88041d97df56fd74a3';
const release = 'https://github.com/AuvreyDurelle/tokentracky/releases/tag/v0.2.1';

export const practicalGuides = [
  {
    slug: 'private-token-dashboard',
    title: 'Read your first token report without joining the leaderboard',
    description: 'Open the dashboard on your own computer, read a usage report from the terminal, and find out where today’s total comes from.',
    body: <React.Fragment>
      <p>If you want to know how many tokens you used today, you can answer that question before you choose a public name. On a fresh installation, Tokentracky can collect and display usage entirely on your computer. You need the CLI and a supported coding tool with some recorded activity.</p>
      <h2>Open the local dashboard</h2>
      <pre><code>tokentracky serve</code></pre>
      <p>Leave that terminal open. The command starts a server on a loopback address, scans the supported tools it finds, and opens a browser tab when run interactively. If you close the tab, press Enter in the terminal for a fresh, one-use link. You can also run <code>tokentracky open</code> from another terminal to reopen the running dashboard.</p>
      <h2>Read the same collection from a second terminal</h2>
      <pre><code>tokentracky status --json</code></pre>
      <p>Start with <code>lastRefreshAt</code>, then look at <code>totals.today</code> and <code>totals.allTime</code>. If you used a tool yesterday and opened Tokentracky for the first time today, an all-time count with zero tokens today is quite plausible. History is attributed to its recorded dates. The CLI uses your computer’s time zone for today, the week beginning Monday, and the calendar month.</p>
      <p>The collector normally checks again every five minutes. On an unlinked computer, <code>leaderboard.linked</code> reads <code>false</code>. Closing the foreground session with Ctrl-C stops collection and leaves the existing local history available next time.</p>
    </React.Fragment>,
    sources: [
      {label: 'CLI commands and the status report', url: source + '/crates/cli/README.md'},
      {label: 'How the CLI opens the local dashboard', url: source + '/crates/cli/src/serve.rs'},
    ],
  },
  {
    slug: 'install-tokentracky-linux',
    title: 'Install the Tokentracky CLI on Linux without Node',
    description: 'Choose the right Linux binary, verify its checksum, and check whether collection is running after you close the terminal.',
    body: <>
      <p>The Linux release includes the tracker and its web dashboard in one executable. The two downloads have different processor targets. Run <code>uname -m</code> on the machine where you intend to collect usage. An Intel or AMD machine usually reports <code>x86_64</code>. A 64-bit Arm machine usually reports <code>aarch64</code>.</p>
      <h2>Verify one release, then install it</h2>
      <p>For example, the v0.2.1 release includes <code>tokentracky-0.2.1-linux-x86_64</code> and <code>tokentracky-0.2.1-linux-aarch64</code>. Download the matching executable and the same release’s <code>SHA256SUMS</code> into an empty directory. From that directory, use GNU coreutils to check the downloaded file against the list.</p>
      <pre><code>sha256sum --check --ignore-missing SHA256SUMS</code></pre>
      <p>Look for your exact filename followed by <code>OK</code>. For the x86_64 example, the following commands install it for your user and print its version. Substitute the aarch64 filename on Arm.</p>
      <pre><code>{'mkdir -p ~/.local/bin\ninstall -m 755 tokentracky-0.2.1-linux-x86_64 ~/.local/bin/tokentracky\n~/.local/bin/tokentracky --version'}</code></pre>
      <h2>Choose how it runs</h2>
      <p>Use <code>~/.local/bin/tokentracky serve</code> for a foreground dashboard. To publish eligible usage, use <code>~/.local/bin/tokentracky login</code> and approve this machine. On systems with a working systemd user manager, login installs a user service. Run <code>systemctl --user status tokentracky.service</code> to see whether it is active. Closing the terminal and signing out of your last Linux session are different events. A normal user service can stop at sign-out.</p>
    </>,
    sources: [
      {label: 'Download the v0.2.1 release and its checksums', url: release},
      {label: 'Linux user service and CLI lifecycle', url: source + '/crates/cli/README.md#background-job'},
    ],
  },
  {
    slug: 'first-launch-on-macos',
    title: 'Open Tokentracky for the first time on an Apple Silicon Mac',
    description: 'Check Mac compatibility, install the menu-bar app, and recognize the first-launch prompt documented for the v0.2.1 release.',
    body: <>
      <p>Open About This Mac from the Apple menu and check the chip and macOS version. The v0.2.1 Mac app supports Apple Silicon and macOS 13 or later. If you want the small token counter in the menu bar, download <code>Tokentracky.dmg</code> from the project’s release page. A file with a name ending in <code>macos-arm64</code> and no <code>.dmg</code> extension is the terminal executable.</p>
      <h2>Install the app in Applications</h2>
      <p>Open the disk image, drag Tokentracky to Applications, and launch that copy. The v0.2.1 release uses ad-hoc signing. macOS may tell you that it could not verify the app. The release page lists the download and its checksums if you want to confirm which file you received.</p>
      <p>For that specific verification prompt on macOS 15 or later, dismiss the dialog, open System Settings → Privacy &amp; Security, and find the entry naming Tokentracky under Security. Choose Open Anyway for that app and confirm. On macOS 13 and 14 the project also documents Control-clicking the app in Applications, choosing Open, and confirming Open.</p>
      <h2>Find the counter</h2>
      <p>Click the app’s icon in the menu bar to see today’s tokens. The popover also shows longer windows, so you can spot older activity imported on the first scan. You can use the app privately from this point. Joining the leaderboard is a separate action under Settings that asks you to approve the computer.</p>
    </>,
    sources: [
      {label: 'Mac app and checksums for v0.2.1', url: release},
      {label: 'Mac installation and first-launch instructions', url: source + '/README.md#quick-start'},
    ],
  },
  {
    slug: 'windows-background-tracking',
    title: 'Where Tokentracky runs after you close PowerShell',
    description: 'Follow the Windows CLI from device approval to its next sign-in and check the running collector without launching another one.',
    body: <>
      <p>On Windows x64, the CLI can keep collecting with no terminal window open. After you run <code>tokentracky login</code> and approve the computer, it copies the executable into your user profile and starts that copy as a background process. A sign-in entry named <code>Tokentracky</code> starts it again the next time you sign into Windows.</p>
      <h2>Check the process that already owns your history</h2>
      <pre><code>{'tokentracky status --json\ntokentracky open'}</code></pre>
      <p>Run these in a fresh PowerShell window after closing the original one. The first command reads the local database. Check <code>running</code>, <code>lastRefreshAt</code>, and <code>leaderboard.linked</code>. The second asks the running collector to open its dashboard. If both work, leave collection to that instance. Opening another <code>serve</code> on the same folder would compete for its single-writer lock.</p>
      <h2>When the terminal needs to stay open</h2>
      <p>If the background job could not start, login falls back to a foreground session. One specific cause is a custom <code>TOKENTRACKY_HOME</code>. The Windows sign-in entry cannot carry that setting, so the CLI keeps the collector in your terminal. Keep that window open for collection in this configuration.</p>
      <p>You can inspect the sign-in registration from PowerShell with the following read-only command. The value points to the background launch command. Its presence establishes registration for a future sign-in. The status report tells you whether collection is running now.</p>
      <pre><code>{'reg query HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run /v Tokentracky'}</code></pre>
    </>,
    sources: [
      {label: 'Windows background-job implementation', url: source + '/crates/cli/src/background.rs'},
      {label: 'CLI status and background behavior', url: source + '/crates/cli/README.md'},
    ],
  },
  {
    slug: 'combine-usage-from-two-computers',
    title: 'Combine two computers on one leaderboard profile',
    description: 'Link a second computer, understand which daily totals combine, and know what happens to published history when you retire a device.',
    body: <>
      <p>A laptop and a workstation can publish under one leaderboard name. Start the connection on the second computer, sign into the same Tokentracky account, and match the short code and computer name on the approval screen. Each computer gets its own credential. Connecting publishes its eligible history, including activity from before the connection.</p>
      <h2>Work through one day of uploads</h2>
      <p>Suppose the laptop reports 800 input tokens and 200 output tokens for one model in Codex on Tuesday UTC. All other token types are zero. The workstation has a copy and reports the same day, tool, model, total, and breakdown. Those two matching daily records contribute 1,000 tokens to the account.</p>
      <p>Now suppose the workstation reports 400 tokens for a different tool that day. That record is distinct, so the combined example reaches 1,400. The matching rule applies to whole aggregates. Two partly overlapping copies with different totals can produce distinct records. The service receives no project names or session IDs with which to compare individual requests across computers.</p>
      <h2>Retire the old machine</h2>
      <p>The account page lets you name and disconnect devices. An account supports up to ten active computers. Disconnecting a device stops future uploads from it and retains what it already contributed. That distinction matters when replacing a machine midway through a month. You can keep its earlier contribution without leaving the old computer connected.</p>
    </>,
    sources: [
      {label: 'Device approval, reconnection, and removal', url: source + '/README.md#join-the-leaderboard'},
      {label: 'Fields used to combine account totals', url: source + '/docs/IMPLEMENTATION_CONTRACT.md'},
    ],
  },
  {
    slug: 'understand-estimated-token-cost',
    title: 'What the estimated cost next to your token count means',
    description: 'Work through a token pricing example and learn why a local model, an unknown price, and a subscription payment produce different figures.',
    body: <>
      <p>Two requests can use the same number of tokens and carry different estimates. The pricing engine looks up the model and prices uncached input, output, cache reads, and cache writes separately. Reasoning tokens already included in output do not incur a second output charge.</p>
      <h2>Price a small example by hand</h2>
      <p>Imagine a model priced at $2 per million uncached input tokens and $8 per million output tokens. These are illustrative rates. A request with 10,000 uncached input tokens and 1,000 output tokens would have an input estimate of $0.020 and an output estimate of $0.008. The combined estimate is $0.028. Using a single rate for all 11,000 tokens would give a different answer.</p>
      <p>For actual models, the collector applies recorded token categories and supported context or service tiers. Grok Build is a special case. When it records the complete billed cost of a prompt, the collector can use that figure directly. A provider invoice can still include subscriptions, credits, and other activity outside the collector’s view.</p>
      <h2>Read an unknown price differently from zero</h2>
      <p>Usage can have a measured token count even when the model or one of its used token categories lacks a documented rate. Its cost stays unknown. An LM Studio request running locally receives a known zero for the API-price estimate. Electricity, hardware, and your time fall outside that figure.</p>
      <p>If you need to reconcile a discrepancy, record the model ID, the token breakdown, and the <code>pricingVersion</code> from <code>tokentracky status --json</code>. The source table and version are more informative than the rounded cost on its own.</p>
    </>,
    sources: [
      {label: 'Pricing rules, tiers, and missing prices', url: source + '/crates/pricing/README.md'},
      {label: 'Reported and estimated cost by tool', url: source + '/README.md#supported-tools'},
    ],
  },
  {
    slug: 'add-token-badge-to-github-readme',
    title: 'Put a Tokentracky badge in your GitHub README',
    description: 'Create a clickable badge that shows your weekly rank, then check the image and its profile destination independently.',
    body: <>
      <p>A README badge has two addresses. One fetches the small image with the current statistic. The other opens your profile when someone clicks it. Start on your published Tokentracky profile and copy its badge Markdown to get both addresses with your own alias.</p>
      <h2>Give the badge a specific job</h2>
      <p>Suppose you want readers to see your weekly rank at a glance. In the image address, select <code>metric=rank</code> and <code>period=week</code>. This example uses a placeholder alias. Replace both instances of <code>YOUR_NAME</code> before pasting it into your README.</p>
      <pre><code>{'[![My weekly AI token rank](https://tokentracky.com/badge/YOUR_NAME.svg?metric=rank&period=week)](https://tokentracky.com/u/YOUR_NAME?ref=readme)'}</code></pre>
      <p>The text inside the inner square brackets describes the image for someone reading the page without pictures. The query on the image selects the statistic. The <code>ref=readme</code> on the outer link identifies where the profile visit came from. For an all-time token count, the default image URL ending in <code>.svg</code> is enough.</p>
      <h2>Check the preview before committing</h2>
      <p>Use GitHub’s Markdown preview. Open the image itself to confirm it displays the statistic you selected, then click the badge to confirm it opens your profile. If the image displays “private”, check the spelling of the alias and whether the name has been published. The service deliberately serves an image for an unpublished name, so a successful image request alone cannot confirm that a profile is public.</p>
    </>,
    sources: [
      {label: 'Supported README badge and card options', url: source + '/README.md#readme-badges-and-cards'},
    ],
  },
  {
    slug: 'diagnose-missing-token-usage',
    title: 'Find out why a coding session is missing from your token count',
    description: 'Use the CLI to distinguish a missing source folder, a disabled collector, a stale scan, and a difference between local and public totals.',
    body: <>
      <p>A blank count can mean the tool has no readable usage records, collection is turned off, or you are looking at a different day. Start on the computer where you used the tool. A local status report lets you narrow the problem before changing any settings.</p>
      <pre><code>{'tokentracky doctor --json\ntokentracky status --json'}</code></pre>
      <h2>Read the two reports in order</h2>
      <ol>
        <li><strong>Detection.</strong> Look for the tool in the doctor report’s <code>detected</code> list. Detection checks known folders. A match establishes that a path exists. The tool still has to write a supported usage record for the collector to count it.</li>
        <li><strong>Collection.</strong> In the status report’s <code>sources</code> list, read <code>enabled</code>, <code>eventCount</code>, and <code>lastImportedAt</code> for that tool. If you keep records in a custom location, check the folder selected for that source in Settings.</li>
        <li><strong>Freshness.</strong> Compare <code>lastRefreshAt</code> with the session time. A running collector normally scans every five minutes. When it is stopped you can use <code>tokentracky refresh</code> to run one cycle. On a linked computer that command also syncs eligible totals.</li>
      </ol>
      <h2>Match the source and the clock</h2>
      <p>For example, opening Copilot Chat does not guarantee an importable Chat event. The documented Chat reader uses OpenTelemetry files written when Copilot’s file exporter is enabled. The Copilot CLI has its own session-store source. Check which product produced the session before investigating the wrong folder.</p>
      <p>If the event is present locally and only the public number looks low, compare the same time window. The CLI’s daily total follows the computer’s time zone. The leaderboard uses UTC and combines eligible uploads. A local session shortly after midnight can still belong to the previous UTC day.</p>
    </>,
    sources: [
      {label: 'Status and diagnostic fields', url: source + '/crates/cli/README.md'},
      {label: 'Usage formats and locations by coding tool', url: source + '/README.md#supported-tools'},
    ],
  },
];
