# Production baseline (Pi 5), 2026-11-16

This branch is the source of what runs on the production Raspberry Pi 5 on 2026-11-16.
It was verified by hash against the files on the device; it is not a description of intent.

The published branch `public/pi5-baseline` is the same tree with one source change: the
TV wake code no longer contains the router's address (see "Machine-specific TV
configuration" below). Its compiled `device/lg-c1-volume.js` therefore differs from the
file on the Pi until that change is deployed. The companion branch with the same name in the
Whisplay driver repository holds the driver/launcher baseline.

### Expected difference from production: one file

Exactly one compiled file of this branch differs from the Pi by design:
`dist/device/lg-c1-volume.js`. The Pi's copy has the router address compiled in; this
branch reads it from the private configuration instead. The public manifest
(`scripts/predeploy/production-dist.sha256`) therefore records the hash of the sanitized
build for that file, not the production hash. The production hash is kept privately by
the owner and is not published, because it would let anyone confirm a guessed address.
How to verify the Pi against it is in `scripts/predeploy/README.md` (`--manifest`).
Every other compiled file in the public manifest is the Pi's actual hash.

## WARNING: the Pi's `src/` is stale

The deployed `src/` on the Pi is NOT the source of the deployed `dist/`. Seven files are
older than what `dist/` runs (`src/core/ChatFlow.ts`, `src/core/chat-flow/states.ts`,
`src/device/wakeword.ts`, `src/device/audio.ts`, `src/config/device-result-speech.ts`,
`src/config/web-search-router.ts`, `src/utils/index.ts`) and `src/utils/empty-recording.ts`
is missing. Building on the Pi would silently revert deployed fixes (recorder onset,
wake acknowledgement, empty-recording skip, search decision).

Do not run `npm run build`, `yarn build`, `bash build.sh` or `whisplay update` on the Pi
until source is deployed consistently from this branch. `run_chatbot.sh` prints a
"src newer than dist, run yarn build" hint on every start; ignore it on the Pi.

## What runs

| Component | Version / setting |
|---|---|
| Hardware / OS | Raspberry Pi 5, Debian 13 (trixie), 64-bit kernel 6.18 |
| Node / TypeScript | Node 24.22.0 on the Pi; dist compiled with tsc 5.9.3 (`yarn.lock`) |
| Python | 3.13.5 (system); wake word in a separate venv with onnxruntime 1.32.0 |
| App | `node dist/index.js` under `run_chatbot.sh`, launched by the Whisplay daemon (no `chatbot.service`) |
| LLM | Ollama 0.34.4, `openbmb/minicpm5-2b:q4_K_M`, 4096-token slot, keep-alive forever; `qwen3.5:2b-q4_K_M` installed, not loaded |
| ASR | `whisplay-whisper.service`: faster-whisper 1.2.1, model `base`, `docker/faster-whisper-http/faster-whisper-host.py` on 127.0.0.1:8803 |
| TTS | `whisplay-piper.service`: Piper 1.8.0 HTTP on 127.0.0.1:8805, GLaDOS voice via `PIPER_HTTP_VOICE` |
| Wake word | "Capri": openWakeWord model `capri_v2` (ONNX, outside the repo), threshold 0.3, in `python/capri_wake.py` |
| UI | `python/chatbot-ui.py` terminal UI, landscape layout (`WHISPLAY_UI_LAYOUT=landscape`), UI socket 127.0.0.1:12345 |
| Driver | Whisplay daemon (`whisplay-daemon.service`), helper `/usr/lib/whisplay/control-action` (root, 755) |
| Battery | `pisugar-server`, loopback only |

Active system units: `ollama`, `whisplay-daemon`, `whisplay-whisper`, `whisplay-piper`,
`whisplay-soundcard-warmup` (oneshot), `pisugar-server`. Only SSH listens on a
non-loopback address.

Behaviour switches in the Pi `.env` (values, no secrets): `LLM_SERVER=ollama`,
`OLLAMA_ENABLE_TOOLS=true`, `ASR_SERVER=faster-whisper`, `TTS_SERVER=piper-http`,
`ASSISTANT_PERSONA=glados`, `GLADOS_PERSONA_VARIANT=A`, `MEMORY_ENABLED=true`,
`MEMORY_AUTO_SAVE=false`, `WEB_SEARCH_ENABLED=true`, `CAPRI_WAKE_WORD_ENABLED=true`,
`RECORDER_ONSET_FIX=1`, `QUESTION_FOLLOWUPS=1`, `CONVERSATION_FOLLOWUPS=0`,
`TV_DUCKING=1`, `WHISPLAY_UI_LAYOUT=landscape`. The `.env` itself is never committed.

## Machine-specific TV configuration

Nothing machine-specific is compiled in. The TV code reads everything from the private
directory `data/.glados-tv/` (mode 700, files mode 600, owned by the app user; never in git):

