# tokentracky CLI

Waste tokens, not time. The `tokentracky` command tracks AI coding tokens from the terminal, for scripting, on Linux and Windows, or on a Mac without the app. It is a native binary (Rust): no Node.js. It keeps its history in `~/.tokentracky` (`%USERPROFILE%\.tokentracky` on Windows; override with `--data-dir` or `TOKENTRACKY_HOME`). The Mac app uses the same folder and the same single-writer lock, so only one of them collects at a time.

```sh
tokentracky serve          # private dashboard on a loopback port; reads the tools it finds
tokentracky status         # totals, tracked tools, leaderboard link, last refresh
tokentracky login          # join the leaderboard in the browser, then keep uploading
tokentracky open           # the dashboard of the Tokentracky running on this computer
```

npm and Homebrew distribution require a verified published native release; see [distribution](../../docs/DISTRIBUTION.md). To build from a checkout:

```sh
npm ci
npm run build --workspace=@tokentracky/web
cargo build --release -p tokentracky-cli --features embed-web # target/release/tokentracky
cargo run -q -p tokentracky-cli -- status   # or run it in place
```

| Command | What it does |
| --- | --- |
| `serve [--port N]` | Starts the local dashboard and the five-minute refresh cycle, and prints a one-use launch link (Enter prints a fresh one; Ctrl-C stops). On a terminal it also opens the dashboard in the browser with a link of its own. The first time, it turns on the supported tools found in their usual folders; a tool you turn off stays off. |
| `open` | Opens a fresh one-use link to the dashboard of the running `serve` (the background job of `login` included), else the Mac app's window. Exits 1 when neither is running. |
| `status [--json]` | Reads totals, sources and link state. Works while `serve` runs (read-only). Does not create the data folder. |
| `refresh [--json]` | Runs one cycle now: scan the tracked folders, check prices, sync if linked. Prints `status` afterwards. Refuses while `serve` holds the data folder. It runs the cycle `serve` runs, so when linked it also looks up this week's public rank (one read of your public profile; the TypeScript CLI's `refresh` did not). |
| `doctor [--json]` | Checks the runtime, SQLite, the data folder, the database, detected tools (by checking default folders exist, never reading them), the link and the last refresh. Exits 1 if a check fails. |
| `login [--cloud-url URL]` | Browser approval: prints a code, opens the approval page and waits (checking every 3 seconds). Meanwhile it turns on the tools found in their usual folders, as `serve` does the first time, and reads them, so the upload on approval holds their history. Then it opens the Mac app when it is installed, which keeps uploading. On Linux and Windows it leaves `serve` running in the background instead (see [Background job](#background-job)) and opens its dashboard. Otherwise, or when the background job cannot start, it carries on as `serve` until Ctrl-C. While a `serve` or the Mac app holds the data folder, `login` opens its dashboard or window instead. A saved link keeps its server; otherwise `--cloud-url` takes precedence over `TOKENTRACKY_CLOUD_URL`, with `https://tokentracky.com` as the distributed CLI default. The credential goes into `cloud-link.json` in the data folder (`$TOKENTRACKY_HOME`, else `~/.tokentracky`; `--data-dir` does not move it), readable only by you, and the Mac app reads the same file. |
| `unlink` | Removes the credential. Your public profile stays until you leave on the website. |
| `uninstall [--yes]` | Deletes the data folder and the credential after confirmation (`--yes`, or `y` at the prompt on a terminal). It first stops a running `serve` at once, without waiting for the refresh in progress, and removes the background job and its copy of the CLI. Tokentracky never edits your tools' settings, so nothing else needs undoing. |

Options: `--data-dir <dir>`, `--cloud-url <url>` (the hosted leaderboard origin), `--port <port>` (0 to 65535; default a random loopback port), `--background` (for `serve` without a terminal, as the background job runs it: no browser, no Enter), `-h, --help`, `-v, --version`. Any option is accepted with any command. Exit codes: 0 success, 1 failure (including no command), 2 usage error (the message, then the usage, on stderr).

## Background job

On Linux and Windows, `login` copies the CLI to a fixed place and runs `serve --background --data-dir <data folder>` from that copy, now and at each sign-in, so uploads carry on after the terminal closes:

- **Linux:** the systemd user service `tokentracky.service` in `$XDG_CONFIG_HOME/systemd/user` (default `~/.config`), with the copy in `$XDG_DATA_HOME/tokentracky/bin` (default `~/.local/share`). It restarts a minute after a failure and discards its output. User services stop when your last session ends unless lingering is on (`loginctl enable-linger`). A set `TOKENTRACKY_HOME` goes into the service.
- **Windows:** the `Tokentracky` value of `HKCU\Software\Microsoft\Windows\CurrentVersion\Run`, starting the copy in `%LOCALAPPDATA%\tokentracky\bin` through `conhost.exe --headless`, so it has no window. `--headless` is how Windows' console host behaves rather than documented API. The Run key cannot pass `TOKENTRACKY_HOME` on, so with it set `login` stays in the terminal.

The copy does not update itself: run `login` again with a newer version to replace it. Each `serve` leaves `serve.json` in the data folder, readable only by you: a second loopback address and a random token, through which `open` gets a fresh dashboard link and `uninstall` asks it to stop.

## How it is built

`serve`, `refresh` and `login` open the same local app, `LocalApp` of `crates/local-api`: `serve` puts it on loopback behind the one-use launch link (so the dashboard gets every `/api/local/*` route), `refresh` runs its cycle once, and `login` uses its device connect. `status`, `doctor` and `uninstall` read the database directly (`status` and `doctor` read-only while `serve` owns it), which is why they work beside a running `serve`. The price-table download is `PricingDownload` of `crates/local-api`, the only one in the workspace.

Release builds require `--features embed-web` and a complete dashboard build. The single executable embeds the web files and extracts them into a fresh private 0700 temporary directory held until shutdown; graceful quit removes it. It needs no checkout, sibling `web` directory or Node installation. Default debug builds and tests remain Rust-only, with `serve` using `apps/web/dist` from the checkout. `TOKENTRACKY_WEB_ROOT` explicitly overrides either build's dashboard for development.

## Data folder

`--data-dir`, else `$TOKENTRACKY_HOME`, else `~/.tokentracky` (`%USERPROFILE%\.tokentracky` on Windows). Commands that write create it with mode 0700; on Windows, which has no modes, it takes the user profile's owner-only access. It holds `usage.sqlite` (with its write-ahead log and `usage.sqlite.collector-lock.sqlite`, the single-writer lock) and `pricing/litellm.json` (the cached price table). `status` and `doctor` read it without a lock when a running `serve` holds it; `refresh`, `login`, `serve` and `uninstall` stop with "Tokentracky is already running" instead.

## Environment

| Variable | Meaning |
| --- | --- |
| `TOKENTRACKY_HOME` | Data folder when `--data-dir` is not given. |
| `TOKENTRACKY_CLOUD_URL` | Leaderboard origin when no link is saved and `--cloud-url` is not given; distributed CLI builds default to `https://tokentracky.com`. |
| `TOKENTRACKY_REFRESH_INTERVAL_MS` | Refresh interval for `serve`, at least 60000 (default five minutes). |
| `TOKENTRACKY_PRICING_REFRESH=off` | No daily price-table download; the table compiled into the binary is used. |
| `TOKENTRACKY_WEB_ROOT` | Explicit dashboard directory for development; takes precedence over embedded assets. Default: embedded bundle in distribution builds, `apps/web/dist` of the checkout in default debug builds. |
| `CLAUDE_CONFIG_DIR`, `CODEX_HOME`, and the other tools' own variables | Where `doctor` looks for each tool's folder. |

## `status --json`

```json
{
  "version": "0.1.0",
  "dataDir": "/Users/ada/.tokentracky",
  "running": false,
  "lastRefreshAt": "2026-10-23T14:05:00.000Z",
  "totals": {"today": 1234567, "week": 8400000, "month": 20100000, "allTime": 120000000, "topTool": {"tool": "claude", "tokens": 8000000}},
  "sources": [{"id": "claude", "name": "Claude Code", "enabled": true, "state": "current", "eventCount": 5120, "lastImportedAt": "2026-10-23T14:05:00.000Z"}],
  "leaderboard": {"linked": true, "url": "https://tokentracky.com"},
  "pricingVersion": "litellm:bd03aed56aae"
}
```

(The real output is the same document, pretty-printed with two-space indentation.) Totals use local days in the computer's time zone (today, the week from Monday, the month from the 1st), as the menu-bar title does; the leaderboard's windows stay UTC. `topTool` is this week's largest tool or `null`. `running` means a `serve` process owns the data folder. `leaderboard.error` is `CREDENTIAL_STORE_UNAVAILABLE` when the credential file cannot be read. The text form prints totals in compact notation (`161`, `12.3K`, `1.2M`).

## `doctor --json`

`{ok, checks: [{name, ok, detail}], detected: [{id, name, paths}]}`. The checks, in order, are `runtime`, `sqlite`, `data`, `database`, `tools`, `leaderboard`, `refresh` and `pricing` (`leaderboard` and `refresh` are left out when the database cannot be opened).

The TypeScript CLI's first check was `node`: it required Node 22.18 or later. This binary has no Node, so that check is now `runtime`, which reports the build and is always ok; `sqlite` keeps its name and now checks that a database can be opened. Scripts that read `checks[].name` need the new name.
