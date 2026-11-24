#!/usr/bin/env bash
# Unsigned CI packaging gate for the Windows and Linux app, as native-macos's check-native-package.sh is for the Mac:
# builds the installers the release ships (without the updater), checks what they hold, then runs them as users get
# them (smoke-desktop-linux.sh, smoke-desktop-windows.ps1). Needs the pinned tools of install-desktop-tools.sh.
set -euo pipefail
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
cd "$ROOT"
VERSION=$(node -p "JSON.parse(require('fs').readFileSync('package.json')).version")
TARGET=${CARGO_TARGET_DIR:-"$ROOT/target"}
[[ "$TARGET" == /* ]] || TARGET="$ROOT/$TARGET"
case "$(uname -s)" in
  Linux) BUNDLES=appimage,deb ;;
  MINGW* | MSYS*) BUNDLES=nsis ;;
  *) echo 'check-desktop-package.sh runs on Linux or Windows' >&2; exit 1 ;;
esac
(cd apps/mac && cargo tauri build --no-bundle -- --locked && cargo tauri bundle --bundles "$BUNDLES")
BUNDLE="$TARGET/release/bundle"
if [[ "$BUNDLES" == nsis ]]; then
  SETUP="$BUNDLE/nsis/Tokentracky_${VERSION}_x64-setup.exe"
  [[ -s "$SETUP" ]] || { echo "missing $SETUP" >&2; exit 1; }
  pwsh -NoProfile -File scripts/smoke-desktop-windows.ps1 -Installer "$(cygpath -w "$SETUP")"
else
  APPIMAGE="$BUNDLE/appimage/Tokentracky_${VERSION}_amd64.AppImage"
  DEB="$BUNDLE/deb/Tokentracky_${VERSION}_amd64.deb"
  [[ -x "$APPIMAGE" && -s "$DEB" ]] || { echo "missing $APPIMAGE or $DEB" >&2; exit 1; }
  [[ "$(dpkg-deb --field "$DEB" Version)" == "$VERSION" ]] || { echo 'the .deb has another version' >&2; exit 1; }
  dpkg-deb --field "$DEB" Package Depends
  dpkg-deb --contents "$DEB" | grep -E ' \./usr/bin/tokentracky-mac$' >/dev/null
  dpkg-deb --contents "$DEB" | grep -E '/web/index\.html$' >/dev/null
  bash scripts/smoke-desktop-linux.sh "$APPIMAGE" "$DEB"
fi
echo "The $BUNDLES bundle built and ran (unsigned, no updater)."
