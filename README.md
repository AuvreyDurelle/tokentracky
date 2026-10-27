# Tokentracky

**Waste tokens, not time.**

A leaderboard for reported AI coding-token volume, with a private local workspace, a Rust CLI and a native macOS menu-bar collector. Rankings are client-reported usage, not verified spending or productivity.

Uploads are checked against other members' totals as they arrive. A day far above everyone else's is hidden from public pages until a person reviews it; the member sees which days on their profile page. Only a person can ban an account.

The current implementation reads the local usage records of the tools in the matrix below: from their usual folders as soon as the app opens, and from any other folders you choose. Nothing leaves the computer until you join the leaderboard. Claude.ai and ChatGPT website conversations are not included. Estimated costs use a bundled [LiteLLM](https://github.com/BerriAI/litellm) price table (MIT) that refreshes once a day from GitHub; set `TOKENTRACKY_PRICING_REFRESH=off` to keep the bundled snapshot and make no download. A short hand-maintained list, [`crates/pricing/data/curated-prices.json`](crates/pricing/data/curated-prices.json), prices models LiteLLM lacks, each with its source. Models without a known price show cost as unknown, never $0. Local models (LM Studio and Unsloth Studio’s local routes) and free tiers (model ids ending in `-free`) show $0.

## Install on a Mac

Apple Silicon, macOS 13 or later. Download [`Tokentracky.dmg`](https://github.com/AuvreyDurelle/tokentracky/releases/latest/download/Tokentracky.dmg) and drag Tokentracky to Applications. npm and Homebrew installs come later.

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

## Supported tools

Collection is passive: Tokentracky reads records each tool already keeps and never installs hooks or changes a tool's settings. The columns match `SourceStatus.capabilities`; a test keeps them in step.

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

**Usage limits**, for a coming Limits page: while Claude Code is turned on, Tokentracky also reads Claude Code's own record of its latest usage-limit reading in `~/.claude.json` (`$CLAUDE_CONFIG_DIR/.claude.json` when that is set). It keeps only the limit figures (how much of the 5-hour, 7-day and 7-day Opus limits is used, when each resets, and when Claude Code took the reading), only when the reading belongs to the account signed in there, and nothing else from that file. For Codex it keeps the latest rate-limit figures from the logs it already reads. No credential is used or kept, and nothing is fetched. The figures stay on this computer and are never uploaded; the Rust local API serves them at `GET /api/local/limits`. The Quotas column stays No until the Limits page is available.

## Native release status

The initial release targets Apple Silicon on macOS 13+. It is ad-hoc signed, not notarized, until a Developer ID certificate exists; see [Mac releases](docs/MAC_RELEASE.md) and [release prerequisites](docs/RELEASE_PREREQUISITES.md). The hosted API stays TypeScript. The collector, local API, CLI and Mac shell run in Rust; their old TypeScript and Electron implementations have been removed. Windows/Linux native apps, widgets, Cursor and the Limits page are later work.

The Mac app lives in the menu bar. Its icon opens a popover with today's tokens, your week, month and all-time totals, streak and recent sessions. The dashboard window has Leaderboard, Tokens (your private usage, models and insights), Achievements and Settings.

Release builds check for updates shortly after launch and every six hours. When a newer version is available, choose **Update now** to download, verify and install it, then **Restart now** when ready. **Later** postpones reminders for that version for 24 hours, including across relaunches. You can also check manually in Settings or the menu. Development builds have updating disabled.

For the Rust CLI, see [crates/cli/README.md](crates/cli/README.md). Native builds use `npm run build --workspace=@tokentracky/web`, then `cargo build --release -p tokentracky-mac -p tokentracky-cli --features tokentracky-cli/embed-web`; installed Rust executables include the dashboard and do not require Node. These commands produce unsigned development binaries.

## Run locally

Requires the pinned Rust toolchain, Node 22.18 or later, and npm. Build the shared React interface, then start the Rust local server:

```sh
npm ci
npm run build
npm run dev
```

Open the one-use private launch URL printed by the server. The Rust app and CLI read the usual folders of the tools they find as soon as they open. Tracking stays private until you join the leaderboard. Data and device credentials live under `~/.tokentracky` by default; see [the Rust CLI](crates/cli/README.md) for overrides and commands.

On macOS, `npm run desktop` starts the native menu-bar app. `npm run cli -- status --json` runs a CLI command. Both use the Rust implementation.

For UI development, run `npm run dev:web` in another terminal; it rebuilds assets as they change, then refresh the authenticated local page. To develop the hosted API, configure the variables in `.env.example` and run `npm run dev:hosted`; this Node service only runs the hosted API.

## Join a hosted leaderboard

The hosted site's home page is the public leaderboard: the community's total tokens for the week, month or all time, a top-three podium and the ranked list. Reading it needs no account.

1. The Rust Mac app and CLI default to `https://tokentracky.com`; no shell variable is required for Finder launches. Existing saved links retain their origin. The hosted origin must pass DNS, TLS and authentication checks before release. `TOKENTRACKY_CLOUD_URL` remains an explicit override.
2. In the app, open **Settings** and click **Join…** under Leaderboard (the leaderboard's **Join the leaderboard** button leads there). It shows a short code and opens the hosted site in your browser.
3. **Sign in**: GitHub, then Google, then email and password (GitHub and Google appear only after provider activation). Account creation alone publishes nothing.
4. **Name and connect**: one screen with your leaderboard name (prefilled from your GitHub username, and checked against names already on the board), the code to match and the computer's name. Check that the code matches and click **Connect**. There is no consent step and nothing to switch off: connecting publishes all eligible history, with tool split, model mix and estimated cost, and the page says so. Deleting your account removes it all. The app collects its device credential by itself and uploads; no token is copied.
5. The done screen shows your board row once the first upload lands, and the README badge. Your profile page (`/u/<name>`) has a share card with this week, this month or all time, **Post on X**, and the badge; the account page also offers a 600×180 README card.

How it works: the collector calls `POST /api/device-auth` (anonymous, rate-limited to 10 per minute per client) with its name and, on a Mac, its machine id, and receives a poll secret plus a user code valid for ten minutes. The signed-in browser reads and approves the code (`GET /api/device-auth/:code`, `POST /api/device-auth/:code/approve`). The collector then calls `POST /api/device-auth/poll` with the poll secret, and the device token is minted once, at pickup. Only hashes of the poll secret and device token are stored. Locally these steps are `POST /api/local/connect` and `POST /api/local/connect/poll`.

Every connected computer adds to one account, up to 10 active computers. Identical day, tool, model, token total and token-type breakdown across computers counts once; different buckets add together. Connecting the same Mac again replaces its earlier connection and totals, using a salted hash of its hardware UUID (the UUID stays local). Rename or disconnect computers on the account page; disconnecting retains published history. Usage is refreshed and pushed every 5 minutes; a cycle with no new usage uploads nothing, and failed uploads back off from 1 to 30 minutes. Every upload checks the current publication. A publication saved before sharing was fixed, with a history cutoff or something switched off, was widened once by the hosted migration; its app stops syncing until you click **Reconnect**. Disconnecting it, or **Unlink this Mac** in the app's Settings, stops that computer's uploads, and what it already published stays until you delete your account.

Project names, repository paths, session identifiers and usage limits remain local. The collector scans logs that may contain conversation text, extracts usage metadata, and does not retain or upload prompts, responses or code. Public uploads contain only UTC day, tool, model id (where the tool logs one), token total and its split by type (input, output, cache read, cache write and reasoning), estimated cost (empty when the price is unknown), and operational revision/generation, collector UUID and sync-receipt fields. The one-hour cache-write split and service tier remain local. No project or session identities are included in those operational fields.

## Verification

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
