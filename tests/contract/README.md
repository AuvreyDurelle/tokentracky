# Local-to-hosted contract test

`hosted-flow.test.ts` drives the Rust local server (the `contract-server` binary, over TCP behind its session) against the real TypeScript hosted API on PostgreSQL: import, upload, retry, downward correction, leaving by account deletion, browser approval, and the fixed-sharing migration widening an older publication until the device is linked again. It asserts only what a client can observe: status codes, headers and JSON bodies, and the uploads the hosted API receives.

The local API itself is tested in Rust, in `crates/local-api/tests/` (`cargo test -p tokentracky-local-api`).

## Running it

```
cargo build -p tokentracky-local-api --bin contract-server
npx vitest run tests/contract
```

`npm test` builds the binary and runs this file with the other TypeScript tests.

## The runner

`runner.ts` starts the server once per test file (`startServer()`), as a subprocess: `target/debug/contract-server` (or the corresponding path under `CARGO_TARGET_DIR`) with `TOKENTRACKY_MODE=local`, `PORT=0`, `TOKENTRACKY_DATABASE_PATH` in a fresh temporary directory, `HOME` pointing at another temporary directory, `TOKENTRACKY_PRICING_REFRESH=off`, the hourly refresh cycle (`TOKENTRACKY_REFRESH_INTERVAL_MS=3600000`), a `TOKENTRACKY_WEB_ROOT` holding a stub `index.html` and `assets/contract.js`, and `TOKENTRACKY_CLOUD_URL` set to the hosted API the test started. Every other `TOKENTRACKY_*` variable and every tool folder override (`CLAUDE_CONFIG_DIR`, `CODEX_HOME`, `XDG_DATA_HOME`, and so on) is removed from its environment. The runner reads the one-use launch link from the server's stdout, exchanges it for the session cookie the way a browser does, and sends the cookie, `Host` and `Origin` with every request. Processes and temporary directories are removed when the file's tests end.

`support.ts` holds the request helpers (`expectError`, `refresh`, `configure`, `getJson`, `logRoots`, `writeLog`) and `fixtures.ts` the synthetic Claude Code records. Neither imports the local implementation. Human-readable error `message` strings are only checked to be non-empty.

| Variable | Effect |
| --- | --- |
| `CONTRACT_SERVER_CMD` | A shell command the runner spawns instead of the binary, in the repository root, with the environment above. It must bind loopback on an OS-chosen port, serve the web root, and print a launch link like `http://127.0.0.1:PORT/?launch=TOKEN` on stdout, as the Rust server does. It is stopped with SIGTERM, then SIGKILL, after its file. |
| `CONTRACT_BASE_URL` and `CONTRACT_LAUNCH_URL` | Use a server that is already running; nothing is spawned. The runner cannot then point the server at a hosted API, so the hosted flow skips itself. |

## What needs a database

`hosted-flow.test.ts` runs only when `TEST_DATABASE_URL` is set, to the isolated test database of CI (`postgres://tokentracky:test-only-password@127.0.0.1:5432/tokentracky_test`; the test refuses any other host, database or user), and when the runner starts the server. Each test gets its own schema, dropped afterwards. Without it the file is skipped and prints `Hosted flow skipped: TEST_DATABASE_URL is not set`.
