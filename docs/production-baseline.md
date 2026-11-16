# Production baseline (Pi 5), 2026-11-16

This branch (`production/pi5-baseline`) is the source of what runs on the production
Raspberry Pi 5 on 2026-11-16. It was verified by hash against the files on the device;
it is not a description of intent. The companion branch with the same name in the
Whisplay driver repository holds the driver/launcher baseline.

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

## How this branch was assembled

- Base: `67fb326` (landscape UI; contains every deployed candidate up to it).
- Cherry-picked: `5267ee0` and `3481219` (search decision); their compiled
  `config/web-search-router.js` and `utils/index.js` are deployed.
- Added the deployed bytes of both `faster-whisper-host.py` copies (listen on 127.0.0.1).
- Manifests in `scripts/predeploy/` regenerated from the Pi.

## Reproducibility (verified 2026-11-16)

Isolated clone, `yarn install --frozen-lockfile` (Yarn 1.22.22), `yarn build`:

- `dist/`: 153 of 154 files byte-identical to the Pi. `dist/config/web-search.js` has the
  same tokens but different line wrapping (it was hand-spliced in production).
- `python/`, `scripts/`, `docker/`, `bin/`, `cli/`, `web/`, `run_chatbot.sh`: identical,
  except `python/dev/preview_ui.py` (a development tool; the Pi has an older copy).
- `package.json` differs only in the test file list (the Pi has an older one).
- Not in git by design: `.env*`, `data/`, logs, TV pairing data, `node_modules`, `dist`,
  downloaded assets (`python/emoji_svg*`, `python/NotoSansSC-Bold.ttf`), the wake-word
  model and its venv.

Check any future build with `node scripts/predeploy/check.cjs` (see `scripts/predeploy/README.md`).

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