- `target.json`: TV address (`host`, a private IPv4 address) and certificate `fingerprint`.
- one pairing file per purpose (`host`, `fingerprint`, `key`), written by the pairing flow.
- `wake-rpc.json`: router RPC `password`, pinned router `certificate` (PEM) and its
  `fingerprint`. The router address used for TV wake-up is the IPv4 address in that
  certificate's subjectAltName. Exactly one IPv4 entry, in a private range, is required;
  otherwise wake-up fails closed with "Invalid router certificate" (the same error as before
  for a certificate that does not name the router).

The Pi's existing `wake-rpc.json` already satisfies this (checked read-only on 2026-11-16:
one IPv4 entry, equal to the address the deployed build has compiled in), so deploying
`public/pi5-baseline` needs no configuration change on the Pi.

## How this branch was assembled

- Base: `67fb326` (landscape UI; contains every deployed candidate up to it).
- Cherry-picked: `5267ee0` and `3481219` (search decision); their compiled
  `config/web-search-router.js` and `utils/index.js` are deployed.
- Added the deployed bytes of both `faster-whisper-host.py` copies (listen on 127.0.0.1).
- Manifests in `scripts/predeploy/` regenerated from the Pi.

## Reproducibility (verified 2026-11-16)

Isolated clone, `yarn install --frozen-lockfile` (Yarn 1.22.22), `yarn build`:

- `dist/`: 153 of 154 files byte-identical to the Pi (`public/pi5-baseline`: 152 of 154; the
  other one is `device/lg-c1-volume.js`, described above). `dist/config/web-search.js` has
  the same code but different line wrapping, see below. The sanitized build matches the
  public manifest in all 154 files (web-search.js through its whitespace-stripped hash).
- `python/`, `scripts/`, `docker/`, `bin/`, `cli/`, `web/`, `run_chatbot.sh`: identical,
  except `python/dev/preview_ui.py` (a development tool; the Pi has an older copy).
- `package.json` differs only in the test file list (the Pi has an older one).
- Not in git by design: `.env*`, `data/`, logs, TV pairing data, `node_modules`, `dist`,
  downloaded assets (`python/emoji_svg*`, `python/NotoSansSC-Bold.ttf`), the wake-word
  model and its venv.

Check any future build with `node scripts/predeploy/check.cjs` (see `scripts/predeploy/README.md`).

### Known formatting-only difference: `dist/config/web-search.js`

The Pi's file was not produced by `tsc`. It was edited by hand on 2026-11-09 (stage
`web-v1`): the previous compiled file was patched with the new code, then the matching
source was copied next to it, and only this one compiled file changed in that stage. The
four lines that differ are all inside the code added by that change and differ only in
indentation and in where one `if` statement breaks its line.

Checked on 2026-11-16 with the TypeScript 5.9.3 parser: both files have the same 6723
tokens in the same order with the same text, the same comments and the same text once
whitespace is removed, and printing the Pi's file with the TypeScript printer gives a file
byte-identical to the `tsc` output of `src/config/web-search.ts` from this branch. That
source is identical to the Pi's `src/config/web-search.ts`. No source change is needed;
the next deploy of this file replaces it with the `tsc` output.

## Deploy procedure as practised

1. Build and test on the PC from a branch based on this one; run the predeploy gate
   with `--expect` listing exactly the compiled files the change is meant to alter.
2. Hash-compare every file to be replaced against the Pi first (never assume the Pi
   equals any branch).
3. Copy only the changed files into a new stage directory on the Pi with a deploy
   script that backs up the originals with their hashes, replaces the files, relaunches
   the app through the daemon and checks the startup log; it restores automatically
   when a check fails.
4. Physical acceptance by the owner. One change per deploy.

Python changes must be built on a copy fetched from the Pi, not from an older branch
(an older `capri_wake.py` once nearly reverted a deployed fix).

## Rollback

Each deploy stage directory holds `backup/` and a `restore` mode
(`python3 -B deploy-*.py restore`). Roll back newest first; never restore an older stage
while a newer one is active. A restore that copies an old `.env` back also brings back its
old file mode (re-apply `chmod 600 .env`).

## Known unresolved issues

- The Pi `src/` is stale (above); no safe on-device build.
- The wake word is stopped during every answer and needs about 2.7 s to come back.
- About a third of wake detections do not become a command (15 s capture cap, bare-wake path).
- Responses: median about 8 s from end of speech to first audio; slow when the offered tool list changes.
- MiniCPM uses a 4096-token slot although the Ollama drop-in sets 8192.
- TV ducking can leave the TV quieter when the restore could not run within 10 minutes.
- Recordings, chat history and the app log are never rotated or deleted.

## Engineering priorities

1. Reliable Capri activation.
2. Natural conversation.
3. Better cooperation between the existing components.
