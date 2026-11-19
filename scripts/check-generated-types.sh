#!/usr/bin/env bash
# Fails when packages/core/src/generated differs from what crates/core generates. The price ceilings that
# crates/pricing generates for the hosted cost check are checked where that check lives, in tokentracky-web.
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
out="$(mktemp -d)"
trap 'rm -rf "$out"' EXIT
TOKENTRACKY_TS_OUT="$out/core" cargo test --quiet --manifest-path "$root/Cargo.toml" -p tokentracky-core --test typescript >/dev/null
if ! diff -ru "$root/packages/core/src/generated" "$out/core"; then
  echo "Generated TypeScript types are out of date. Run 'cargo test -p tokentracky-core' and commit packages/core/src/generated." >&2
  exit 1
fi
echo "Generated TypeScript types are up to date."
