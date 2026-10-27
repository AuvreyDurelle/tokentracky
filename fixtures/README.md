# Golden fixtures

Language-neutral synthetic collector inputs and exact expected accounting outputs. The Rust collector tests read these files; counter totals are independent checks on what each reader counts.

Inputs are the files each tool writes: JSONL logs, JSON documents with their sidecar files, and SQLite stores kept as SQL text. A case is one scenario, named after the behaviour it covers. All content is synthetic. Prompt, response and path text is marked `PRIVATE_...` so a test can prove it never reaches an output or the store.

## Layout

```
fixtures/
  README.md       this file
  sqlite.ts       materialises SQL inputs for TypeScript HTTP-contract helpers
  <tool>/<case>/  claude, codex, gemini, cline, roo, kilo, opencode, or multi-tool for cases that mix tools
    case.json     description and settings of the case
    root/         the input files of a single-step case
    step.json     optional settings of a single-step case
    expected/     golden outputs of a single-step case
    steps/NN-<name>/{root/, step.json, expected/}   the same three, once per step of a multi-step case
```

A case is either one step (the case directory holds `root/` and `expected/`) or an ordered list of steps (`steps/01-...`, `steps/02-...`, sorted by name). Names are lower-case ASCII, digits, `-` and `.`.

Steps were chosen over a `scenario.json` of operations because each step is what is on disk after the tool did something: a diff shows real file contents, and a Rust test needs no interpreter for a second file format. The few things a file tree cannot say (rename, delete, restart, re-scope, re-price) are the `ops` of `step.json`.

## Playing a case

The Rust runner in `crates/collector/tests/golden.rs` does the following:

1. Make a temporary folder holding `root/` (the authorized folder) and a fresh collector database beside it. The clock is `case.json` `now` (default `2026-10-23T12:00:00.000Z`), so day windows and activity maths never move. A step's `now` replaces it from that step on.
2. For each step, in order:
   1. Apply the step's `ops`, in order (below).
   2. Copy every file of the step's `root/` into the temporary `root/`. A file that already exists is rewritten in place (same inode and path, like a tool rewriting or appending to its log); a new file is created. A file named `X.db.sql` is not copied: it is run against the SQLite database `X.db` (created when absent) by the test harness. The connection stays open for the rest of the case, as a running tool keeps its database open, so a later step's `X.db.sql` can append rows to a live WAL database, and a script that ends inside `BEGIN EXCLUSIVE;` holds the database locked until a later script runs `COMMIT;`.
   3. In the first step only: grant every source of `case.json` `sources` (enabled, with its paths relative to `root/`; `.` is the folder itself). The default is the case's own tool with `.`. `{}` grants nothing.
   4. Run one scan and record its sorted diagnostic codes.
   5. Collect the expected files (below) and compare them with `expected/`.

Operations, all paths relative to `root/`:

| Op | Meaning |
| --- | --- |
| `{"op": "rename", "from": "a", "to": "b"}` | Rename a file; the file at `b` keeps the identity of the old `a`. A new file written at `a` afterwards is a different file (rotation). |
| `{"op": "remove", "path": "a"}` | Delete a file. |
| `{"op": "restart"}` | Close the collector and open it again on the same database (checkpoints, scopes and revisions persist). |
| `{"op": "configure", "tool": "claude", "enabled": false, "paths": ["."]}` | Enable, pause or re-scope a source. Its paths must exist before the step. |
| `{"op": "price", "price": {...} \| null}` | Install a synthetic price table, or remove pricing. |

`ops` run before the step's files, so a rotation is `rename` plus a new file at the old path. A database cannot be committed as a binary, so a SQL step is how a database changes: a later `X.db.sql` holds only the statements the tool ran since (inserts, `INSERT OR REPLACE`, `DELETE`, `COMMIT`).

## case.json

| Field | Meaning |
| --- | --- |
| `description` | One line; it becomes the case table below. |
| `now` | ISO clock for the case (default `2026-10-23T12:00:00.000Z`). |
| `sources` | `{tool: [relative paths]}` granted in the first step. |
| `price` | Synthetic price table applied from the start (see Pricing). |
| `queries` | `{name: {days?, from?, to?, tool?, q?, now?}}`; each adds an entry to `queries.json`. |
| `forbidden` | Text that must appear in no expected file and not in the collector database, beyond the `PRIVATE_` marker that is always forbidden. |
| `rustOnly` | Legacy marker for cases introduced after the TypeScript baseline; these keep their complete goldens in `rust-expected/` (see below). |

`step.json` holds `ops`, `now` and `tokens`. `tokens` is the all-time token total after the step, written by hand from the arithmetic of the input, never generated. A regenerated golden that drifts from it fails the tests, so a wrong accounting change cannot be blessed by running the generator.

