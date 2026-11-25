#!/usr/bin/env bash
# The Windows or Linux app's release candidate in dist/desktop-release/<target>: its installers, built with the release
# updater configuration, the updater artifact signed for this version and checked against the public key, that
# platform's feed, checksums and provenance. Not code signed, like the CLI: Windows may warn before the installer runs.
# Runs on the target's own system (bash on Windows too).
set -euo pipefail
umask 077
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
cd "$ROOT"
TARGET=${1:-}
case "$TARGET" in
  x86_64-pc-windows-msvc) PLATFORM=windows-x86_64 FEED_TARGET=windows-x86_64 ;;
  x86_64-unknown-linux-gnu) PLATFORM=linux-x86_64 FEED_TARGET=linux-x86_64-appimage ;;
  *) echo 'usage: prepare-desktop-release.sh x86_64-pc-windows-msvc|x86_64-unknown-linux-gnu' >&2; exit 2 ;;
esac
DIST_DIR=${TOKENTRACKY_RELEASE_DIST:-"$ROOT/dist/desktop-release/$TARGET"}
TMP_DIR=$(mktemp -d "${TMPDIR:-/tmp}/tokentracky-desktop-release.XXXXXX")
CONFIG="$TMP_DIR/tauri.release.conf.json"
OUTPUT_CREATED=0
cleanup() {
  local status=$?
  if [[ "$status" != 0 && "$OUTPUT_CREATED" == 1 ]]; then rm -f "$DIST_DIR/${TOKENTRACKY_UPDATER_CHANNEL:-}.json"; fi
  rm -rf "$TMP_DIR"
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
trap 'exit 129' HUP
need() { if [[ -z "${!1:-}" ]]; then echo "missing required release secret/configuration: $1" >&2; exit 1; fi; }
for setting in TAURI_SIGNING_PRIVATE_KEY TOKENTRACKY_UPDATER_PUBLIC_KEY TOKENTRACKY_UPDATER_ENDPOINT \
  TOKENTRACKY_UPDATER_CHANNEL TOKENTRACKY_RELEASE_BASE_URL GITHUB_REF_NAME; do need "$setting"; done
[[ "$(cargo tauri --version)" == 'tauri-cli 2.11.5' ]] || { echo 'release requires Tauri CLI 2.11.5' >&2; exit 1; }
[[ -z "$(git status --porcelain --untracked-files=all)" ]] || { echo 'refusing dirty working tree' >&2; exit 1; }
# The signing mode fills only the release config's macOS section, which a Windows or Linux bundle ignores.
export TOKENTRACKY_SIGNING=adhoc
VERSION=$(node "$ROOT/scripts/macos-release.mjs" validate --root "$ROOT")
SHA=$(git rev-parse HEAD)
[[ "$GITHUB_REF_NAME" == "v$VERSION" && "$(git rev-parse "refs/tags/v$VERSION^{commit}")" == "$SHA" ]] || {
  echo 'release requires the exact version tag at HEAD' >&2; exit 1;
}
[[ ! -e "$DIST_DIR" ]] || { echo 'release destination must not already exist' >&2; exit 1; }
export SOURCE_DATE_EPOCH
SOURCE_DATE_EPOCH=$(git show -s --format=%ct HEAD)
# Use a fresh target directory so no previous binary or bundle can leak into a candidate.
export CARGO_TARGET_DIR="$TMP_DIR/target"
node "$ROOT/scripts/macos-release.mjs" config --root "$ROOT" --out "$CONFIG"
npm run build --workspace=@tokentracky/web
BUNDLE_LOG="$TMP_DIR/tauri-bundle.log"
# tauri.windows.conf.json or tauri.linux.conf.json picks the bundles: NSIS, or AppImage and .deb.
(
  cd "$ROOT/apps/mac"
  export TOKENTRACKY_RELEASE_UPDATER=1
  cargo tauri build --target "$TARGET" --config "$CONFIG" -- --locked
) 2>&1 | tee "$BUNDLE_LOG"
if grep -F 'does not match the public key' "$BUNDLE_LOG" >/dev/null; then
  echo 'Tauri signing key does not match TOKENTRACKY_UPDATER_PUBLIC_KEY' >&2; exit 1
fi
BUNDLE="$CARGO_TARGET_DIR/$TARGET/release/bundle"
mkdir -p "$DIST_DIR"
OUTPUT_CREATED=1
# The updater installs the NSIS installer on Windows and replaces the AppImage on Linux. A .deb is not updated.
if [[ "$PLATFORM" == windows-* ]]; then
  UPDATER="$DIST_DIR/tokentracky-${VERSION}-${PLATFORM}-setup.exe"
  cp "$BUNDLE/nsis/Tokentracky_${VERSION}_x64-setup.exe" "$UPDATER"
else
  UPDATER="$DIST_DIR/tokentracky-${VERSION}-${PLATFORM}.AppImage"
  cp "$BUNDLE/appimage/Tokentracky_${VERSION}_amd64.AppImage" "$UPDATER"
  cp "$BUNDLE/deb/Tokentracky_${VERSION}_amd64.deb" "$DIST_DIR/tokentracky-${VERSION}-${PLATFORM}.deb"
fi
# Sign the exact bytes for this version, as the Mac release does: the app requires the signed version to match.
cargo tauri signer sign --app-version "$VERSION" "$UPDATER"
node --input-type=module - "$UPDATER.sig" "$TMP_DIR" <<'NODE'
import { readFileSync, writeFileSync } from 'node:fs';
const [signature, dir] = process.argv.slice(2);
writeFileSync(`${dir}/updater.pub`, Buffer.from(process.env.TOKENTRACKY_UPDATER_PUBLIC_KEY, 'base64'));
writeFileSync(`${dir}/updater.sig`, Buffer.from(readFileSync(signature, 'utf8').trim(), 'base64'));
NODE
minisign -Vm "$UPDATER" -p "$TMP_DIR/updater.pub" -x "$TMP_DIR/updater.sig" | tee "$TMP_DIR/verified.txt"
grep -F "version:$VERSION" "$TMP_DIR/verified.txt" >/dev/null || { echo "updater signature is not for $VERSION" >&2; exit 1; }
{
  printf 'commit=%s\nsource_date_epoch=%s\nversion=%s\ntarget=%s\n' "$SHA" "$SOURCE_DATE_EPOCH" "$VERSION" "$TARGET"
  rustc --version
  node --version
  cargo tauri --version
} >"$DIST_DIR/source-provenance.txt"
BASE_URL=${TOKENTRACKY_RELEASE_BASE_URL%/}
node "$ROOT/scripts/macos-release.mjs" feed --out "$DIST_DIR/${TOKENTRACKY_UPDATER_CHANNEL}.json" --target "$FEED_TARGET" \
  --version "$VERSION" --artifact-url "$BASE_URL/$(basename "$UPDATER")" --signature-file "$UPDATER.sig"
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
echo "Prepared the $PLATFORM app candidate in $DIST_DIR"
