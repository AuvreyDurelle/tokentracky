# tokentracky-core

Shared types, validation and UTC day maths, ported from `packages/core`. These Rust types are the source of truth for the API types; the TypeScript runtime logic in `packages/core` is kept and duplicated here.

## Generated TypeScript

`cargo test -p tokentracky-core` (or `cargo test --workspace`) runs `tests/typescript.rs`, which writes `packages/core/src/generated/index.ts` with ts-rs: every API type, plus the `TOOL_IDS` and `TOOL_NAMES` constants taken from `ToolId`. `packages/core/src/index.ts` re-exports that file, so imports from `@tokentracky/core` are unchanged. Commit the regenerated file with the Rust change.

- `TOKENTRACKY_TS_OUT=<dir>` writes to another directory instead.
- `scripts/check-generated-types.sh` regenerates into a temp directory and fails if the committed file differs. CI runs it in the `rust` job.

## Shape rules

- `u64` counters carry `#[ts(type = "number")]` (or `number | null`, `Array<number>`, `Partial<Record<ToolId, number>>`). JSON values stay at or below `MAX_SAFE_INTEGER`. The generator fails if any `bigint` slips through.
- `T | null` is `Option<T>`, always serialised. `field?: T` is `Option<T>` with `skip_serializing_if` and `#[ts(optional)]`.
- `field?: T | null` is `Option<Option<T>>` read with `deserialize_with = "present"`, so absent (not shared) and `null` (unknown) round-trip separately.
- `PublicBucket.tool` is `BucketTool`: `"all"` or a `ToolId`.
- Anonymous TypeScript object types are small Rust structs marked `#[ts(inline)]`, so they generate no extra exported names.