## Expected files

Written after every step. JSON files have sorted keys, two-space indent and a trailing newline; compare them as JSON values. `export.csv` is compared byte for byte (CRLF line ends, every cell quoted, formula-looking text prefixed with an apostrophe).

| File | Content |
| --- | --- |
| `events.json` | All normalised usage events (`exportData()`), in event-id order, priced when the case prices. |
| `summary.json` | All-time summary at the clock: totals, activity, sessions, cache rate, by tool, by model, daily. |
| `sessions.json` | Sessions, most recently used first. |
| `projects.json` | Projects (events with a project), largest first. |
| `breakdown.json` | Day x tool x model rows. |
| `period-totals.json` | Today, week from Monday, month, all-time and the top tool of the week, at the clock. |
| `public-buckets.json` | The upload projection under every sharing variant (below). |
| `export.csv` | The CSV export of all events. |
| `diagnostics.json` | The sorted diagnostic codes the step's scan returned. |
| `source-status.json` | The clock-stamped status of the tools the case is about (its own tool, the tools it grants, and any tool that is enabled or holds usage): enabled, state, paths relative to `root/`, last import time, event count, message, capabilities. |
| `files.json` | Per `tool:relative/path` the file's checkpoint: diagnostics, and for line logs the committed byte offset. A withdrawn or never-read file has no entry. |
| `queries.json` | Only when `case.json` has `queries`: per query the summary, sessions, projects, breakdown, events and CSV, or `{"error": "<code>"}`. |

Costs are `null` unless the case prices events. Tokens are `input` (without caches), `output` (with reasoning), `cacheRead`, `cacheWrite` and the informational `reasoning` and `cacheWrite1h` (the one-hour part of `cacheWrite`); a total is the sum of the first four. Every summary row carries these kinds as `breakdown`, and the tests check that they add up to its `tokens` and reconcile across rows and CSV columns.

A Rust-only accounting difference lives in a step's `rust-expected/`, one file per changed output. `TOKENTRACKY_BLESS=1 cargo test -p tokentracky-collector --test golden` writes those files from the Rust collector and removes any that now equal `expected/`; review the diff like a regeneration.

Cases added after the legacy baseline use `"rustOnly": true` in `case.json` and keep complete outputs in `rust-expected/`. Its `step.json` token totals are written by hand from the input, as for every case, so a blessed golden cannot drift from the intended accounting. A database whose name ends in `.sqlite` is kept as `X.sqlite.sql`, which only the Rust tests materialise.

### Public bucket variants

`public-buckets.json` maps a variant name to the buckets of `projectPublicBuckets`. The variants are all 16 combinations of `tools=on|off`, `cost=on|off`, `models=on|off` and `history=2026-10-21|none`, named `tools=off,cost=off,models=off,history=2026-10-21` and so on. After every step they are projected in this loop order: tools off then on (outermost), then cost, then models, then history `2026-10-21` before `none`. That is also the sorted order of the names. The order matters: bucket `revision` numbers come from one counter that event commits share, and projections persist per-variant state (tombstones). Revisions are part of the golden.

### Orders that are part of the contract

- Arrays are in the order the TypeScript store returns them. Events are in event-id order (byte order of the id), and `byTool`, `byModel`, sessions with equal last use and so on keep the order of first appearance in that sequence.
- The scan visits directory entries in `localeCompare` order of the names (`readdir` sorted in `walk`), then tools in `TOOL_IDS` order. Processing order decides revision numbers and which of two copies of an event is current. Fixture names use byte-sortable ASCII, so the Rust runner preserves deterministic processing order.

### Pricing

`price` is `{"version": "v1", "rates": {"input": 1, "output": 2, "cacheRead": 1, "cacheWrite": 1}, "unpriced": ["model"]}`. The cost of an event in micro-USD is the sum of each token kind times its rate, and its pricing version is `version`; an event whose model is in `unpriced` gets no price, so its cost stays `null` and so does every aggregate containing it. Prices apply when events are read: a new table re-prices history. This is a synthetic table; the bundled LiteLLM table has its own golden tests with the pricing crate.

## Privacy checks

For every case and step the tests assert that no expected file contains `PRIVATE_`, the temporary folder path or anything in `forbidden`, that the collector database bytes after the last step contain neither `PRIVATE_` nor anything in `forbidden`, and that a public bucket exposes only `day`, `tool`, `model`, `tokens`, `breakdown`, `costMicrousd` and `revision`, with `tool` being `all` unless tools are shared, `model` present only when models are shared and `costMicrousd` null unless cost is shared. `breakdown` is always present and holds exactly `input`, `output`, `cacheRead`, `cacheWrite` and `reasoning` (never `cacheWrite1h`); the first four add up to `tokens` and reasoning is at most output.

