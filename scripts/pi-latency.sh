#!/usr/bin/env bash
# Run from the separate reviewed checkout. Never manages processes or models.
set -euo pipefail
cd "$(dirname "$0")/.."
latency_root=$PWD
if [[ "${1:-plan}" == verify-cleanup ]]; then
  node -r ts-node/register/transpile-only scripts/pi-latency.cjs "$@"
  source scripts/app-lock.sh
  acquire_app_lock
  exec 9>&-
  exit 0
fi
if [[ "${1:-plan}" == benchmark ]]; then
  source scripts/app-lock.sh
  acquire_app_lock
fi
if [[ "${1:-plan}" == voice || "${1:-plan}" == check ]]; then
  [[ "${2:-}" == --confirm-idle && $# == 2 ]] || { echo 'Use voice --confirm-idle only in the agreed test window' >&2; exit 2; }
  [[ "${WHISPLAY_DIAGNOSTIC_RUNTIME_DIR:-}" == /* ]] || { echo 'Set WHISPLAY_DIAGNOSTIC_RUNTIME_DIR to the existing absolute application directory' >&2; exit 2; }
  cd "$WHISPLAY_DIAGNOSTIC_RUNTIME_DIR"
  export WHISPLAY_LATENCY_DIAGNOSTICS=true
  node -r ts-node/register/transpile-only "$latency_root/scripts/pi-latency.cjs" voice-check --confirm-idle
  [[ "$1" == voice ]] || exit 0
  source "$latency_root/scripts/app-lock.sh"
  acquire_app_lock
  WHISPLAY_DIAGNOSTIC_BUILD=$(git -C "$latency_root" rev-parse HEAD)
  export WHISPLAY_DIAGNOSTIC_BUILD
  exec python3 -B "$latency_root/scripts/diagnostic-session.py"
fi
if [[ "${1:-plan}" == benchmark ]]; then
  exec python3 -B "$latency_root/scripts/diagnostic-session.py" "$@"
fi
exec node -r ts-node/register/transpile-only scripts/pi-latency.cjs "$@"
