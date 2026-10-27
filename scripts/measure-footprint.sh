#!/usr/bin/env bash
# Populated unsigned/signed Mac bundle measurement; all responsibility-attributed helpers are included.
# scripts/measure-footprint.sh [--app PATH] [--cli PATH] [--idle-seconds 600] [--launches 5] [--cycles 3]
# Each cycle opens BOTH Leaderboard and You. Normal quit is graceful; SIGKILL is a separate recovery case.
# Requires binaries rebuilt with TOKENTRACKY_TEST_KEYCHAIN_NAMESPACE support. Never reads real source logs.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
exec python3 -I "$ROOT/scripts/native_runtime.py" footprint "$@"