## Running and updating goldens

```sh
cargo test -p tokentracky-collector --test golden
```

The suite checks exact outputs, independent hand-written totals, accounting invariants, revision behavior, ordering, and privacy canaries. Other collector integration tests cover permissions, symlinks, crash recovery, read-only databases and accounting reconciliation. `tests/contract/fixtures.ts` and `fixtures/sqlite.ts` supply synthetic input builders and SQLite materialization for TypeScript HTTP-contract tests.

**Goldens change only with a documented accounting change.** A changed reader behavior in `crates/collector/src/readers` must be explained as an accounting change before updating the affected goldens in the same commit. Review the diff as a change of what the product counts. Never edit `expected/` by hand, and never regenerate to make a failing test pass without understanding the difference. Inputs (`root/`, `step.json`, `case.json`) are edited by hand; `tokens` in `step.json` is the independent check on the generated totals.

Never commit a binary `.db`: they are gitignored. Keep SQLite stores as `X.db.sql`, schema and inserts in the shape `sqlite3 X.db .dump` writes. A `.jsonl.zst` archive is committed as made by `zstd -19`, with its uncompressed content visible in the case's other files or described in `case.json`.

### Rust accounting changes and Rust-only cases

Accounting fixes made only in the Rust collector keep the TypeScript `expected/` file and add the Rust result beside it as `rust-expected/<file>`, one override per changed file, plus a hand-written `rust-expected/tokens.json` when the total changes. A Rust-only case (`rustOnly`) keeps all its goldens in `rust-expected/` and its hand-written total in `step.json`.

```
TOKENTRACKY_BLESS=1 cargo test -p tokentracky-collector --test golden
```

writes every Rust output that differs from `expected/` to `rust-expected/` and removes overrides that no longer differ. It never writes `tokens.json`, which stays the independent check. A bless is reviewed like a regeneration. Whoever regenerates `expected/` updates every `rust-expected/` file to the new shape in the same commit.

## Cases

Keep this inventory aligned with the `description` in each `case.json`.

<!-- cases:start -->

### claude

| Case | Steps | What it covers |
| --- | --- | --- |
| `cache-categories-disjoint` | 1 | One assistant record: cache reads and writes stay separate from input, reasoning stays inside output, prompt text is dropped. |
| `cache-creation-subcategories` | 1 | Without a top-level cache creation total, the 5-minute and 1-hour cache creation figures are added. |
| `copied-history-across-files` | 1 | The same history in two files (a copy in a sub-folder) counts once. |
| `corrected-copies` | 4 | Correcting one of two identical copies changes the total once; an unchanged copy, or a stale copy found later, cannot undo the correction. |
| `csv-formula-neutralization` | 1 | CSV cells that start with = + - or @, after optional white space, are prefixed with an apostrophe in the model, project and session columns; ordinary quotes, commas, operators and Unicode survive. |
| `dashboard-queries` | 1 | Inclusive UTC day ranges, rolling days, invalid ranges, streaks and best day, per-session token kinds and model order, and the day x tool x model breakdown with every token priced at 1 micro-USD. |
| `invalid-counters` | 1 | Negative, fractional, null, unsafe-integer and string counters are all rejected with invalid_counters; none is counted. |
| `malformed-and-invalid-records` | 2 | Malformed JSON, null, an empty array and non-assistant records are skipped with diagnostics; the valid record after them still counts; the source stays stale on a rescan. |
| `model-mix-projection` | 2 | Public buckets split by model only when models are shared; unpublishable model ids become other; models removed from the log leave zero tombstones with unchanged revisions elsewhere. |
| `overflow-and-reasoning-above-output` | 1 | A counter sum above the safe-integer range, and reasoning larger than output, are rejected with invalid_counters. |
| `oversized-record` | 2 | A line over 1 MiB is skipped with record_too_large without being stored, a 120 KB line before it is read across chunks, and a rescan changes nothing. The long line holds no usage key, so the Rust collector skips it without a diagnostic and the source stays current (rust-expected). |
| `partial-line-utf8-restart` | 2 | A final line cut inside a multi-byte character is not committed (partial_line_pending); after a restart the completed line is read and its project name is intact. |
| `period-totals` | 2 | Today, week (from Monday), month and all-time totals and the top tool, then the same events seen from a later clock where only all-time remains. |
| `permission-required-until-enabled` | 3 | Nothing is read until a source is enabled; pausing keeps the earlier total and ignores new records. |
| `query-reconciliation` | 1 | Summaries, models, days, sessions, projects, CSV and public buckets reconcile; dated, undated and old events; rolling-day, project-text, tool and invalid-days queries. |
| `repricing-on-table-change` | 4 | Prices apply when events are read: the same table again changes nothing, a new table re-prices history and revises the cost bucket, switching pricing off makes costs null again. |
| `same-size-edit-corrects-downward` | 3 | A same-size edit inside the already processed prefix is detected; totals and the published bucket correct downward with a higher revision, and a rescan keeps them. |
| `session-from-file-name` | 1 | A UUID file name may name the session but no project is inferred from folders; a record with no identity at all is skipped with missing_stable_identity. |
| `streaming-revisions-coalesce` | 1 | Two revisions of one streamed message count once, with the later output; the working folder becomes the project. |
| `thinking-tokens` | 1 | Claude reasoning is read from output_tokens_details.thinking_tokens, then reasoning_tokens, capped at output; it is never added to totals. |
| `truncate-rotate-remove` | 5 | Truncating a log refunds it with a zero tombstone; rotation keeps one count of shared history; deleting every log file keeps the usage already seen. |
| `unpriced-model-stays-unknown` | 1 | A model with no price keeps a null cost, which makes every aggregate containing it null, while priced sessions keep their cost. |

