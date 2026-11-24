#!/usr/bin/env bash
# Runs the Linux app as users get it, against a throwaway data folder: the AppImage under Xvfb on this runner, then
# the .deb installed with its dependencies in a clean Ubuntu 22.04 container (`docker`). Each must open its dashboard
# (`[tokentracky] page-load finished path=/` on stderr). The AppImage must also record where it is, for the CLI.
set -euo pipefail
APPIMAGE=$(realpath "$1")
DEB=$(realpath "$2")
TMP_DIR=$(mktemp -d "${TMPDIR:-/tmp}/tokentracky-smoke.XXXXXX")
APP_PID=
# The app runs in a process group of its own, with its session bus and X server, so stopping it stops them all.
stop_app() {
  [[ -z "$APP_PID" ]] || kill -- "-$APP_PID" 2>/dev/null || true
  APP_PID=
}
cleanup() {
  stop_app
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT
# Waits up to 120 seconds for the dashboard's first page load in log $1.
loaded() {
  for _ in $(seq 120); do
    grep -F '[tokentracky] page-load finished path=/' "$1" >/dev/null && return 0
    sleep 1
  done
  cat "$1" >&2
  return 1
}

echo '== AppImage under Xvfb'
mkdir "$TMP_DIR/data"
# No FUSE on the runner: the AppImage runtime extracts itself instead, and still sets $APPIMAGE.
TOKENTRACKY_HOME="$TMP_DIR/data" TOKENTRACKY_PRICING_REFRESH=off APPIMAGE_EXTRACT_AND_RUN=1 \
  setsid dbus-run-session -- xvfb-run --auto-servernum "$APPIMAGE" --open-dashboard >"$TMP_DIR/appimage.log" 2>&1 &
APP_PID=$!
loaded "$TMP_DIR/appimage.log"
grep -F '[tokentracky]' "$TMP_DIR/appimage.log"
[[ "$(cat "$TMP_DIR/data/app-path")" == "$APPIMAGE" ]] || { echo 'the AppImage did not record its path' >&2; exit 1; }
stop_app

echo '== .deb in a clean Ubuntu 22.04'
docker run --rm -v "$DEB:/tmp/tokentracky.deb:ro" ubuntu:22.04 bash -euo pipefail -c '
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -qq
  # The package brings its own dependencies; Xvfb and a session bus are only for running it here.
  apt-get install -y -qq /tmp/tokentracky.deb xvfb xauth dbus-x11 >/dev/null
  dpkg -s tokentracky | grep -E "^(Version|Depends):"
  test -x /usr/bin/tokentracky-mac
  ! ldd /usr/bin/tokentracky-mac | grep "not found"
  mkdir /tmp/data
  TOKENTRACKY_HOME=/tmp/data TOKENTRACKY_PRICING_REFRESH=off \
    dbus-run-session -- xvfb-run --auto-servernum tokentracky-mac --open-dashboard >/tmp/app.log 2>&1 &
  for _ in $(seq 120); do
    if grep -F "[tokentracky] page-load finished path=/" /tmp/app.log >/dev/null; then grep -F "[tokentracky]" /tmp/app.log; exit 0; fi
    sleep 1
  done
  cat /tmp/app.log >&2
  exit 1
'
echo 'The AppImage and the .deb both opened the dashboard.'
