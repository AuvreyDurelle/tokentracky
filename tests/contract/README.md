# Local API contract suite

A black-box HTTP suite for the local Tokentracky API: `/api/health`, `/api/local/*`, the leaderboard and profile proxies, device connect, cloud sync, CSV export and the session protection of the TCP transport. It asserts only what a client can observe: status codes, headers and JSON bodies. Originally captured from the frozen TypeScript baseline, it now runs against the Rust implementation in `crates/local-api`.

Synthetic log writers live in `fixtures.ts`. The tests do not import the local implementation; `hosted-flow.test.ts` imports the hosted API exports for its PostgreSQL integration. Only `runner.ts` knows how to launch the Rust contract server.

## Running it

```
cargo build -p tokentracky-local-api --bin contract-server
npx vitest run tests/contract
```

By default the runner starts the Rust server once per test file, as a subprocess: `target/debug/contract-server` (or the corresponding path under `CARGO_TARGET_DIR`) with `TOKENTRACKY_MODE=local`, `PORT=0`, `TOKENTRACKY_DATABASE_PATH` in a fresh temporary directory, `HOME` pointing at another temporary directory, `TOKENTRACKY_PRICING_REFRESH=off`, a `TOKENTRACKY_WEB_ROOT` holding a stub `index.html` and `assets/contract.js`, and no cloud URL. Every other `TOKENTRACKY_*` variable and every tool folder override (`CLAUDE_CONFIG_DIR`, `CODEX_HOME`, `XDG_DATA_HOME`, and so on) is removed from its environment. The runner reads the one-use launch link from the server's stdout, exchanges it for the session cookie the way a browser does, and sends the cookie, `Host` and `Origin` with every request. Processes and temporary directories are removed when the file's tests end.

### Another implementation

| Variable | Effect |
| --- | --- |
| `CONTRACT_SERVER_CMD` | A shell command the runner spawns once per test file, in the repository root, with the environment above. It must bind loopback on an OS-chosen port, serve the web root, and print a launch link like `http://127.0.0.1:PORT/?launch=TOKEN` on stdout, as the Rust server does. It is stopped with SIGTERM, then SIGKILL, after its file. |
| `CONTRACT_BASE_URL` and `CONTRACT_LAUNCH_URL` | Use a server that is already running; nothing is spawned. The launch link is one-use, so only one test file can use it: run a single file (`npx vitest run tests/contract/session.test.ts`), or use `CONTRACT_SERVER_CMD` for the whole suite. `CONTRACT_LAUNCH_URL` alone is enough when its origin is the base URL. |

With a server the runner did not start it cannot choose the server's `HOME` or its hosted service. The tests that need that skip themselves (the default-folder detection test, the stub-service tests and the hosted flow); the others write their logs under a scratch directory on this machine, so the server must run on it. The runner starts servers with the explicit test refresh interval (one hour) and expects the same of any other.

Tests run in order within a file and share that file's server; files are independent and run in parallel. The Rust server limits a client to 240 requests a minute and the busiest file (`queries.test.ts`) sends about 170 to its one server, so keep new cases in a file within that budget or start another server (`startServer()`) for them.

## What is covered