### cline

| Case | Steps | What it covers |
| --- | --- | --- |
| `classic-research-fixture` | 1 | A classic task: the model comes from the request, no project; placeholder requests and deleted-request summaries add nothing. |
| `classic-subagent-and-metadata-models` | 1 | Subagent usage is its own event, and a request without a model takes the latest model recorded in the task metadata at or before it. |
| `classic-update-in-place-and-checkpoint-restore` | 4 | A request updated in place counts once, a rescan does not double count, and replacing the request with a deleted-request summary keeps the usage. |
| `sdk-and-classic-roots` | 1 | Subagent transcripts and classic tasks are read from two authorized roots, sessions share the manifest project, and hooks files are ignored. |
| `sdk-half-written-manifest` | 1 | A manifest that does not parse yet makes the transcript wait for the next scan. |
| `sdk-half-written-transcript` | 4 | A half-written transcript is skipped for the scan (partial_document_pending, source stale), earlier usage is kept, and the completed document is read next. |
| `sdk-imported-sessions` | 1 | Sessions imported from other tools skip usage up to the import time (epoch or ISO), and are skipped wholly when the import time is unknown. |
| `sdk-input-floor-and-manifest-model` | 1 | Input never goes negative when the caches exceed it, and a message without a model falls back to the manifest model. |
| `sdk-late-manifest-withdraws-imports` | 4 | A manifest written after its transcript that marks the session imported withdraws the usage up to the import time; later usage stays through a rewind, and an import without a time withdraws it all. |
| `sdk-research-fixture` | 1 | An SDK session: input includes both caches (so it is split out), reasoning is added to output, the model comes from the message and the project from the manifest. |
| `sdk-without-manifest` | 1 | Without a manifest the session has no project. |

### codebuddy

| Case | Steps | What it covers |
| --- | --- | --- |
| `round-trips` | 1 | A round trip's function call and message share providerData.messageId and count once (else the uuid, else the id is the key); prompt_tokens includes cache reads and writes in their OpenAI, DeepSeek and Anthropic spellings and completion_tokens includes reasoning; a total that does not add up is invalid_counters; the model is providerData.model, else the record's, else unknown; credit is ignored, a subagent transcript counts and the IDE log is never opened. Rust only. |

### codex

| Case | Steps | What it covers |
| --- | --- | --- |
| `archived-sessions` | 4 | Codex archives in archived_sessions count exactly; a rollout moved there, compressed beside its original and then left only as its archive counts once throughout. Rust only. |
| `cache-write-input` | 1 | Codex cache writes are read from cache_write_input_tokens and, like cached reads, taken out of the inclusive input. |
| `compaction-and-resume` | 1 | A context-size marker that resets the total to zero and a resume whose total equals its last request resolve without a diagnostic. |
| `continuation-without-baseline` | 1 | A continued rollout's first total includes its parent's; without a copied baseline only the latest request counts. |
| `copied-rollouts` | 1 | The same rollout in two files counts once, as one session. |
| `cumulative-differencing` | 1 | Cumulative totals are differenced, cached input is subtracted from input, a repeated total is skipped and reasoning stays informational. |
| `delta-only-and-replay` | 1 | Delta-only records count, their replay does not, and a later cumulative snapshot continues from the deltas. |
| `forked-rollout-copies` | 1 | A forked rollout and a spawned subagent open with copies of the parent's counters; only their own requests count. |
| `impossible-subsets-and-missing-session` | 1 | Cached input above input, reasoning above output and a rollout without session metadata are each rejected with a diagnostic; per-file diagnostics are recorded. |
| `nested-token-count-null-info-undated` | 1 | A token_count nested under msg is read, null info is ignored, and a record without a date has a null timestamp. |
| `rate-limits` | 1 | Rate-limit snapshots on token_count records, one with null info and one of another limit family, add no tokens; their credits, plan and limit names are never kept. |
| `replay-restart-and-append` | 3 | A rescan and a restart do not double count, the saved source scope survives the restart, and an appended cumulative record is differenced against the stored baseline. |
| `reset-and-interleaved-lineages` | 1 | Counter resets, repeated totals and interleaved known lineages are resolved per record, with a cumulative_reset_or_branch diagnostic. |
| `service-tier` | 1 | Each Codex request carries the service tier of the last thread_settings_applied record; before any, the tier is unknown and omitted. |
| `service-tier-priority` | 1 | A thread_settings_applied record sets the service tier of the token counts after it: Fast (priority) is carried as serviceTier until a default record resets it, and no tier is guessed before the first record. Rust-only, in rust-expected. |
| `unreadable-archive` | 1 | A truncated Codex archive reports archive_unreadable and adds nothing, keeping any usage counted from it before; other rollouts still count. Rust only. |

