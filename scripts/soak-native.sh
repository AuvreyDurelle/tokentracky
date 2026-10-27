#!/usr/bin/env bash
# 24h native candidate soak. Short/unsigned runs are diagnostic and MUST fail release acceptance.
# scripts/soak-native.sh [--app PATH] [--cli PATH] [--duration-seconds 86400] [--sample-seconds 60]
# No automatic host sleep, network changes, credentials or production writes. See docs/RELEASE_PREREQUISITES.md.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
exec python3 -I "$ROOT/scripts/native_runtime.py" native-soak "$@"
