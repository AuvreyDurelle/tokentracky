#!/usr/bin/env bash
# One Linux or Windows CLI release candidate in dist/cli-release/<target>: the release binary with its dashboard,
# checked as installed, and its checksums, provenance and manifest fragment. Unsigned, like the ad-hoc Mac build;
# the SHA-256 checksums are its integrity. Runs on the target's own system (bash on Windows too).
set -euo pipefail
umask 077
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
cd "$ROOT"
TARGET=${1:-}
case "$TARGET" in
  x86_64-unknown-linux-musl) PLATFORM=linux-x86_64 EXE='' ;;
  aarch64-unknown-linux-musl) PLATFORM=linux-aarch64 EXE='' ;;
  x86_64-pc-windows-msvc) PLATFORM=windows-x86_64 EXE=.exe ;;
  *) echo 'usage: prepare-cli-release.sh x86_64-unknown-linux-musl|aarch64-unknown-linux-musl|x86_64-pc-windows-msvc' >&2
    exit 2 ;;
esac
DIST_DIR=${TOKENTRACKY_RELEASE_DIST:-"$ROOT/dist/cli-release/$TARGET"}
# Windows runners have `python`; `python3` there may be the Microsoft Store's placeholder.
PYTHON=${PYTHON:-python3}
TMP_DIR=$(mktemp -d "${TMPDIR:-/tmp}/tokentracky-cli-release.XXXXXX")
OUTPUT_CREATED=0
cleanup() {
  local status=$?
  if [[ "$status" != 0 && "$OUTPUT_CREATED" == 1 ]]; then rm -f "$DIST_DIR/manifest-fragment.json"; fi
  rm -rf "$TMP_DIR"
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
trap 'exit 129' HUP
[[ -n "${GITHUB_REF_NAME:-}" ]] || { echo 'missing required release configuration: GITHUB_REF_NAME' >&2; exit 1; }
[[ -z "$(git status --porcelain --untracked-files=all)" ]] || { echo 'refusing dirty working tree' >&2; exit 1; }
VERSION=$(node "$ROOT/scripts/macos-release.mjs" version --root "$ROOT")
SHA=$(git rev-parse HEAD)
[[ "$GITHUB_REF_NAME" == "v$VERSION" && "$(git rev-parse "refs/tags/v$VERSION^{commit}")" == "$SHA" ]] || {
  echo 'release requires the exact version tag at HEAD' >&2; exit 1;
}
[[ ! -e "$DIST_DIR" ]] || { echo 'release destination must not already exist' >&2; exit 1; }
export SOURCE_DATE_EPOCH
SOURCE_DATE_EPOCH=$(git show -s --format=%ct HEAD)
# Use a fresh target directory so no previous binary can leak into a candidate.
export CARGO_TARGET_DIR="$TMP_DIR/target"
npm run build --workspace=@tokentracky/web
cargo build --locked --release -p tokentracky-cli --features embed-web --target "$TARGET"
mkdir -p "$DIST_DIR"
OUTPUT_CREATED=1
CLI="$DIST_DIR/tokentracky-${VERSION}-${PLATFORM}${EXE}"
cp "$CARGO_TARGET_DIR/$TARGET/release/tokentracky$EXE" "$CLI"
[[ "$("$CLI" --version)" == "$VERSION" ]] || { echo 'CLI version mismatch' >&2; exit 1; }
# One static binary runs on every distribution; a dynamically linked one needs the build system's C library.
if [[ "$PLATFORM" == linux-* ]] && ! file -b "$CLI" | grep -E 'static(-pie)? linked' >/dev/null; then
  echo 'Linux CLI is not statically linked' >&2; exit 1
fi
"$PYTHON" "$ROOT/scripts/check-standalone-cli.py" --binary "$CLI" --web-dist "$ROOT/apps/web/dist"
cargo metadata --locked --format-version 1 >"$DIST_DIR/cargo-metadata.json"
{
  printf 'commit=%s\nsource_date_epoch=%s\nversion=%s\ntarget=%s\n' "$SHA" "$SOURCE_DATE_EPOCH" "$VERSION" "$TARGET"
  rustc --version
  node --version
} >"$DIST_DIR/source-provenance.txt"
node "$ROOT/scripts/macos-release.mjs" cli-candidate --out "$DIST_DIR/manifest-fragment.json" --version "$VERSION" \
  --target "$TARGET" --dist "$DIST_DIR"
# Node, not shasum or sha256sum: one checksum tool, and one output format, on every runner.
node --input-type=module - "$DIST_DIR" <<'NODE'
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const [dir] = process.argv.slice(2);
const files = readdirSync(dir).filter((name) => name !== 'SHA256SUMS').sort();
const sum = (name) => createHash('sha256').update(readFileSync(join(dir, name))).digest('hex');
writeFileSync(join(dir, 'SHA256SUMS'), files.map((name) => `${sum(name)}  ${name}\n`).join(''));
NODE
echo "Prepared the unsigned $PLATFORM CLI candidate in $DIST_DIR"