### commandcode

| Case | Steps | What it covers |
| --- | --- | --- |
| `rewrite-then-fork` | 3 | Usage stays counted when a resume or compaction rewrites a log without its older entries, and a fork's copy of entries under a new session header counts once; only new entries add. Rust only. |
| `session-logs` | 1 | A session log: the header gives the session and working folder, input includes both caches (taken out), the provider prefix of the model is dropped, an entry without a model is unknown, caches larger than input are invalid_counters, an entry without a timestamp is missing_stable_identity; costUsd, compaction entries, checkpoints, prompts and metadata files add nothing. Rust only. |

### copilot

| Case | Steps | What it covers |
| --- | --- | --- |
| `otel-exports` | 1 | OpenTelemetry file exports in otel and .copilot-otel: Copilot Chat inference records sharing one span context (keyed by response id) with caches inside input and reasoning inside output; CLI chat spans, which the session store already holds, tool and agent spans, metrics, a record without an id and caches above input add nothing; session-state logs are never read. Rust only. |
| `session-store-watermark` | 2 | The session store's assistant_usage_events rows: input includes both caches and output includes reasoning, the token_details_json split is used when it adds up to the input and the columns otherwise, caches above input are skipped, a row without a valid time is undated; rows appended later are read from the last row id; other tables and databases are never read. Rust only. |

### deepseek

| Case | Steps | What it covers |
| --- | --- | --- |
| `appended-log-and-partial-line` | 2 | A half-written final line waits (partial_line_pending) and counts once completed; the appended lines are read with the session, project and request model saved from the first scan. Rust only. |
| `copies-across-generations-and-forks` | 1 | A session migrated to a new format generation (its old file kept, with renumbered seq) and a fork that copies the session's first message: each assistant message counts once by its message id, the fork's own message counts, and temporary and other files are never read. Rust only. |
| `session-log-usage` | 1 | One session log: disjoint input and caches, reasoning inside output (never added again), the model from the message or else the request header; a total that does not add up, reasoning above output and a message without an id are skipped; attempts, tool results and titles add nothing. Rust only. |

### dumate

| Case | Steps | What it covers |
| --- | --- | --- |
| `own-provider-and-reinstall-copies` | 1 | Only QianfanPersonalQuota rows count (the bundled opencode import copies Claude Code and OpenCode history); a reinstall's copy of the same messages under a new install id counts once, and memory.db is never opened. Rust only. |
| `reasoning-from-total` | 1 | Each record's total shows whether output already includes reasoning (input 1070 + output 888 + cache read 768 = total 2726, with reasoning 818) or not (reasoning added); a record matching neither, or with reasoning but no total, is skipped with invalid_counters. Rust only. |

### everycode

| Case | Steps | What it covers |
| --- | --- | --- |
| `event-records-and-cache-writes` | 1 | Token counts written as event records (with their sequence numbers) and as event_msg records are both read and differenced; cache writes leave input as they are inside it, cache reads too; the model is the one that answered, else the one requested; a replayed count and null info add nothing. Rust only. |
| `unknown-model-copies-and-impossible-caches` | 1 | A token count naming no model (and no turn context) stays unknown, never taken from Codex nearby; a copied rollout counts once; cache reads and writes larger than input are rejected with invalid_counters. Rust only. |

### gemini

