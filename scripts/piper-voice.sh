#!/usr/bin/env bash
# Install and switch Piper voices for Whisplay (Piper 1.8 HTTP server).
#
# Whisplay sends PIPER_HTTP_VOICE as the "voice" field of each /synthesize
# request. Piper 1.8 loads <voice>.onnx from its data directories on first use
# and falls back to its default (-m) voice when the file is missing, so the
# existing voice always remains the default and the fallback. This script
# never edits the Piper systemd unit.
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${ENV_FILE:-$REPO_DIR/.env}"
PIPER_SERVICE="${PIPER_SERVICE:-whisplay-piper.service}"
PYTHON="${PYTHON:-python3}"

# GLaDOS voice, pinned to an exact Hugging Face revision and verified by hash.
GLADOS_REPO="rokeya71/VITS-Piper-GlaDOS-en-onnx"
GLADOS_REVISION="5852e4bfc742fdfc5dafcf94c06305695af37018"
GLADOS_ONNX_SHA256="17ea16dd18e1bac343090b8589042b4052f1e5456d42cad8842a4f110de25095"
GLADOS_JSON_SHA256="01f5e602e1ec04daec6d54960e4d641b5de305f39186e40bf9b4a47bd757a489"
GLADOS_DIR="$REPO_DIR/assets/voices/glados"

say() { printf '%s\n' "$*"; }
fail() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }

env_value() {
  [ -f "$ENV_FILE" ] || return 0
  { grep -E "^[[:space:]]*$1[[:space:]]*=" "$ENV_FILE" || true; } | tail -n1 | cut -d'=' -f2- |
    sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//' -e 's/^"//' -e 's/"$//' -e "s/^'//" -e "s/'$//"
}

piper_base_url() {
  local host port
  host="$(env_value PIPER_HTTP_HOST)"; port="$(env_value PIPER_HTTP_PORT)"
  printf 'http://%s:%s' "${host:-localhost}" "${port:-8805}"
}

