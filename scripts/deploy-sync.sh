#!/usr/bin/env bash
# App code transfer only. Runtime state is receiver-owned, never synchronized.
sync_aihat_code() {
  local source_dir="$1" destination="$2"
  shift 2
  rsync -az --protect-args \
    --exclude='/.git' \
    --exclude='/node_modules' \
    --exclude='/dist' \
    --include='/.env.template' --exclude='/.env*' \
    --exclude='/data' --exclude='/knowledge' --exclude='/plugins' \
    --exclude='/assets/voices' --exclude='/docker/volume' \
    --exclude='/.test-artifacts' --exclude='/use_npm' --exclude='/use_ollama' --exclude='*.log' \
    "$@" -- "${source_dir%/}/" "${destination%/}/"
}