| Case | Steps | What it covers |
| --- | --- | --- |
| `append-reappend-and-rewind` | 3 | A rescan does not double count; a re-appended message replaces its earlier usage, and removal, rewind and patch records never refund usage already seen. |
| `legacy-json-resumed-jsonl-and-subagents` | 1 | A legacy .json and its resumed .jsonl count once, subagent sessions are separate sessions, and logs outside chats and .unreadable files are ignored. |
| `legacy-session-json` | 1 | A legacy session-*.json conversation gives the same event identity as its .jsonl form; a .json outside a chats folder is never opened. |
| `legacy-session-partial` | 1 | A legacy conversation that does not parse yet is retried on the next scan: partial_document_pending, source stale, no checkpoint. |
| `missing-identity-and-invalid-counters` | 1 | A message before any session metadata is skipped with missing_stable_identity; a negative counter is skipped with invalid_counters and the next message still counts. |
| `partial-final-line-and-large-message` | 2 | A message larger than the usual 1 MiB line limit is kept; a half-written final line waits (partial_line_pending) and is counted once completed. |
| `recovery-rewrite-truncation-rotation` | 4 | Usage stays counted through a recovery rewrite that keeps only surviving messages, an emptied file and a rotation to a new file name. |
| `research-fixture-rewind` | 1 | The research fixture: a placeholder, its completed message and a rewind record give one event with disjoint input, cache read, output and thoughts; the project hash and directories are not kept. |
| `tool-use-and-optional-counters` | 1 | Tool-use prompt tokens count as input, absent optional counters are zero, the reported total is never added, and a message with no usage is skipped. |

### goose

| Case | Steps | What it covers |
| --- | --- | --- |
| `ledger-and-session-totals` | 2 | Each usage_ledger row counts once (input includes both caches, a total must be input plus output); a session without ledger rows counts the growth of its accumulated totals, dated at its update. When Goose carries an older session's total forward into the ledger, only what was not already counted from the running total is added. Session names, folders and messages are never read. Rust only. |

### grok

| Case | Steps | What it covers |
| --- | --- | --- |
| `turn-usage` | 1 | Each turn_completed counts once per model in usage.modelUsage (or as grok-build without a split): input less both caches, output with reasoning inside it, and xAI's own cost in 10^-10 USD, unless the usage is incomplete, when the price table prices it. A cancelled turn without usage counts nothing, and the session's conversation files are never opened. Rust only. |

### hermes

| Case | Steps | What it covers |
| --- | --- | --- |
| `session-totals-grow` | 2 | Each session's running total (input without caches, reasoning inside output) counts once, from the main and profile databases but not a snapshot copy; when it grows only the growth counts, dated at the session's latest start, end or activity and given to its model. A lower total keeps what was counted; reasoning above output is invalid; system prompts, messages, titles and folders are never read. Rust only. |

### kilo

| Case | Steps | What it covers |
| --- | --- | --- |
| `database-supersedes-tasks` | 3 | Once kilo.db exists the version 5 tasks it imported are withdrawn (their checkpoint disappears) instead of being counted twice. |
| `v5-fast-apply-and-missing-usage` | 1 | A fast-apply call is its own event, distinct from the request at the same timestamp, and a request marked usageMissing adds nothing. |
| `v5-kept-until-database-read` | 3 | Version 5 tasks stay counted while kilo.db cannot be read (its writer holds it locked mid-write, file_read_failed), and are withdrawn once it has been read. |
| `v5-task-without-sidecars` | 1 | A version 5 task in the Roo Code format: the model is unknown and there is no project unless sibling files name them. |
| `v7-database` | 1 | A version 7 kilo.db is read under the Kilo Code tool, not OpenCode: model, working folder and disjoint token kinds from the message row. |

### kimi

| Case | Steps | What it covers |
| --- | --- | --- |
| `legacy-status-updates` | 1 | Legacy kimi-cli logs: each StatusUpdate counts once by its message id (a repeat, and a subagent update forwarded into the parent log and also in the subagent log, count once), disjoint buckets map 1:1, the model is unknown, a null token_usage adds nothing, an update without an id is skipped with missing_stable_identity, and context.jsonl is never opened. Rust only. |
| `official-step-end` | 1 | Kimi Code logs: step.end usage counts by its uuid, inside context.append_loop_event or on its own; usage.record and message usage repeat it and add nothing; the model is the latest llm.request model or profile.bind / config.update alias before the step and the project their working folder; a subagent log counts under its session; a fork copy counts once; a negative counter is invalid_counters, a step without a uuid missing_stable_identity, a step without usage nothing. Rust only. |

### lmstudio

| Case | Steps | What it covers |
| --- | --- | --- |
| `server-logs-responses` | 1 | Server logs: Chat Completions and Responses API predictions with the cached part inside the prompt and reasoning inside the completion, dated by the response's own creation time; a response logged in two files counts once; a response without an id, one whose total does not add up and one cut short are skipped; request bodies and other files add nothing. Rust only. |

