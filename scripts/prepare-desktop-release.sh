#!/usr/bin/env bash
# One Windows or Linux app release candidate in dist/app-release/<platform>: the installers (Windows: the per-user
# NSIS installer; Linux: the AppImage and the .deb), built with the updater; the updater signature of the one that
# updates itself (the NSIS installer, the AppImage) and a feed for its platform; run as users get them; with
# checksums and provenance. Not code-signed, like the CLI: Windows' SmartScreen asks once. Runs on the target's own
# runner (bash on Windows too), with the pinned tools of install-desktop-tools.sh.
set -euo pipefail
umask 077
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
cd "$ROOT"
case "$(uname -s)" in
  Linux) PLATFORM=linux-x86_64 BUNDLES=appimage,deb FEED_TARGET=linux-x86_64-appimage ;;
  MINGW* | MSYS*) PLATFORM=windows-x86_64 BUNDLES=nsis FEED_TARGET=windows-x86_64 ;;
  *) echo 'prepare-desktop-release.sh runs on Linux or Windows' >&2; exit 2 ;;
esac
DIST_DIR=${TOKENTRACKY_RELEASE_DIST:-"$ROOT/dist/app-release/$PLATFORM"}
TMP_DIR=$(mktemp -d "${TMPDIR:-/tmp}/tokentracky-app-release.XXXXXX")
CONFIG="$TMP_DIR/tauri.release.conf.json"
OUTPUT_CREATED=0
cleanup() {
  local status=$?
  if [[ "$status" != 0 && "$OUTPUT_CREATED" == 1 ]]; then rm -f "$DIST_DIR/feed.json"; fi
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
# The release settings' macOS signing mode does not apply to these builds.
export TOKENTRACKY_SIGNING=adhoc
VERSION=$(node "$ROOT/scripts/macos-release.mjs" validate --root "$ROOT")
SHA=$(git rev-parse HEAD)
[[ "$GITHUB_REF_NAME" == "v$VERSION" && "$(git rev-parse "refs/tags/v$VERSION^{commit}")" == "$SHA" ]] || {
  echo 'release requires the exact version tag at HEAD' >&2; exit 1;
}
[[ ! -e "$DIST_DIR" ]] || { echo 'release destination must not already exist' >&2; exit 1; }
export SOURCE_DATE_EPOCH
SOURCE_DATE_EPOCH=$(git show -s --format=%ct HEAD)
# Use a fresh target directory so no previous binary can leak into a candidate.
export CARGO_TARGET_DIR="$TMP_DIR/target"
node "$ROOT/scripts/macos-release.mjs" config --root "$ROOT" --out "$CONFIG"
npm run build --workspace=@tokentracky/web
BUNDLE_LOG="$TMP_DIR/tauri-bundle.log"
(
  cd "$ROOT/apps/mac"
  export TOKENTRACKY_RELEASE_UPDATER=1
  cargo tauri build --no-bundle --config "$CONFIG" -- --locked
  # CLI 2.11.5 signs the updater artifacts with TAURI_SIGNING_PRIVATE_KEY from the environment.
  cargo tauri bundle --config "$CONFIG" --bundles "$BUNDLES"
) 2>&1 | tee "$BUNDLE_LOG"
if grep -F 'does not match the public key' "$BUNDLE_LOG" >/dev/null; then
  echo 'Tauri signing key does not match TOKENTRACKY_UPDATER_PUBLIC_KEY' >&2; exit 1
fi
mkdir -p "$DIST_DIR"
OUTPUT_CREATED=1
BUNDLE="$CARGO_TARGET_DIR/release/bundle"
if [[ "$PLATFORM" == windows-* ]]; then
  UPDATER="$DIST_DIR/tokentracky-${VERSION}-windows-x86_64-setup.exe"
  cp "$BUNDLE/nsis/Tokentracky_${VERSION}_x64-setup.exe" "$UPDATER"
  cp "$BUNDLE/nsis/Tokentracky_${VERSION}_x64-setup.exe.sig" "$UPDATER.sig"
  pwsh -NoProfile -File "$ROOT/scripts/smoke-desktop-windows.ps1" -Installer "$(cygpath -w "$UPDATER")"
else
  UPDATER="$DIST_DIR/tokentracky-${VERSION}-linux-x86_64.AppImage"
  cp "$BUNDLE/appimage/Tokentracky_${VERSION}_amd64.AppImage" "$UPDATER"
  cp "$BUNDLE/appimage/Tokentracky_${VERSION}_amd64.AppImage.sig" "$UPDATER.sig"
  cp "$BUNDLE/deb/Tokentracky_${VERSION}_amd64.deb" "$DIST_DIR/tokentracky-${VERSION}-linux-x86_64.deb"
  chmod 755 "$UPDATER"
  bash "$ROOT/scripts/smoke-desktop-linux.sh" "$UPDATER" "$DIST_DIR/tokentracky-${VERSION}-linux-x86_64.deb"
fi
# The publish job merges this into the one feed every platform's app reads.
node "$ROOT/scripts/macos-release.mjs" feed --out "$DIST_DIR/feed.json" --version "$VERSION" \
  --artifact-url "${TOKENTRACKY_RELEASE_BASE_URL%/}/$(basename "$UPDATER")" --signature-file "$UPDATER.sig" \
  --target "$FEED_TARGET"
{
  printf 'commit=%s\nsource_date_epoch=%s\nversion=%s\nplatform=%s\n' "$SHA" "$SOURCE_DATE_EPOCH" "$VERSION" "$PLATFORM"
  rustc --version
  node --version
  cargo tauri --version
} >"$DIST_DIR/source-provenance.txt"
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
