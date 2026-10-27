#!/usr/bin/env bash
# Review-only release artifacts; all public configuration remains gated.
set -euo pipefail
umask 077
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
cd "$ROOT"
DIST_DIR=${TOKENTRACKY_RELEASE_DIST:-"$ROOT/dist/macos-release"}
TMP_DIR=$(mktemp -d "${TMPDIR:-/tmp}/tokentracky-macos-release.XXXXXX")
KEYCHAIN="$TMP_DIR/release.keychain-db"
NOTARY_KEY="$TMP_DIR/AuthKey.p8"
CONFIG="$TMP_DIR/tauri.release.conf.json"
PRIOR_KEYCHAINS=()
KEYCHAIN_CHANGED=0
KEYCHAIN_CREATED=0
OUTPUT_CREATED=0
cleanup() {
  local status=$?
  if [[ "$KEYCHAIN_CHANGED" == 1 ]]; then
    if ! security list-keychains -d user -s "${PRIOR_KEYCHAINS[@]}"; then
      echo 'ERROR: could not restore keychain search list' >&2
      status=1
    fi
  fi
  if [[ "$KEYCHAIN_CREATED" == 1 ]] && ! security delete-keychain "$KEYCHAIN" >/dev/null 2>&1; then
    echo 'ERROR: could not delete temporary signing keychain' >&2
    status=1
  fi
  if [[ "$status" != 0 && "$OUTPUT_CREATED" == 1 ]]; then rm -f "$DIST_DIR/verified-candidate-manifest.json"; fi
  rm -rf "$TMP_DIR"
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
trap 'exit 129' HUP
need() { if [[ -z "${!1:-}" ]]; then echo "missing required release secret/configuration: $1" >&2; exit 1; fi; }
need TOKENTRACKY_SIGNING
# Ad-hoc needs no Apple account: no certificate, keychain, notarization or stapling. Users
# confirm the first launch with Open Anyway. A missing mode never falls back to ad-hoc.
case "$TOKENTRACKY_SIGNING" in
  developer-id) APPLE=1 ;;
  adhoc) APPLE=0 ;;
  *) echo 'TOKENTRACKY_SIGNING must be adhoc or developer-id' >&2; exit 1 ;;
esac
if [[ "$APPLE" == 1 ]]; then
  for setting in APPLE_CERTIFICATE_BASE64 APPLE_CERTIFICATE_PASSWORD APPLE_SIGNING_IDENTITY \
    APPLE_API_KEY_ID APPLE_API_ISSUER APPLE_API_PRIVATE_KEY_BASE64; do need "$setting"; done
fi
for setting in TAURI_SIGNING_PRIVATE_KEY \
  TOKENTRACKY_UPDATER_PUBLIC_KEY TOKENTRACKY_UPDATER_ENDPOINT TOKENTRACKY_UPDATER_CHANNEL \
  TOKENTRACKY_RELEASE_BASE_URL GITHUB_REF_NAME GH_TOKEN; do need "$setting"; done