### mimo

| Case | Steps | What it covers |
| --- | --- | --- |
| `fork-copies-counted-once` | 1 | A message copied into a forked session (same times, counters, model and provider, new id) counts once; a new message in the fork counts. Rust only. |
| `own-providers-only` | 1 | Only rows of Mimo's own providers (mimo, xiaomi) count, from mimocode.db and a channel's mimocode-<channel>.db; Claude Code, Codex and OpenCode history mirrored under their providers, and a row without a provider, are skipped; a row without a model is unknown. Rust only. |
| `total-must-include-reasoning` | 1 | Input excludes both caches and reasoning is outside output, so it is added; a total must equal input, output, both caches and reasoning, and a row whose total leaves reasoning out or matches nothing, or whose input is negative, is skipped with invalid_counters. Rust only. |

### minimax

| Case | Steps | What it covers |
| --- | --- | --- |
| `forks-compaction-and-staging` | 2 | Assistant envelopes in dated session folders count by message_id, so a fork's copied envelopes count once; migrated historical-transcript rows with zero usage, user and tool rows, manifests and staged copies in .history-mutation folders add nothing, and the session comes from the folder with no project; after compaction replaces messages.jsonl the usage seen stays and the new message counts. Rust only. |

### multi-tool

| Case | Steps | What it covers |
| --- | --- | --- |
| `cost-by-kind` | 1 | Cost is split by token kind on the summary and its tool, model and day rows, the parts add up to the cost, and cache reads save their price difference from input. |
| `locked-database-keeps-other-sources` | 2 | A database locked by its writer fails only its own source (file_read_failed, state error) while another source still imports; the next scan after the writer commits reads it. |
| `overlapping-scopes` | 2 | Claude Code and Codex both authorized on one folder keep separate checkpoints and a rescan changes nothing. |
| `priced-reconciliation` | 1 | Two tools priced from one table: tool, model, session, project, CSV and bucket costs add up to the summary cost. |
| `private-tool-split` | 1 | With tools private every bucket is merged into tool all and carries no project, session or tool field; with tools shared there is one bucket per tool; a history start after the usage leaves none. |

### omo

| Case | Steps | What it covers |
| --- | --- | --- |
| `anthropic-and-chatgpt-subscriptions` | 1 | OmO turns on an Anthropic subscription (claude-sdk-oauth, with the Anthropic message id as responseId), on a ChatGPT subscription and one billing two internal requests count under OmO with reasoning inside output, as does a cache-warm usage entry; the costs OmO writes are ignored. Rust only. |

### omp

| Case | Steps | What it covers |
| --- | --- | --- |
| `subagents-model-usage-and-rewrites` | 2 | After a fixed-width title slot, assistant messages count with reasoningTokens inside output and orchestration tokens only in the total, model_usage records count, a task result's copy of child usage does not, and a nested subagent session counts on its own; then a title rewrite in place and a discarded message keep the usage seen, and a move to a sibling session counts the copied entries once. Rust only. |

### openclaw

| Case | Steps | What it covers |
| --- | --- | --- |
| `database-logs-and-archives` | 1 | Assistant messages count once by entry id across the agent database (plain and zstd-compressed events), a reset archive and a session log: input leaves both caches out and the total must equal the four kinds, so a total that holds the cache read inside input is skipped. Compaction checkpoint copies, user messages and entries without an id do not count; a log without a header is its file's session; message text never leaves SQLite or the reader. Rust only. |

### opencode

| Case | Steps | What it covers |
| --- | --- | --- |
| `flat-files-v1-v2-dedup` | 2 | The same message as a flat file, a v1 row and a v2 row counts once, scan after scan. |
| `flat-message-file` | 1 | A pre-1.2 storage/message file has the identity of its migrated row; other storage files are never opened. |
| `live-wal-database` | 4 | A database a running tool still writes (WAL): new rows and in-place updates are seen, a rescan does not double count, and a deleted row never refunds usage. |
| `v1-and-v2-projects` | 1 | Working folders come from the v1 row and the OpenCode 2 session; error messages, titles and parent ids in the rows are not kept. |
| `v1-fork-after-original-deleted` | 4 | A forked v1 message stays counted once after its original session is deleted, scan after scan; a new message in the fork still counts. |
| `v1-fork-copies-counted-once` | 1 | A v1 message copied into a forked session (same times, counters and model) counts once; a new message in the fork counts. |
| `v1-research-row` | 1 | A v1 assistant row: input excludes both caches, reasoning is added to output; user rows, malformed rows and zero-usage streaming rows are skipped. |
| `v2-assistant-and-compaction-rows` | 1 | OpenCode 2 assistant and compaction rows count (compaction with an unknown model); rows copied into a fork, rows without usage and user rows are skipped. |