synthesize_url() {
  local path_value
  path_value="$(env_value PIPER_HTTP_PATH)"
  path_value="${path_value:-/synthesize}"
  case "$path_value" in /*) ;; *) path_value="/$path_value" ;; esac
  printf '%s%s' "$(piper_base_url)" "$path_value"
}

sha256_of() { sha256sum "$1" | awk '{print $1}'; }

download_verified() { # url destination sha256
  local url="$1" dest="$2" expected="$3"
  if [ -f "$dest" ] && [ "$(sha256_of "$dest")" = "$expected" ]; then
    say "  ok (already downloaded): $dest"
    return 0
  fi
  say "  downloading $(basename "$dest") ..."
  curl -fL --retry 3 --connect-timeout 15 -o "$dest.part" "$url"
  local actual
  actual="$(sha256_of "$dest.part")"
  if [ "$actual" != "$expected" ]; then
    rm -f "$dest.part"
    fail "checksum mismatch for $(basename "$dest"): expected $expected, got $actual"
  fi
  mv "$dest.part" "$dest"
  say "  ok (sha256 verified): $dest"
}

validate_voice_config() { # path to .onnx.json
  "$PYTHON" - "$1" <<'PY'
import json, sys
path = sys.argv[1]
with open(path, encoding="utf-8") as f:
    config = json.load(f)
problems = []
if config.get("phoneme_type") != "espeak":
    problems.append(f"phoneme_type is {config.get('phoneme_type')!r}, expected 'espeak'")
if not (config.get("espeak") or {}).get("voice"):
    problems.append("espeak.voice is missing")
rate = (config.get("audio") or {}).get("sample_rate")
if not isinstance(rate, int) or rate <= 0:
    problems.append(f"audio.sample_rate is {rate!r}")
if not config.get("phoneme_id_map"):
    problems.append("phoneme_id_map is empty")
if int(config.get("num_speakers", 0)) < 1:
    problems.append("num_speakers < 1")
if problems:
    print("Invalid Piper voice config: " + "; ".join(problems))
    sys.exit(1)
print(f"  ok: espeak voice {config['espeak']['voice']}, {rate} Hz, "
      f"{config['num_speakers']} speaker(s), {len(config['phoneme_id_map'])} phonemes")
PY
}

# Directories the running Piper server searches for <voice>.onnx: its working
# directory plus any --data-dir arguments (Piper 1.8 http_server).
piper_data_dirs() {
  command -v systemctl >/dev/null 2>&1 || return 0
  systemctl cat "$PIPER_SERVICE" >/dev/null 2>&1 || return 0
  local exec_line workdir
  exec_line="$(systemctl show -p ExecStart --value "$PIPER_SERVICE" 2>/dev/null || true)"
  printf '%s\n' "$exec_line" | grep -oE -- '--data[-_]dir(=| +)[^ ;]+' | sed -E 's/--data[-_]dir(=| +)//' || true
  workdir="$(systemctl show -p WorkingDirectory --value "$PIPER_SERVICE" 2>/dev/null || true)"
  [ -n "$workdir" ] && [ "$workdir" != "/" ] && printf '%s\n' "$workdir"
  return 0
}

backup_service_config() {
  command -v systemctl >/dev/null 2>&1 || return 0
  systemctl cat "$PIPER_SERVICE" >/dev/null 2>&1 || { say "  $PIPER_SERVICE not found (skipping unit backup)"; return 0; }
  local backup_dir="$REPO_DIR/data/piper-service-backups"
  mkdir -p "$backup_dir"
  local backup="$backup_dir/$PIPER_SERVICE.$(date +%Y%m%d-%H%M%S).txt"
  {
    systemctl cat "$PIPER_SERVICE"
    printf '\n# systemctl show (selected)\n'
    systemctl show -p ExecStart -p WorkingDirectory -p User -p Environment "$PIPER_SERVICE"
  } > "$backup"
  say "  unit configuration saved to $backup (not modified)"
}

copy_into() { # source target_dir
  local source="$1" target_dir="$2" target
  target="$target_dir/$(basename "$source")"
  local sudo_cmd=""
  [ -w "$target_dir" ] || sudo_cmd="sudo"
  if [ -f "$target" ]; then
    if [ "$(sha256_of "$target")" = "$(sha256_of "$source")" ]; then
      say "  ok (already installed): $target"
      return 0
    fi
    $sudo_cmd mv "$target" "$target.bak-$(date +%Y%m%d-%H%M%S)"
    say "  kept the previous $target as a .bak file"
  fi
  $sudo_cmd install -m 0644 "$source" "$target"
  say "  installed $target"
}

cmd_install_glados() {
  local data_dir=""
  while [ $# -gt 0 ]; do
    case "$1" in
      --data-dir) data_dir="${2:-}"; shift 2 ;;
      *) fail "unknown option $1" ;;
    esac
  done

  say "1/4 Download GLaDOS voice ($GLADOS_REPO @ ${GLADOS_REVISION:0:12})"
  mkdir -p "$GLADOS_DIR"
  local base="https://huggingface.co/$GLADOS_REPO/resolve/$GLADOS_REVISION"
  download_verified "$base/glados.onnx.json" "$GLADOS_DIR/glados.onnx.json" "$GLADOS_JSON_SHA256"
  download_verified "$base/glados.onnx" "$GLADOS_DIR/glados.onnx" "$GLADOS_ONNX_SHA256"

  say "2/4 Validate voice configuration"
  validate_voice_config "$GLADOS_DIR/glados.onnx.json"

  say "3/4 Inspect the Piper service ($PIPER_SERVICE)"
  backup_service_config
  if [ -z "$data_dir" ]; then
    local dirs
    dirs="$(piper_data_dirs)"
    if [ -n "$dirs" ]; then
      say "  Piper searches these directories for voices:"
      printf '    %s\n' $dirs
      data_dir="$(printf '%s\n' "$dirs" | head -n1)"
    fi
  fi
  if [ -z "$data_dir" ]; then
    say ""
    say "Could not determine where $PIPER_SERVICE looks for voices (no --data-dir and no"
    say "WorkingDirectory). Nothing was installed into the service. Check the unit with:"
    say "  systemctl cat $PIPER_SERVICE"
    say "then re-run with the directory Piper searches, for example:"
    say "  bash scripts/piper-voice.sh install-glados --data-dir /path/to/piper/voices"
    exit 2
  fi
  [ -d "$data_dir" ] || fail "data directory does not exist: $data_dir"

  say "4/4 Install into $data_dir"
  copy_into "$GLADOS_DIR/glados.onnx.json" "$data_dir"
  copy_into "$GLADOS_DIR/glados.onnx" "$data_dir"
  say ""
  say "Done. Piper loads the voice on first use; no Piper restart is needed."
  say "Next: bash scripts/piper-voice.sh test glados"
  say "Then: bash scripts/piper-voice.sh use glados"
}

# Piper 1.8 names voices in GET /voices with "<file>.onnx.json".rstrip(".onnx.json"),
# which strips a set of characters ("glados" is listed as "glad"). /synthesize
# itself loads "<voice>.onnx" correctly, so accept the exact or the mangled name.
server_has_voice() { # voice -> 0 if the running Piper server can see it
  curl -fsS --max-time 10 "$(piper_base_url)/voices" 2>/dev/null |
    "$PYTHON" -c 'import json,sys
v = sys.argv[1]; names = json.load(sys.stdin)
sys.exit(0 if v in names or (v + ".onnx.json").rstrip(".onnx.json") in names else 1)' "$1"
}

cmd_test() {
  local voice="" play=false
  while [ $# -gt 0 ]; do
    case "$1" in
      --play) play=true; shift ;;
      *) voice="$1"; shift ;;
    esac
  done
  local url out body
  url="$(synthesize_url)"
  out="${TMPDIR:-/tmp}/piper-voice-test-${voice:-default}.wav"
  if [ -n "$voice" ]; then
    if server_has_voice "$voice"; then
      say "ok: the Piper server can see voice '$voice'"
    else
      fail "the Piper server at $(piper_base_url) does not list voice '$voice' (GET /voices); it would fall back to its default voice"
    fi
    body="{\"text\": \"Hello. This is a test of the Whisplay voice. The cake is a lie.\", \"voice\": \"$voice\"}"
  else
    body='{"text": "Hello. This is a test of the Whisplay voice."}'
  fi
  local start end status
  start=$(date +%s%N)
  status="$(curl -sS --max-time 120 -o "$out" -w '%{http_code}' -X POST -H 'Content-Type: application/json' -d "$body" "$url")"
  end=$(date +%s%N)
  [ "$status" = "200" ] || fail "POST $url returned HTTP $status: $(head -c 200 "$out")"
  "$PYTHON" - "$out" "$(( (end - start) / 1000000 ))" <<'PY'
import sys, wave, struct
path, elapsed_ms = sys.argv[1], int(sys.argv[2])
with open(path, "rb") as f:
    header = f.read(12)
if header[:4] != b"RIFF" or header[8:12] != b"WAVE":
    sys.exit(f"Not a WAV file: {header!r}")
with wave.open(path) as w:
    rate, channels, width, frames = w.getframerate(), w.getnchannels(), w.getsampwidth(), w.getnframes()
    data = w.readframes(frames)
duration = frames / rate
samples = struct.unpack(f"<{len(data) // 2}h", data) if width == 2 else ()
peak = max((abs(s) for s in samples), default=0)
if duration < 0.5 or peak < 500:
    sys.exit(f"Audio looks empty: {duration:.2f}s, peak {peak}")
print(f"ok: valid WAV {rate} Hz, {channels} ch, {8 * width}-bit, {duration:.2f}s audio, "
      f"synthesized in {elapsed_ms} ms (real-time factor {elapsed_ms / 1000 / duration:.2f})")
PY
  say "saved $out"
  if $play; then
    local device
    device="$(env_value ALSA_OUTPUT_DEVICE)"
    aplay -q -D "${device:-playback}" "$out"
  fi
}

backup_env() {
  [ -f "$ENV_FILE" ] || fail "$ENV_FILE not found"
  local backup_dir
  backup_dir="$(dirname "$ENV_FILE")/.env.backups"
  mkdir -p "$backup_dir"
  local backup="$backup_dir/.env.$(date +%Y%m%d-%H%M%S)"
  cp "$ENV_FILE" "$backup"
  say "backed up .env to $backup"
}

cmd_use() {
  local voice="${1:-}" restart=true force=false
  shift || true
  while [ $# -gt 0 ]; do
    case "$1" in
      --no-restart) restart=false; shift ;;
      --force) force=true; shift ;;
      *) fail "unknown option $1" ;;
    esac
  done
  [ -n "$voice" ] || fail "usage: piper-voice.sh use <voice|default>"
  backup_env
  if [ "$voice" = "default" ]; then
    sed -i '/^[[:space:]]*PIPER_HTTP_VOICE[[:space:]]*=/d' "$ENV_FILE"
    say "Whisplay now uses the Piper server's default voice."
  else
    if ! $force && ! server_has_voice "$voice"; then
      fail "the Piper server does not list voice '$voice'; install it first (or pass --force)"
    fi
    if grep -qE '^[[:space:]]*PIPER_HTTP_VOICE[[:space:]]*=' "$ENV_FILE"; then
      sed -i -E "s|^[[:space:]]*PIPER_HTTP_VOICE[[:space:]]*=.*|PIPER_HTTP_VOICE=$voice|" "$ENV_FILE"
    else
      printf '\nPIPER_HTTP_VOICE=%s\n' "$voice" >> "$ENV_FILE"
    fi
    say "Whisplay now uses Piper voice '$voice'."
  fi
  if $restart; then
    if command -v whisplay >/dev/null 2>&1; then
      whisplay service restart
    else
      say "Restart the chatbot to apply: whisplay service restart"
    fi
  else
    say "Restart the chatbot to apply: whisplay service restart"
  fi
}

cmd_status() {
  local current
  current="$(env_value PIPER_HTTP_VOICE)"
  say "PIPER_HTTP_VOICE: ${current:-(unset: server default voice)}"
  say "Synthesis URL:    $(synthesize_url)"
  if curl -fsS --max-time 10 "$(piper_base_url)/voices" -o /dev/null 2>/dev/null; then
    say "Voices the Piper server can load:"
    curl -fsS --max-time 10 "$(piper_base_url)/voices" | "$PYTHON" -c 'import json,sys; [print("  " + name) for name in json.load(sys.stdin)]'
  else
    say "Piper server not reachable at $(piper_base_url)"
  fi
}

case "${1:-help}" in
  install-glados) shift; cmd_install_glados "$@" ;;
  test) shift; cmd_test "$@" ;;
  use) shift; cmd_use "$@" ;;
  status) shift; cmd_status ;;
  help|-h|--help)
    cat <<'EOF'
Usage: bash scripts/piper-voice.sh <command>

  install-glados [--data-dir DIR]  Download the GLaDOS voice (pinned, sha256-checked),
                                   validate it and copy it to the Piper data directory.
  test [VOICE] [--play]            Synthesize through Piper /synthesize and check the WAV.
  use glados|default [--no-restart] Switch Whisplay's voice (backs up .env first).
  status                           Show the configured voice and the server's voices.
EOF
    ;;
  *) fail "unknown command $1 (try: help)" ;;
esac
