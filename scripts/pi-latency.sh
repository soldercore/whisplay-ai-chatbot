#!/usr/bin/env bash
# Run from the separate reviewed checkout. Never manages processes or models.
set -euo pipefail
cd "$(dirname "$0")/.."
latency_root=$PWD
if [[ "${1:-plan}" == benchmark || "${1:-plan}" == voice || "${1:-plan}" == check ]]; then
  source scripts/app-lock.sh
  acquire_app_lock
fi
if [[ "${1:-plan}" == voice || "${1:-plan}" == check ]]; then
  [[ "${2:-}" == --confirm-idle && $# == 2 ]] || { echo 'Use voice --confirm-idle only in the agreed test window' >&2; exit 2; }
  [[ "${WHISPLAY_DIAGNOSTIC_RUNTIME_DIR:-}" == /* ]] || { echo 'Set WHISPLAY_DIAGNOSTIC_RUNTIME_DIR to the existing absolute application directory' >&2; exit 2; }
  cd "$WHISPLAY_DIAGNOSTIC_RUNTIME_DIR"
  node -r ts-node/register/transpile-only "$latency_root/scripts/pi-latency.cjs" voice-check --confirm-idle
  [[ "$1" == voice ]] || exit 0
  export WHISPLAY_LATENCY_DIAGNOSTICS=true
  WHISPLAY_DIAGNOSTIC_BUILD=$(git -C "$latency_root" rev-parse HEAD)
  export WHISPLAY_DIAGNOSTIC_BUILD
  node "$latency_root/dist/index.js"
  exit $?
fi
node -r ts-node/register/transpile-only scripts/pi-latency.cjs "$@"
