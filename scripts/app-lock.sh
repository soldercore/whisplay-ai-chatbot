#!/bin/bash
# A kernel lock, not a PID file: stale files are harmless; never unlink a lock
# inode while a process may still hold it. All supported Linux starts use this.
acquire_app_lock() {
  command -v flock >/dev/null 2>&1 || { echo '[Lifecycle] flock is required on Linux' >&2; return 1; }
  local directory="/tmp/whisplay-chatbot-$(id -u)"
  (umask 077; mkdir "$directory") 2>/dev/null || true
  if [ -L "$directory" ] || [ ! -d "$directory" ] || [ ! -O "$directory" ]; then
    echo '[Lifecycle] Unsafe runtime lock directory' >&2; return 1
  fi
  chmod 700 "$directory" || return 1
  local lock="$directory/application.lock"
  if [ -L "$lock" ] || { [ -e "$lock" ] && { [ ! -f "$lock" ] || [ ! -O "$lock" ]; }; }; then
    echo '[Lifecycle] Unsafe application lock' >&2; return 1
  fi
  exec 9>>"$lock" || return 1
  if ! flock -n 9; then
    echo '[Lifecycle] GLaDOS is already running or shutting down; duplicate launch refused' >&2
    exec 9>&-
    return 73
  fi
  export WHISPLAY_APPLICATION_LOCK="$lock"
}

# Wait for the old application AND its launcher to release the kernel lock.
# Used after a daemon exit request; never sends signals to a port owner.
wait_for_app_unlock() {
  local lock="/tmp/whisplay-chatbot-$(id -u)/application.lock"
  [ ! -e "$lock" ] && return 0
  [ ! -L "$lock" ] && [ -f "$lock" ] && [ -O "$lock" ] || return 1
  flock -w 15 "$lock" true
}
