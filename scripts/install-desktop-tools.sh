#!/usr/bin/env bash
# The tools that bundle the Windows and Linux app, each pinned by version and SHA-256: the prebuilt Tauri CLI, and
# what its bundler would otherwise download unpinned on first use (some from `master` or `continuous`). Seeding the
# bundler's tool cache (`~/.cache/tauri` on Linux, `%LOCALAPPDATA%\tauri` on Windows) makes it use these copies.
# Runs on the runner it bundles on: Linux x64, or Windows x64 under Git Bash.
set -euo pipefail
TMP_DIR=$(mktemp -d "${TMPDIR:-/tmp}/tokentracky-desktop-tools.XXXXXX")
trap 'rm -rf "$TMP_DIR"' EXIT
fetch() { # url sha256 destination
  curl --fail --location --silent --show-error --retry 3 "$1" --output "$TMP_DIR/download"
  echo "$2  $TMP_DIR/download" | sha256sum --check --quiet
  mkdir -p "$(dirname "$3")"
  mv "$TMP_DIR/download" "$3"
}
TAURI=https://github.com/tauri-apps/tauri/releases/download/tauri-cli-v2.11.5
mkdir -p "$HOME/.cargo/bin"
case "$(uname -s)" in
  Linux)
    fetch "$TAURI/cargo-tauri-x86_64-unknown-linux-gnu.tgz" \
      e75e2a1e8d3bceba327a10640a08b0bfef6d7559e8e13274629189001f2fce08 "$TMP_DIR/cargo-tauri.tgz"
    tar -xzf "$TMP_DIR/cargo-tauri.tgz" -C "$TMP_DIR"
    install -m 755 "$TMP_DIR/cargo-tauri" "$HOME/.cargo/bin/cargo-tauri"
    TOOLS=${XDG_CACHE_HOME:-$HOME/.cache}/tauri
    BINARIES=https://github.com/tauri-apps/binary-releases/releases/download
    fetch "$BINARIES/apprun-old/AppRun-x86_64" \
      f30140a43a0a59e46db21bdefdf749b9e9f2c6946e92afabbacf98b8ae73fb4f "$TOOLS/AppRun-x86_64"
    fetch "$BINARIES/linuxdeploy/linuxdeploy-x86_64.AppImage" \
      e762bea85c8eb0d4b3508d46e5c1f037f717d0f9303ae3b4aafc8b04991fa1ef "$TOOLS/linuxdeploy-x86_64.AppImage"
    fetch https://raw.githubusercontent.com/tauri-apps/linuxdeploy-plugin-gtk/dda522bce37387f1b853d9095713bfaa924c8423/linuxdeploy-plugin-gtk.sh \
      7804c9eef13e59bf2783aad9882ef9db8f3f3f9e8d631874b1d348d550a3693f "$TOOLS/linuxdeploy-plugin-gtk.sh"
    fetch https://raw.githubusercontent.com/tauri-apps/linuxdeploy-plugin-gstreamer/2a2e67491c32995a3f279ad0ecbe77abd512b42a/linuxdeploy-plugin-gstreamer.sh \
      c107b49d84edbffc6ab226ed1007e0626a4f7aa2c3a36b7782bef62351d49e94 "$TOOLS/linuxdeploy-plugin-gstreamer.sh"
    fetch https://github.com/linuxdeploy/linuxdeploy-plugin-appimage/releases/download/1-alpha-20250213-1/linuxdeploy-plugin-appimage-x86_64.AppImage \
      992d502a248e14ab185448ddf6f6e7d25558cb84d4623c354c3af350c25fccb3 "$TOOLS/linuxdeploy-plugin-appimage.AppImage"
    chmod 755 "$TOOLS"/*
    ;;
  MINGW* | MSYS*)
    fetch "$TAURI/cargo-tauri-x86_64-pc-windows-msvc.zip" \
      0768231574a4bea9229fd151c17dbe0118c95955630910a507c3b7f098b09531 "$TMP_DIR/cargo-tauri.zip"
    unzip -q "$TMP_DIR/cargo-tauri.zip" -d "$TMP_DIR/cargo-tauri"
    install -m 755 "$TMP_DIR/cargo-tauri/cargo-tauri.exe" "$HOME/.cargo/bin/cargo-tauri.exe"
    TOOLS=$(cygpath -u "$LOCALAPPDATA")/tauri
    rm -rf "$TOOLS/NSIS"
    fetch https://github.com/tauri-apps/binary-releases/releases/download/nsis-3.11/nsis-3.11.zip \
      c7d27f780ddb6cffb4730138cd1591e841f4b7edb155856901cdf5f214394fa1 "$TMP_DIR/nsis.zip"
    unzip -q "$TMP_DIR/nsis.zip" -d "$TMP_DIR"
    mkdir -p "$TOOLS"
    mv "$TMP_DIR/nsis-3.11" "$TOOLS/NSIS"
    fetch https://github.com/tauri-apps/nsis-tauri-utils/releases/download/nsis_tauri_utils-v0.5.3/nsis_tauri_utils.dll \
      5ba143b5db4a87d32d6e7802e033330aae56cbceabe0d1e3ba41948385ad4709 \
      "$TOOLS/NSIS/Plugins/x86-unicode/additional/nsis_tauri_utils.dll"
    ;;
  *) echo 'install-desktop-tools.sh runs on Linux or Windows' >&2; exit 1 ;;
esac
cargo tauri --version
