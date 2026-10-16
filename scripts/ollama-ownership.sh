#!/bin/bash
# Sourced by run_chatbot.sh. No process is owned merely because it has a name
# or listens on a port. Only the background child created below may be stopped.
ollama_owned_pid=""

ollama_endpoint_healthy() (
  set -o pipefail
  curl --silent --show-error --fail --connect-timeout 2 --max-time 5 \
    "${1%/}/api/version" 2>/dev/null |
    node -e 'let s="";process.stdin.on("data",b=>s+=b);process.stdin.on("end",()=>{try{const j=JSON.parse(s);process.exit(typeof j.version==="string" && j.version.trim().length>0 ? 0:1)}catch{process.exit(1)}})'
)

ollama_child_running() {
  [ -n "$ollama_owned_pid" ] || return 1
  local child
  # The shell's own live-job table avoids signalling a recycled PID after a
  # failed background start. Do not use process-name or port-based ownership.
  while read -r child; do
    [ "$child" = "$ollama_owned_pid" ] && return 0
  done < <(jobs -pr)
  return 1
}

cleanup_owned_ollama() {
  if ollama_child_running; then
    echo "[Ollama] stopping chatbot-owned PID $ollama_owned_pid"
    kill -TERM "$ollama_owned_pid" 2>/dev/null || true
    local attempt
    for attempt in {1..20}; do
      ollama_child_running || break
      sleep 0.1
    done
    if ollama_child_running; then kill -KILL "$ollama_owned_pid" 2>/dev/null || true; fi
    wait "$ollama_owned_pid" 2>/dev/null || true
  fi
  ollama_owned_pid=""
}

prepare_ollama() {
  local endpoint="${1%/}" serve="$2"
  local label
  label=$(node -e 'try{const u=new URL(process.argv[1]);console.log(u.protocol+"//"+u.host)}catch{process.exit(1)}' "$endpoint") || label="[configured endpoint]"
  if ollama_endpoint_healthy "$endpoint"; then
    echo "[Ollama] external server detected at $label; SERVE_OLLAMA startup skipped"
    return 0
  fi
  if [ "$serve" != "true" ]; then
    echo "[Ollama] endpoint unavailable at $label; SERVE_OLLAMA=false, no server started" >&2
    return 1
  fi
  # Existing auto-start binds the default local port. Never start a local
  # server pretending it can repair an unavailable remote/custom endpoint.
  case "$endpoint" in
    http://localhost:11434|http://127.0.0.1:11434|http://0.0.0.0:11434) ;;
    *) echo "[Ollama] auto-start supports only the default local endpoint; configure $label externally" >&2; return 1 ;;
  esac
  OLLAMA_KEEP_ALIVE=-1 OLLAMA_HOST=0.0.0.0:11434 ollama serve &
  ollama_owned_pid=$!
  echo "[Ollama] started chatbot-owned PID $ollama_owned_pid"
  local attempt
  for attempt in {1..20}; do
    if ! ollama_child_running; then
      wait "$ollama_owned_pid" 2>/dev/null || true
      ollama_owned_pid=""
      # Another server may have won the bind race. Reuse it without ownership.
      if ollama_endpoint_healthy "$endpoint"; then
        echo "[Ollama] external server detected after startup race; reusing it"
        return 0
      fi
      echo "[Ollama] owned server exited before becoming healthy" >&2
      return 1
    fi
    if ollama_endpoint_healthy "$endpoint"; then return 0; fi
    sleep 0.25
  done
  echo "[Ollama] owned server did not become healthy" >&2
  cleanup_owned_ollama
  return 1
}