| File | Area |
| --- | --- |
| `session.test.ts` | One-use launch link (second use rejected, expired page, no cookie on failures), session cookie (`HttpOnly`, `SameSite=Strict`, `Path=/`), missing or wrong cookie, wrong `Host` or `Origin`, `Origin` required for changes, cross-site fetches, every security header with its exact value on every kind of response, no CORS headers. |
| `routes.test.ts` | `routes.json` against the server: every listed route answers something other than 404, and 401 without a session; the web app's pages, and `/u/:alias` for an alias of the alias pattern, answer `index.html` as HTML, and any other alias 404 `NOT_FOUND`; unknown paths and wrong methods answer 404 `NOT_FOUND`; non-JSON bodies answer 400; every error is exactly `{error:{code,message}}`. |
| `health.test.ts` | `GET /api/health` (local shape), a fresh `GET /api/local/status` (all eight tools, nothing enabled, next refresh an hour away), `GET /api/local/detect`. |
| `sources.test.ts` | `PUT /api/local/sources/:id`: canonical paths, enable, disable, files and folders, unsupported tools, every validation error (`SOURCE_NOT_FOUND`, `INVALID_REQUEST`, `INVALID_PATHS`, `SOURCE_UNAVAILABLE`) and the 16 KiB body limit. |
| `refresh.test.ts` | `POST /api/local/refresh` and `/scan`: status shape, `lastRefreshAt` and `nextRefreshAt`, a cycle started by authorising a source, appends, concurrent refreshes, a source whose folder disappears. |
| `collection.test.ts` | `PUT /api/local/collection`: pause and resume, the status while paused, 409 `COLLECTION_PAUSED`, nothing read while paused, resume starts a cycle, body validation. |
| `queries.test.ts` | `summary`, `sessions`, `breakdown`, `projects` and `export` ranges (`days` 7, 30, 90, 365, shifted back by `offset` days, custom `from`/`to`, today), tool and text filters, and every `INVALID_FILTER` and `INVALID_REQUEST` case on all five routes. Records are dated relative to now, so it holds on any date. |
| `accounting.test.ts` | Exact totals through HTTP from synthetic Claude Code and Codex logs (fixed 2026-10-20 timestamps): summary, sessions, breakdown, projects, costs, cache rate, replayed and corrected records, a rewritten smaller log, project repository from a local git remote, and that no prompt text reaches any response. |
| `export.test.ts` | `GET /api/local/export`: `Content-Type`, `Content-Disposition`, header row, CRLF, quoting, filters, and spreadsheet-formula neutralisation (a leading `=`, `+`, `-` or `@`, also after spaces, is prefixed with `'`; other text is untouched). |
| `cloud-unconfigured.test.ts` | With no hosted service: leaderboard, profile and profile stats proxies answer 503 `CLOUD_UNAVAILABLE`; `connect` 503, `connect/poll` 409 `CONNECT_NOT_STARTED`; `sync` 409 `CLOUD_NOT_LINKED`; `DELETE /api/local/cloud` 204; every `PUT /api/local/cloud` validation error. |
| `cloud-stub.test.ts` | Against a recording stub of the hosted API (no database): the proxies (relayed body, forwarded query, no credentials, 404 and 502 mapping, redirects refused), browser approval (`connect`, `connect/poll` pending, expired, connected), link validation against the published scope, the upload wire format (keys, receipts, base receipt chain, frozen retry, downward correction, zero for an emptied day, the one widening of a publication saved before sharing was fixed, a deleted account) and unlink. The stub publishes as the hosted API does: all history, with tool split, model mix and cost. |
| `hosted-flow.test.ts` | The same journey against the real TypeScript hosted API on PostgreSQL: import, upload, retry, downward correction, leaving by account deletion, browser approval, and the fixed-sharing migration widening an older publication until the device is linked again. |

`routes.json` is the hand-maintained inventory of every route the local server registers (method and path), read from `crates/local-api/src/local.rs`, `server.rs` and `app.rs`. Add a line, and a sample in `routes.test.ts` if the path is a template, whenever an implementation gains a route; diff it against the Rust router to keep route coverage complete. Routes marked `"static": true` serve the web build and are only exercised when the runner provisioned the web root.

## What needs a database

`hosted-flow.test.ts` runs only when `TEST_DATABASE_URL` is set, to the isolated test database of CI (`postgres://tokentracky:test-only-password@127.0.0.1:5432/tokentracky_test`; the test refuses any other host, database or user) and when the runner starts the server. Each test gets its own schema, dropped afterwards. Without it the file is skipped and prints `Hosted flow skipped: TEST_DATABASE_URL is not set`. Everything else, including the stub-based sync and approval tests, runs without a database.

## Deliberately loose

- Human-readable `message` strings are only checked to be non-empty.
- The order of `byTool` and `byModel` in the summary, and of the rows in the CSV, follows the internal event ids; the tests compare them without order. Sessions, projects, breakdown and daily rows have a defined order and are compared with it.
- `activity.currentStreak` depends on today's date and is checked only where the data is relative to now.
- `Date`-like fields are checked to be ISO timestamps, and `pricingVersion` to look like `litellm:` and twelve hex digits.

## Historical baseline behavior that is not asserted

These look like defects rather than behaviour to port. They are left out of the suite so the Rust implementation may choose.

- `PUT /api/local/cloud` answers 500 `INTERNAL_ERROR`, not a 502, when the hosted service in the link cannot be reached (observed against a closed port).
- `GET /api/local/export` with an invalid query answers the JSON error but still carries the CSV `Content-Disposition` header. Only the JSON content type and body are asserted.
- A `POST /api/local/sync` with nothing linked leaves `syncError: "CLOUD_NOT_LINKED"` in the status until a link or unlink resets it. The status after it is not asserted.

## Not covered

The in-process transport of the Mac app (no TCP, no session cookie) cannot be driven by this runner; run the same route inventory and tests through a shim that exposes it over TCP with a launch link, or port the assertions to the Rust test harness.