[[ "$(uname -sm)" == 'Darwin arm64' ]] || { echo 'release requires an Apple Silicon Mac' >&2; exit 1; }
[[ "$(cargo tauri --version)" == 'tauri-cli 2.11.5' ]] || { echo 'release requires Tauri CLI 2.11.5' >&2; exit 1; }
[[ -z "$(git status --porcelain --untracked-files=all)" ]] || { echo 'refusing dirty working tree' >&2; exit 1; }
VERSION=$(node "$ROOT/scripts/macos-release.mjs" validate --root "$ROOT")
SHA=$(git rev-parse HEAD)
[[ "$GITHUB_REF_NAME" == "v$VERSION" && "$(git rev-parse "refs/tags/v$VERSION^{commit}")" == "$SHA" ]] || {
  echo 'release requires the exact version tag at HEAD' >&2; exit 1;
}
# A successful entire CI workflow for this commit is mandatory, including hosted contracts,
# native compilation and distribution tests. A partial native-only gate is insufficient.
[[ "$(gh api "repos/AuvreyDurelle/tokentracky/actions/workflows/ci.yml/runs?head_sha=$SHA&per_page=100" \
  --jq ".workflow_runs | map(select(.head_sha == \"$SHA\" and (.event == \"push\" or .event == \"pull_request\"))) | first | if .status == \"completed\" and .conclusion == \"success\" then 1 else 0 end")" -gt 0 ]] || {
  echo 'full CI gate absent for release commit' >&2; exit 1;
}
[[ ! -e "$DIST_DIR" ]] || { echo 'release destination must not already exist' >&2; exit 1; }
export SOURCE_DATE_EPOCH
SOURCE_DATE_EPOCH=$(git show -s --format=%ct HEAD)
# Use a fresh target directory so no previous binary or pre-notary bundle can leak into a candidate.
export CARGO_TARGET_DIR="$TMP_DIR/target"
node "$ROOT/scripts/macos-release.mjs" config --root "$ROOT" --out "$CONFIG"
mkdir -p "$DIST_DIR"
OUTPUT_CREATED=1
decode_base64() { base64 --decode <"$1" >"$2" 2>/dev/null || base64 -D <"$1" >"$2"; }
if [[ "$APPLE" == 1 ]]; then
  printf '%s' "$APPLE_CERTIFICATE_BASE64" >"$TMP_DIR/certificate.base64"
  printf '%s' "$APPLE_API_PRIVATE_KEY_BASE64" >"$TMP_DIR/notary.base64"
  decode_base64 "$TMP_DIR/certificate.base64" "$TMP_DIR/certificate.p12"
  decode_base64 "$TMP_DIR/notary.base64" "$NOTARY_KEY"
  while IFS= read -r keychain; do
    keychain=${keychain#*\"}; keychain=${keychain%\"*}
    [[ -z "$keychain" ]] || PRIOR_KEYCHAINS+=("$keychain")
  done < <(security list-keychains -d user)
  [[ ${#PRIOR_KEYCHAINS[@]} -gt 0 ]] || { echo 'cannot capture prior keychain list' >&2; exit 1; }
  KEYCHAIN_PASSWORD=$(uuidgen)
  KEYCHAIN_CHANGED=1
  security create-keychain -p "$KEYCHAIN_PASSWORD" "$KEYCHAIN"
  KEYCHAIN_CREATED=1
  security set-keychain-settings -lut 21600 "$KEYCHAIN"
  security unlock-keychain -p "$KEYCHAIN_PASSWORD" "$KEYCHAIN"
  security import "$TMP_DIR/certificate.p12" -k "$KEYCHAIN" -P "$APPLE_CERTIFICATE_PASSWORD" -T /usr/bin/codesign
  security set-key-partition-list -S apple-tool:,apple:,codesign: -s -k "$KEYCHAIN_PASSWORD" "$KEYCHAIN" >/dev/null
  security list-keychains -d user -s "$KEYCHAIN" "${PRIOR_KEYCHAINS[@]}"
fi
npm run build --workspace=@tokentracky/web
BUNDLE_LOG="$TMP_DIR/tauri-bundle.log"
(
  cd "$ROOT/apps/mac"
  export TOKENTRACKY_RELEASE_UPDATER=1
  cargo tauri build --no-bundle --config "$CONFIG" -- --locked
  cargo tauri bundle --config "$CONFIG" --bundles app
) 2>&1 | tee "$BUNDLE_LOG"
if grep -F 'does not match the public key' "$BUNDLE_LOG" >/dev/null; then
  echo 'Tauri signing key does not match TOKENTRACKY_UPDATER_PUBLIC_KEY' >&2; exit 1
fi
cargo build --locked --release -p tokentracky-cli --features embed-web
APP="$CARGO_TARGET_DIR/release/bundle/macos/Tokentracky.app"
CLI="$DIST_DIR/tokentracky-${VERSION}-macos-arm64"
DMG="$DIST_DIR/tokentracky-${VERSION}-macos-arm64.dmg"
UPDATER="$DIST_DIR/Tokentracky.app.tar.gz"
[[ -d "$APP" ]] || { echo 'missing built application' >&2; exit 1; }
cp "$CARGO_TARGET_DIR/release/tokentracky" "$CLI"
if [[ "$APPLE" == 1 ]]; then
  codesign --force --options runtime --timestamp --keychain "$KEYCHAIN" --sign "$APPLE_SIGNING_IDENTITY" "$CLI"
else
  codesign --force --sign - "$CLI"
fi
verify_signature() {
  codesign --verify --deep --strict --verbose=2 "$1"
  if [[ "$APPLE" == 1 ]]; then
    codesign -dvv "$1" 2>&1 | grep -F "Authority=$APPLE_SIGNING_IDENTITY" >/dev/null
  else
    codesign -dv "$1" 2>&1 | grep -Fx 'Signature=adhoc' >/dev/null
  fi
}
verify_signature "$APP"
verify_signature "$CLI"
[[ "$("$CLI" --version)" == "tokentracky $VERSION" ]] || { echo 'CLI version mismatch' >&2; exit 1; }
# Reject accidental Intel or universal outputs instead of advertising them as arm64-only.
[[ "$(lipo -archs "$CLI")" == arm64 ]] && [[ "$(lipo -archs "$APP/Contents/MacOS/tokentracky-mac")" == arm64 ]]
python3 "$ROOT/scripts/check-standalone-cli.py" --binary "$CLI" --web-dist "$ROOT/apps/web/dist"
notarize() {
  local artifact=$1 receipt=$2
  xcrun notarytool submit "$artifact" --key "$NOTARY_KEY" --key-id "$APPLE_API_KEY_ID" --issuer "$APPLE_API_ISSUER" --wait --timeout 30m --output-format json >"$receipt"
  node "$ROOT/scripts/macos-release.mjs" notary --receipt "$receipt"
}
if [[ "$APPLE" == 1 ]]; then
  ditto -c -k --keepParent "$APP" "$TMP_DIR/app.zip"
  notarize "$TMP_DIR/app.zip" "$DIST_DIR/app-notary.json"
  xcrun stapler staple "$APP"
  xcrun stapler validate "$APP"
  verify_signature "$APP"
  spctl --assess --type execute --verbose=4 "$APP"
  # Raw Mach-O executables cannot carry stapled tickets. Submit its exact signed bytes in a
  # ZIP and require online Gatekeeper validation; keep the accepted receipt with the candidate.
  ditto -c -k --keepParent "$CLI" "$TMP_DIR/cli.zip"
  notarize "$TMP_DIR/cli.zip" "$DIST_DIR/cli-notary.json"
  spctl --assess --type execute --verbose=4 "$CLI"
fi
# Both distribution containers now use the same app (stapled when signed with Developer ID).
python3 "$ROOT/scripts/build-macos-dmg.py" "$APP" "$DMG"
if [[ "$APPLE" == 1 ]]; then
  codesign --force --timestamp --keychain "$KEYCHAIN" --sign "$APPLE_SIGNING_IDENTITY" "$DMG"
else
  codesign --force --sign - "$DMG"
fi
verify_signature "$DMG"
if [[ "$APPLE" == 1 ]]; then
  notarize "$DMG" "$DIST_DIR/dmg-notary.json"
  xcrun stapler staple "$DMG"
  xcrun stapler validate "$DMG"
  spctl --assess --type open --context context:primary-signature --verbose=4 "$DMG"
fi
tar -C "$(dirname "$APP")" -czf "$UPDATER" Tokentracky.app
mkdir "$TMP_DIR/updater-verify"
tar -C "$TMP_DIR/updater-verify" -xzf "$UPDATER"
[[ "$APPLE" == 0 ]] || xcrun stapler validate "$TMP_DIR/updater-verify/Tokentracky.app"
verify_signature "$TMP_DIR/updater-verify/Tokentracky.app"
diff -qr "$APP" "$TMP_DIR/updater-verify/Tokentracky.app"
# Discard the earlier Tauri bundle tar/signature; signing must cover the stapled bytes and
# the trusted app version. CLI 2.11.5 reads TAURI_SIGNING_PRIVATE_KEY from the environment.
cargo tauri signer sign --app-version "$VERSION" "$UPDATER"
node --input-type=module - "$UPDATER.sig" "$TMP_DIR" <<'NODE'
import { readFileSync, writeFileSync } from 'node:fs';
const [signature, dir] = process.argv.slice(2);
writeFileSync(`${dir}/updater.pub`, Buffer.from(process.env.TOKENTRACKY_UPDATER_PUBLIC_KEY, 'base64'));
writeFileSync(`${dir}/updater.sig`, Buffer.from(readFileSync(signature, 'utf8').trim(), 'base64'));
NODE
minisign -Vm "$UPDATER" -p "$TMP_DIR/updater.pub" -x "$TMP_DIR/updater.sig"
# Inventory and URLs are candidate evidence only; never copy the manifest into the npm
# package or enable the website automatically.
cargo metadata --locked --format-version 1 >"$DIST_DIR/cargo-metadata.json"
npm ls --all --json >"$DIST_DIR/npm-dependencies.json"
{
  printf 'commit=%s\nsource_date_epoch=%s\nversion=%s\n' "$SHA" "$SOURCE_DATE_EPOCH" "$VERSION"
  rustc --version
  node --version
  cargo tauri --version
  xcodebuild -version
} >"$DIST_DIR/source-provenance.txt"
git log -1 --format='%H%n%an%n%aI%n%s' >"$DIST_DIR/source-commit.txt"
git log --format='- %s (%h)' -20 >"$DIST_DIR/release-notes.md"
BASE_URL=${TOKENTRACKY_RELEASE_BASE_URL%/}
node "$ROOT/scripts/macos-release.mjs" feed --out "$DIST_DIR/${TOKENTRACKY_UPDATER_CHANNEL}.json" \
  --version "$VERSION" --artifact-url "$BASE_URL/$(basename "$UPDATER")" --signature-file "$UPDATER.sig"
node "$ROOT/scripts/macos-release.mjs" candidate --out "$DIST_DIR/verified-candidate-manifest.json" --version "$VERSION" --dist "$DIST_DIR"
node "$ROOT/packaging/scripts/generate-brew.mjs" "$DIST_DIR/verified-candidate-manifest.json" "$DIST_DIR/homebrew"
tar -C "$DIST_DIR/homebrew" -czf "$DIST_DIR/homebrew-definitions.tar.gz" Formula Casks
(cd "$DIST_DIR" && find . -type f ! -name SHA256SUMS -exec shasum -a 256 {} \; | LC_ALL=C sort >"$TMP_DIR/SHA256SUMS")
cp "$TMP_DIR/SHA256SUMS" "$DIST_DIR/SHA256SUMS"
if [[ "$APPLE" == 1 ]]; then
  echo "Prepared signed, notarized review artifacts in $DIST_DIR"
else
  echo "Prepared ad-hoc signed review artifacts (not notarized) in $DIST_DIR"
fi