### pi

| Case | Steps | What it covers |
| --- | --- | --- |
| `invalid-counters-and-missing-identity` | 1 | Usage before the session header and entries without an id are skipped with missing_stable_identity; a total below the four counts, reasoning above output and a negative counter are skipped with invalid_counters; malformed JSON is skipped; the valid message after them still counts. Rust only. |
| `sessions-forks-and-usage-entries` | 1 | Assistant messages and cache-warm usage entries count with disjoint caches and reasoning inside output, a total above the four counts is accepted, a forked session's copied entries count once, a colliding 8-character id at another time counts again, compaction usage and zero usage add nothing, and a message without a model is unknown. Rust only. |

### primeagent

| Case | Steps | What it covers |
| --- | --- | --- |
| `child-usage-attribution` | 2 | A recursive child session counts on its own and the parent's child_usage_attributed row, which repeats it, adds nothing; when the parent file is later rewritten with the child folded into the parent message (a total below its counts), that copy is skipped with invalid_counters, the parent's own usage stays and a new message counts. Rust only. |

### roo

| Case | Steps | What it covers |
| --- | --- | --- |
| `fast-apply-is-kilo-only` | 1 | A fast-apply tool call is not usage for Roo Code (only Kilo Code records it). |
| `half-written-history-item` | 1 | A history item that does not parse yet makes the task wait for the next scan (partial_document_pending). |
| `in-place-updates-and-truncation` | 6 | Requests updated in place count once, and usage stays through a deleted-request summary, an emptied task, a removed task and rescans. |
| `model-from-last-history-tag` | 1 | The model is the last <model> tag named anywhere in the conversation history. |
| `placeholders-deleted-and-condense-without-history` | 1 | Placeholder requests, deleted-request summaries and condense costs add nothing; with no conversation history the model is unknown and with no history item there is no project. |
| `research-fixture` | 1 | A task: tokensIn includes both caches (so they are split out), the model comes from the conversation history, the workspace from the history item; task metadata is ignored. |
| `sidecars-after-task` | 2 | A conversation history and history item written after the task re-read it: its usage gains the model and workspace and is not counted again. |
| `tokens-in-smaller-than-caches` | 1 | A tokensIn smaller than the caches comes from an older file where it was already uncached input. |

### unsloth

| Case | Steps | What it covers |
| --- | --- | --- |
| `forked-chat-counted-once` | 2 | A fork copies its thread's earlier messages with fresh ids and their original times; a fork of a fork copies them again. Each reply counts once, under the thread it was written in, and still once after that original thread is deleted. Rust only. |
| `replies-and-api-receipts` | 1 | Chat replies count from their contextUsage: the prompt includes both caches and the total is prompt plus completion. A local route is named local/<model that answered>, a provider's route by the model that answered; an older reply without response details takes the model from contextUsage or its thread. API receipts count prompt and completion with their model as written. Estimated usage, totals that do not add up, caches above the prompt and replies without usage are skipped; message text never leaves SQLite. Rust only. |

### zcode

| Case | Steps | What it covers |
| --- | --- | --- |
| `legacy-messages-until-model-usage` | 4 | Before model_usage exists, ZCode's assistant messages count (inclusive counters; Z.ai and custom providers; fork copies and sub-agents skipped). Once it exists only messages updated before its first row count, as ZCode writes both for each request since; later rows are read from a watermark, and after ZCode deletes its oldest rows, or all of them, the messages of the requests already counted are still not counted again. Rust only. |
| `model-usage-rows` | 1 | Completed model_usage attempts of Z.ai and custom providers count: input includes both caches and output includes reasoning, checked against the row's total (an input of 0 totals the caches); errors, running and cancelled attempts, bundled Anthropic, OpenAI and Google sub-agents and totals that do not add up are skipped; the message written for the same request and the database backup are not read. Rust only. |

### zed

| Case | Steps | What it covers |
| --- | --- | --- |
| `copied-database-counted-once` | 4 | A database copied or moved to another folder adds nothing: a thread's growth is measured against what any copy of the tool's databases already counted, so the copy's total counts once and only its later growth is added. Rust only. |
| `thread-totals-grow` | 3 | A thread's cumulative usage (input without caches) counts once; when it grows, only the growth counts, dated at the thread's update and given to its current model, so earlier days stay as they were. A lower total or a deleted thread keeps what was counted. JSON and zstd threads are read; imported threads and blobs that do not decode are skipped; titles, messages and project paths are never kept. Rust only. |

<!-- cases:end -->
