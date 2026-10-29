<div align="center">

<img src="apps/mac/icons/icon.png" alt="Tokentracky icon" width="112" />

# Tokentracky

### Waste tokens, not time.

The public leaderboard for AI coding tokens. A native macOS menu-bar app and a Rust CLI read the usage records that **28 AI coding tools** already keep, show you your numbers privately, and rank you on [tokentracky.com](https://tokentracky.com) once you join. Token counts only: never prompts, code or project names.

[![Latest release](https://img.shields.io/github/v/release/AuvreyDurelle/tokentracky?color=4f56b8&label=release)](https://github.com/AuvreyDurelle/tokentracky/releases/latest)
[![npm](https://img.shields.io/npm/v/tokentracky?color=4f56b8&logo=npm&logoColor=white)](https://www.npmjs.com/package/tokentracky)
[![Homebrew](https://img.shields.io/github/v/release/AuvreyDurelle/tokentracky?label=brew&color=F8B73E&logo=homebrew&logoColor=white)](https://github.com/AuvreyDurelle/homebrew-tokentracky)
[![macOS 13+ on Apple Silicon](https://img.shields.io/badge/macOS%2013%2B-Apple%20Silicon-lightgrey?logo=apple&logoColor=white)](https://github.com/AuvreyDurelle/tokentracky/releases/latest)
[![CI](https://github.com/AuvreyDurelle/tokentracky/actions/workflows/ci.yml/badge.svg)](https://github.com/AuvreyDurelle/tokentracky/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-green)](LICENSE)
[![Author tokens](https://tokentracky.com/badge/auvreydurelly.svg?label=author%20tokens)](https://tokentracky.com/u/auvreydurelly?ref=readme)

**[Leaderboard](https://tokentracky.com)** · **[Download for Mac](https://github.com/AuvreyDurelle/tokentracky/releases/latest/download/Tokentracky.dmg)** · **[How it works](https://tokentracky.com/join)** · **[CLI](crates/cli/README.md)**

<br/>

<a href="https://tokentracky.com"><img src="docs/screenshots/leaderboard.png" alt="The Tokentracky leaderboard: community totals, the week's leader and the ranked list" width="880" /></a>

<sub>The live board at tokentracky.com. Rankings are client-reported usage, not verified spending or productivity.</sub>

</div>

---

## Quick start

Tokentracky runs on Apple Silicon Macs with macOS 13 or later.

**The Mac app.** [Download `Tokentracky.dmg`](https://github.com/AuvreyDurelle/tokentracky/releases/latest/download/Tokentracky.dmg) and drag Tokentracky to Applications, or use Homebrew:

```sh
brew install --cask auvreydurelle/tokentracky/tokentracky
```

**The CLI**, for the terminal or a Mac without the app. One command joins the leaderboard:

```sh
npx tokentracky login
```

It reads the tools it finds while you approve this computer in the browser, so your history counts straight away. Then it opens the Mac app, which keeps uploading from the menu bar; on a Mac without the app it offers to install it first. Say no and the CLI keeps uploading for as long as its terminal stays open.

Or install it. The npm package is a small Node 18+ launcher that downloads the verified native binary; the Homebrew formula needs no Node.

```sh
npm i -g tokentracky                                # or: brew install auvreydurelle/tokentracky/tokentracky-cli

tokentracky serve     # private dashboard on a loopback port; reads the tools it finds
tokentracky status    # totals, tracked tools, leaderboard link, last refresh
tokentracky login     # join the leaderboard in the browser, then keep uploading
tokentracky doctor    # health check
```

Both read the usual folders of the tools they find as soon as they open, and any other folders you choose. Nothing leaves your computer until you join the leaderboard. All commands are in the [CLI guide](crates/cli/README.md).

<details>
<summary><b>"Tokentracky Not Opened": macOS can't check the app</b></summary>

<br/>

Tokentracky is **ad-hoc signed**: Apple has not notarized it yet, so macOS blocks it the first time it opens. You only do this once.

**macOS 15 and later**

1. Open Tokentracky and click **Done** when macOS refuses.
2. Open **System Settings → Privacy & Security** and scroll to **Security**. It says *"Tokentracky" was blocked to protect your Mac.*
3. Click **Open Anyway**, then confirm with your password or Touch ID.

**macOS 13 and 14:** Control-click Tokentracky in Applications, choose **Open**, then **Open** again. The steps above also work.

</details>

## Features

- **28 tools, nothing installed into them.** Collection is passive: Tokentracky reads records each tool already keeps and never installs hooks or changes a tool's settings. History you already have counts the moment you join.
- **A public leaderboard.** The community's total tokens for the week, month or all time, a top-three podium, per-tool filters and the ranked list. Reading it needs no account.
- **Profiles worth sharing.** Every member gets `/u/<name>`: totals, streaks, a 52-week activity calendar, tool mix, top models, achievements, a share card with **Post on X**, and README badges.
- **A menu-bar app.** The icon opens a popover with today's tokens, your week, month and all-time totals, streak and recent sessions. The dashboard window has Leaderboard, Tokens (your private usage, models and insights), Achievements and Settings.
- **Honest cost estimates.** A bundled [LiteLLM](https://github.com/BerriAI/litellm) price table (MIT) refreshes once a day from GitHub, and a short hand-maintained list, [`crates/pricing/data/curated-prices.json`](crates/pricing/data/curated-prices.json), prices models LiteLLM lacks, each with its source. A model without a known price shows cost as unknown, never $0. Local models (LM Studio and Unsloth Studio's local routes) and free tiers (model ids ending in `-free`) show $0.
- **Every computer, one account.** Up to 10 active computers add to one account, and the same usage seen on two of them counts once.
- **Fair play.** Uploads are checked against other members' totals as they arrive. A day far above everyone else's is hidden from public pages until a person reviews it; the member sees which days on their profile page. Only a person can ban an account.
- **Updates itself.** Release builds check for updates shortly after launch and every six hours. **Update now** downloads, verifies and installs; **Restart now** when ready; **Later** waits 24 hours for that version, across relaunches too. Development builds have updating disabled.

## Showcase

<table>
<tr>
<td width="50%" valign="top">

**Profiles**: totals, streaks, best day and favourite model, with daily, cumulative and calendar charts.

<img src="docs/screenshots/profile.png" alt="A member profile with totals, streak, best day, favourite model and a daily token chart" />

</td>
<td width="50%" valign="top">

**How it works**: code as usual, watch the menu bar count, climb the board. The numbers in this one are made up.

<img src="docs/screenshots/how.png" alt="Diagram: a coding session, the menu-bar popover counting today's tokens, and the weekly leaderboard" />

</td>
</tr>
<tr>
<td colspan="2">

**Activity**: the last 52 weeks, one square per UTC day.

<img src="docs/screenshots/activity.png" alt="A 52-week activity calendar of daily token use" />

</td>
</tr>
<tr>
<td width="50%" valign="top">

**Top models**: tokens and estimated cost per model.

<img src="docs/screenshots/models.png" alt="Top models by tokens with estimated cost" />

</td>
<td width="50%" valign="top">

**Achievements**: Token Titan, Streak, Podium and more, each in bronze, silver, gold and diamond.

<img src="docs/screenshots/achievements.png" alt="Achievement badges with tiers and progress to the next tier" />

</td>
</tr>
</table>

## How it works

```mermaid
flowchart LR
    A["Your AI coding tools<br/>Claude Code · Codex · Gemini CLI · Copilot<br/>OpenCode · Cline · Grok Build · 21 more"] -->|"their own usage logs,<br/>read in place"| B["Tokentracky<br/>Mac app or CLI"]
    B --> C[("~/.tokentracky<br/>on your Mac")]
    C --> D["Menu bar and dashboard<br/>(private)"]
    C -.->|"after you join:<br/>daily totals"| E[("tokentracky.com")]
    E --> F["Leaderboard · profiles<br/>badges · cards"]
```

1. Your AI coding tools log their own token usage as you work.
2. Tokentracky reads those records where they are (databases are opened read-only) and keeps the usage metadata: day, tool, model, token counts. Logs may contain conversation text; prompts, responses and code are not retained or uploaded.
3. Your history stays in `~/.tokentracky`. The menu bar, dashboard and CLI all read it there.
4. Once you join, usage is refreshed and pushed every 5 minutes. A cycle with no new usage uploads nothing, and failed uploads back off from 1 to 30 minutes.

## Supported tools

Claude Code · Codex · Gemini CLI · Cline · Roo Code · Kilo Code · OpenCode · Every Code · Mimo Code · DuMate · pi · oh-my-pi · OmO · Prime Agent · MiniMax Code · CodeBuddy · Kimi Code · Command Code · DeepSeek Harness · LM Studio · GitHub Copilot · Unsloth Studio · ZCode · Zed Agent · OpenClaw · Hermes Agent · Goose · Grok Build

Cursor (no verified local usage format) and Reasonix are not read yet. Claude.ai and ChatGPT website conversations are not included. Missing a tool? [Open an issue](https://github.com/AuvreyDurelle/tokentracky/issues/new).

<details>
<summary><b>Where each tool's records are read, and what they contain</b></summary>

<br/>

The columns match `SourceStatus.capabilities`; a test keeps them in step.

| Tool | Local records read | Tokens | Models | Projects | Reported cost | Quotas |
| --- | --- | --- | --- | --- | --- | --- |
| Claude Code | `~/.claude/projects` JSONL transcripts, and T3 Code's `~/t3-routing/.runtime/profiles/claude/projects` | Yes | Yes | Yes | No | No |
| Codex | `~/.codex/sessions` and `~/.codex/archived_sessions` JSONL rollouts, including compressed `rollout-*.jsonl.zst` archives, and the same folders in T3 Code's `~/t3-routing/.runtime/profiles/codex` | Yes | Yes | Yes | No | No |
| Cursor | Not supported: no verified local usage format | No | No | No | No | No |
| Gemini CLI | `~/.gemini/tmp/*/chats` session JSONL and legacy JSON | Yes | Yes | No | No | No |
| Cline | `~/.cline/data/sessions` transcripts; classic extension tasks in each editor's `globalStorage/saoudrizwan.claude-dev/tasks` | Yes | Yes | Yes | No | No |
| Roo Code | Extension tasks in each editor's `globalStorage/rooveterinaryinc.roo-cline/tasks` | Yes | Yes | Yes | No | No |
| Kilo Code | Version 7 `~/.local/share/kilo/kilo.db` (opened read-only); version 5 tasks in each editor's `globalStorage/kilocode.kilo-code/tasks` retained alongside the database by the Rust collector | Yes | Yes | Yes | No | No |
| OpenCode | `~/.local/share/opencode/opencode.db` (opened read-only) and pre-1.2 `storage/message` files | Yes | Yes | Yes | No | No |
| Every Code | `~/.code/sessions` JSONL rollouts; older rollouts often name no model, which stays unknown | Yes | Yes | Yes | No | No |
| Mimo Code | `~/.local/share/mimocode/mimocode.db` (opened read-only), only Mimo's own `mimo` and `xiaomi` providers, not the Claude Code, Codex and OpenCode history it mirrors | Yes | Yes | Yes | No | No |
| DuMate | `opencode.db` in each install's `qianfan_desk_xdg/<install-id>/data/opencode` folder on Windows (opened read-only; on macOS choose the folder), only its `QianfanPersonalQuota` provider, not the history it imports | Yes | Yes | Yes | No | No |
| pi | `~/.pi/agent/sessions` and `~/.multica/pi-sessions` session JSONL, forked sessions counted once | Yes | Yes | Yes | No | No |
| oh-my-pi | `~/.omp/agent/sessions` session JSONL, with the subagent sessions nested in each session's folder | Yes | Yes | Yes | No | No |
| OmO | `~/.omo/agent/sessions` session JSONL. Anthropic-subscription turns mirrored in Claude Code logs count once under OmO when their provider message IDs match | Yes | Yes | Yes | No | No |
| Prime Agent | `~/.prime/agent/sessions` session JSONL, not the child usage a parent session repeats | Yes | Yes | Yes | No | No |
| MiniMax Code | `~/.minimax/v2/sessions/<date>/<session>/messages.jsonl` histories; no working folder is recorded | Yes | Yes | No | No | No |
| CodeBuddy | `~/.codebuddy/projects` session JSONL, not the IDE extension's logs; no working folder is recorded | Yes | Yes | No | No | No |
| Kimi Code | `~/.kimi-code/sessions` agent `wire.jsonl` logs, and legacy kimi-cli `~/.kimi/sessions` logs, which record no model or working folder | Yes | Yes | Yes | No | No |
| Command Code | `~/.commandcode/projects` session JSONL; usage stays counted when a log is rewritten, and forked copies count once | Yes | Yes | Yes | No | No |
| DeepSeek Harness | `~/.dsh/sessions` (or `$DSH_HOME/sessions`) session logs `session[.vN].jsonl`, including compressed `.jsonl.zstd` logs | Yes | Yes | Yes | No | No |
| LM Studio | `~/.lmstudio/server-logs` text logs: only the id, model, time and token usage of each logged response | Yes | Yes | No | No | No |
| GitHub Copilot | `~/.copilot/session-store.db` usage table (opened read-only); Copilot Chat's OpenTelemetry `*.jsonl` exports in `~/.copilot/otel` and `~/.copilot-otel`, which exist only if you turned on Copilot's file exporter (Tokentracky never does); CLI spans there are left to the session store, which holds the same requests | Yes | Yes | No | No | No |
| Unsloth Studio | `~/.unsloth/studio/studio.db` (opened read-only): the usage Studio records on each chat reply, a forked chat's copied replies counted once, and the receipts of requests made to its API with a key. Models running in Studio are named `local/<model>`; an API receipt does not say whether a local model answered, so its model is kept as written | Yes | Yes | No | No | No |
| ZCode | `~/.zcode/cli/db/db.sqlite` (opened read-only): its `model_usage` table, and older messages from before that table; not the bundled Claude Code, Codex and Gemini CLI sub-agents, which those tools log themselves | Yes | Yes | Yes | No | No |
| Zed Agent | `~/Library/Application Support/Zed/threads/threads.db` (opened read-only; each thread decoded in memory for its running token total and model only). Each scan counts the growth of a thread's total, dated when the thread was last saved, so its hour and day are coarse | Yes | Yes | No | No | No |
| OpenClaw | `~/.openclaw/agents/*/agent/openclaw-agent.sqlite` (opened read-only) and `agents/*/sessions` session JSONL with its reset and deletion archives; a message in several of them counts once. Compaction checkpoints and cold archives are not read | Yes | Yes | No | No | No |
| Reasonix | Not read yet | No | No | No | No | No |
| Hermes Agent | `~/.hermes/state.db` and `profiles/*/state.db` (opened read-only), not the copies in `state-snapshots` and `backups`. Each scan counts the growth of a session's running total, dated at its latest activity, so its hour and day are coarse | Yes | Yes | No | No | No |
| Goose | `~/.local/share/goose/sessions/sessions.db` (opened read-only): one record per model request, and for sessions from before Goose kept those, the growth of their running totals, dated when the session was last updated (coarse) | Yes | Yes | No | No | No |
| Grok Build | `~/.grok/sessions/<project>/<session>/updates.jsonl`: each completed prompt's usage by model, with the cost xAI billed for it; prompts Grok recorded no usage for (most were cancelled) are not counted, and the session's conversation files are never opened | Yes | Yes | Yes | Yes | No |

**Projects** is the folder a session ran in; it stays on this computer and is never uploaded. Gemini CLI records only a hash of the project folder, so its usage has no project; classic Cline extension tasks do not record one either. **Reported cost** is No for every tool but Grok Build: costs a tool writes into its logs are ignored, and estimated cost comes from the price table whenever the model is known. Grok Build records what xAI billed for each prompt, every long-context rate included; that cost is kept, and the table (xAI's Grok API rates) prices only prompts Grok marks partial or incomplete.

</details>

## Privacy

| Published once you join | Never leaves your computer |
| --- | --- |
| UTC day, tool and model id (where the tool logs one) | Prompts, responses and code |
| Token total and its split by type: input, output, cache read, cache write and reasoning | Project names and repository paths |
| Estimated cost (empty when the price is unknown) | Session identifiers |
| Operational revision/generation, collector UUID and sync-receipt fields | Usage-limit readings |
| | The one-hour cache-write split and service tier |

No project or session identities are included in the operational fields. Account creation alone publishes nothing; connecting a computer publishes all eligible history, with tool split, model mix and estimated cost, and deleting your account removes it all.

The price table refreshes once a day from GitHub; set `TOKENTRACKY_PRICING_REFRESH=off` to keep the bundled snapshot and make no download.

**Usage limits**, for a coming Limits page: while Claude Code is turned on, Tokentracky also reads Claude Code's own record of its latest usage-limit reading in `~/.claude.json` (`$CLAUDE_CONFIG_DIR/.claude.json` when that is set). It keeps only the limit figures (how much of the 5-hour, 7-day and 7-day Opus limits is used, when each resets, and when Claude Code took the reading), only when the reading belongs to the account signed in there, and nothing else from that file. For Codex it keeps the latest rate-limit figures from the logs it already reads. No credential is used or kept, and nothing is fetched. The figures stay on this computer and are never uploaded; the Rust local API serves them at `GET /api/local/limits`. The Quotas column stays No until the Limits page is available.

## Join the leaderboard

The hosted site's home page is the public leaderboard: the community's total tokens for the week, month or all time, a top-three podium and the ranked list. Reading it needs no account.

1. The Rust Mac app and CLI default to `https://tokentracky.com`; no shell variable is required for Finder launches. Existing saved links retain their origin. `TOKENTRACKY_CLOUD_URL` remains an explicit override.
2. In the app, open **Settings** and click **Join…** under Leaderboard (the leaderboard's **Join the leaderboard** button leads there), or run `tokentracky login`. It shows a short code and opens the hosted site in your browser.
3. **Sign in**: GitHub, then Google, then email and password (GitHub and Google appear only after provider activation). Account creation alone publishes nothing.
4. **Name and connect**: one screen with your leaderboard name (prefilled from your GitHub username, and checked against names already on the board), the code to match and the computer's name. Check that the code matches and click **Connect**. There is no consent step and nothing to switch off: connecting publishes all eligible history, with tool split, model mix and estimated cost, and the page says so. Deleting your account removes it all. The app collects its device credential by itself and uploads; no token is copied.
5. The done screen shows your board row once the first upload lands, and the README badge. Your profile page (`/u/<name>`) has a share card with this week, this month or all time, **Post on X**, and the badge; the account page also offers a 600×180 README card.

<details>
<summary><b>How connecting works</b></summary>

<br/>

The collector calls `POST /api/device-auth` (anonymous, rate-limited to 10 per minute per client) with its name and, on a Mac, its machine id, and receives a poll secret plus a user code valid for ten minutes. The signed-in browser reads and approves the code (`GET /api/device-auth/:code`, `POST /api/device-auth/:code/approve`). The collector then calls `POST /api/device-auth/poll` with the poll secret, and the device token is minted once, at pickup. Only hashes of the poll secret and device token are stored. Locally these steps are `POST /api/local/connect` and `POST /api/local/connect/poll`.

</details>

<details>
<summary><b>Several computers, reconnecting and leaving</b></summary>

<br/>

Every connected computer adds to one account, up to 10 active computers. Identical day, tool, model, token total and token-type breakdown across computers counts once; different buckets add together. Connecting the same Mac again replaces its earlier connection and totals, using a salted hash of its hardware UUID (the UUID stays local). Rename or disconnect computers on the account page; disconnecting retains published history.

Every upload checks the current publication. A publication saved before sharing was fixed, with a history cutoff or something switched off, was widened once by the hosted migration; its app stops syncing until you click **Reconnect**. Disconnecting it, or **Unlink this Mac** in the app's Settings, stops that computer's uploads, and what it already published stays until you delete your account.

</details>

## README badges and cards

Show your standing on GitHub. Your profile and account pages give you the markdown; it looks like this:

```markdown
[![Tokentracky](https://tokentracky.com/badge/YOUR_NAME.svg)](https://tokentracky.com/u/YOUR_NAME?ref=readme)
[![Tokentracky](https://tokentracky.com/card/YOUR_NAME.svg)](https://tokentracky.com/u/YOUR_NAME?ref=readme)
```

<p align="center">
  <a href="https://tokentracky.com/u/auvreydurelly?ref=readme">
    <picture>
      <source media="(prefers-color-scheme: light)" srcset="https://tokentracky.com/card/auvreydurelly.svg?theme=light" />
      <img src="https://tokentracky.com/card/auvreydurelly.svg" alt="The author's Tokentracky README card: rank, all-time tokens, estimated cost and top three tools" width="600" />
    </picture>
  </a>
</p>

| Parameter | Values | Default |
| --- | --- | --- |
| `metric` (badge) | `tokens`, `cost` or `rank` | `tokens` |
| `period` | `week`, `month` or `all` | `all` |
| `style` (badge) | `flat` or `flat-square` | `flat` |
| `label` (badge) | 1–30 characters | `tokentracky` |
| `color` (badge) | six hex digits, no `#` | `4f56b8` |
| `theme` (card) | `dark` or `light` | `dark` |

Badges and cards show "private" until the name is published, so an embed never breaks.

## Native release status

The initial release targets Apple Silicon on macOS 13+. It is ad-hoc signed, not notarized, until a Developer ID certificate exists; see [Mac releases](docs/MAC_RELEASE.md) and [release prerequisites](docs/RELEASE_PREREQUISITES.md). The hosted API stays TypeScript. The collector, local API, CLI and Mac shell run in Rust; their old TypeScript and Electron implementations have been removed. Windows/Linux native apps, widgets, Cursor and the Limits page are later work.

## Development

### Run locally

Requires the pinned Rust toolchain, Node 22.18 or later, and npm. Build the shared React interface, then start the Rust local server:

```sh
npm ci
npm run build
npm run dev
```

Open the one-use private launch URL printed by the server. Tracking stays private until you join the leaderboard. Data and device credentials live under `~/.tokentracky` by default; see [the Rust CLI](crates/cli/README.md) for overrides and commands.

On macOS, `npm run desktop` starts the native menu-bar app. `npm run cli -- status --json` runs a CLI command. Both use the Rust implementation.

For UI development, run `npm run dev:web` in another terminal; it rebuilds assets as they change, then refresh the authenticated local page. To develop the hosted API, configure the variables in `.env.example` and run `npm run dev:hosted`; this Node service only runs the hosted API.

Native builds use `npm run build --workspace=@tokentracky/web`, then `cargo build --release -p tokentracky-mac -p tokentracky-cli --features tokentracky-cli/embed-web`; installed Rust executables include the dashboard and do not require Node. These commands produce unsigned development binaries.

### Verification

Use an isolated PostgreSQL database named `tokentracky_test`, with user `tokentracky`, on loopback. Tests create and remove their own schemas. The test role needs schema and role creation privileges for isolation checks; this is not the production application role.

```sh
TEST_DATABASE_URL=postgres://tokentracky:test-only-password@127.0.0.1:5432/tokentracky_test npm test
npm run typecheck
npm run lint
npm run build
npm audit
```

`npm test` builds the Rust contract server and runs the TypeScript UI and hosted tests, including the local-to-hosted flow against that server. Run `cargo test --workspace` for the native implementation tests, the local API's included. Without `TEST_DATABASE_URL`, database integration tests are explicitly skipped. Fixtures are synthetic; tests do not inspect personal tool logs. CI supplies PostgreSQL 17 and runs the complete suite, including fresh migrations and the local-to-hosted API workflow.

See [the API contract](docs/IMPLEMENTATION_CONTRACT.md), [accounting limitations](docs/ACCOUNTING_PUBLICATION_SCOPE.md), [distribution](docs/DISTRIBUTION.md), and [release prerequisites](docs/RELEASE_PREREQUISITES.md). Release availability is determined by the published artifacts; local builds and CI do not establish that a public installer is available.

## License

[MIT](LICENSE). Third-party data and code are listed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

---

<div align="center">

**Tokentracky**: waste tokens, not time.

<a href="https://tokentracky.com">tokentracky.com</a> · <a href="https://www.npmjs.com/package/tokentracky">npm</a> · <a href="https://github.com/AuvreyDurelle/homebrew-tokentracky">Homebrew</a> · <a href="https://github.com/AuvreyDurelle/tokentracky/releases/latest">Releases</a>

</div>
