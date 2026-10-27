#!/usr/bin/env bash
# Unsigned CI packaging gate. It does not assert signing/notarization readiness.
set -euo pipefail
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
cd "$ROOT"
VERSION=$(node -p "JSON.parse(require('fs').readFileSync('package.json')).version")
TARGET=${CARGO_TARGET_DIR:-"$ROOT/target"}
[[ "$TARGET" == /* ]] || TARGET="$ROOT/$TARGET"
(cd apps/mac && cargo tauri build --no-bundle -- --locked && cargo tauri bundle --bundles app)
cargo build --locked --release -p tokentracky-cli --features embed-web
APP="$TARGET/release/bundle/macos/Tokentracky.app"
[[ "$("$TARGET/release/tokentracky" --version)" == "tokentracky $VERSION" ]]
[[ "$(lipo -archs "$TARGET/release/tokentracky")" == arm64 ]]
[[ "$(plutil -extract CFBundleShortVersionString raw "$APP/Contents/Info.plist")" == "$VERSION" ]]
BINARY=$(plutil -extract CFBundleExecutable raw "$APP/Contents/Info.plist")
[[ -x "$APP/Contents/MacOS/$BINARY" && "$(lipo -archs "$APP/Contents/MacOS/$BINARY")" == arm64 ]]
[[ -s "$APP/Contents/Resources/web/index.html" ]]
# Archive and extract the actual native bundle to validate its install root and resources.
TEMP=$(mktemp -d)
trap 'rm -rf "$TEMP"' EXIT
tar -C "$(dirname "$APP")" -czf "$TEMP/app.tar.gz" Tokentracky.app
tar -C "$TEMP" -xzf "$TEMP/app.tar.gz"
cmp "$APP/Contents/MacOS/$BINARY" "$TEMP/Tokentracky.app/Contents/MacOS/$BINARY"
python3 scripts/check-standalone-cli.py --binary "$TARGET/release/tokentracky" --web-dist "$ROOT/apps/web/dist"
echo 'Native arm64 CLI/version and app bundle/resource/archive checks passed (unsigned).'
