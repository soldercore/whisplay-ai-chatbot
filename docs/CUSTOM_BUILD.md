# Custom build integration: v2.1.9

This development branch starts at custom `tts-pipeline-fix` (`21177a05b8775ff880109fbd2b69fc8e89427083`) and integrates official chatbot v2.1.9 (`509b4462069a1166d59d3192b892b97a4818bac4`). See `../upstream-integration.json` for the published release and annotated tag identities. No production installation is represented by this branch.

Measured development results and remaining acceptance gates are in [VALIDATION.md](VALIDATION.md).

## Preserved feature contract

- Cyber terminal UI, bundled fonts/licences, rounded-corner safe area, partial LCD updates, camera/image paths and classic fallback.
- Piper root and `/synthesize` APIs, optional GLaDOS voice, checksum-pinned voice installation helper, PCM conversion, diagnostics, ordered TTS and audio-paced answer text.
- Default/GLaDOS persona selection, deterministic memory replies, local memory persistence/recovery/forgetting, secret filtering and turn-scoped memory/RAG context.
- Ollama NDJSON parsing, native tool history, context/resource limits, cancellation, duplicate handling, truthful post-tool failure, prompt/cache timing and load-only warmup.
- Exact offered-list validation, schema/result limits, finite tool contracts, read-only system health and existing reminder refusal.
- Per-user launcher lock, child ownership, compatible external service reuse, bounded cleanup, daemon-aware restart and startup data preservation.
- Online search/news as an optional feature, and Faster-Whisper's optional GLaDOS vocabulary hint. Persona comparison candidates remain evaluation-only.

The shell runner remains removed. Unmigrated `generateImage`, `describeImage`, music, skill and external tools remain blocked by the existing execution contract. This integration does not silently enable them.

## Integration adjustments

The audio import conflict keeps `spawnOwned` and custom diagnostics while adopting upstream's shared ALSA resolver, including `soundCardRef`. Wake-word stop now waits through the existing owned-child boundary, with Python/SoX in an owned process group on Linux. A later stop or application shutdown cancels a queued restart/wake event. Ambient sampling also registers its child with application lifecycle. Speech reveal and custom LLM cancellation are preserved.

All seven official app commits are included. This brings microphone release, VAD improvements, daemon autostart support, OpenAI Responses compatibility, configuration-menu fixes, image overlay fixes and upstream dependency maintenance. No cloud provider is enabled by this integration.

Registration failure now returns failure instead of reporting successful startup. The Hailo-Whisper client uses application cancellation without redundant process-exit handlers: it has never owned the external server. Missing Hailo SDK/model returns HTTP 503 from readiness and recognition, rather than a successful empty transcript.

## Data-preserving transfer

`scripts/deploy-aihat2.sh` defaults to code-only sync. It requires explicit `PI_HOST`, uses normal SSH host verification and never uses deleting rsync options. `scripts/deploy-sync.sh` excludes receiver-owned config/backups, data, knowledge, plugins, voices, container volumes, build/dependency directories and runtime markers/logs. `.env.template` is transferred. Files absent at the sender are retained at the receiver.

`--dry-run` performs only rsync preview. `--build` explicitly requests a locked Yarn install/build. `--provision` retains the legacy full-install path and can change drivers, OS configuration, services and models; it is not an incremental update procedure and has not been run. Existing `.env` is not overwritten. New provisioning uses the actual `LLM_SERVER` and `OLLAMA_ENDPOINT` names. The provisioning stack still needs physical review and version pinning before use.

Code-only sync does not remove obsolete code files; review removals explicitly when preparing an immutable release candidate. The ignored data paths are preserved, not backed up by this helper. Rollback, active-writer consistency and system/driver backup remain separate operational tasks.

## Local profiles (examples, not deployed settings)

For CPU-backed local operation select `ASR_SERVER=faster-whisper`, `LLM_SERVER=ollama`, `TTS_SERVER=piper-http` and the installed model using `OLLAMA_MODEL`. Set `ASSISTANT_PERSONA=glados` independently of `PIPER_HTTP_VOICE=glados`. Piper 1.8 uses `PIPER_HTTP_PATH=/synthesize`; older root-based servers keep the path unset. Verify ONNX/JSON files and the server data directory before selecting the voice.

For strict offline operation set `WEB_SEARCH_ENABLED=false` and select only local providers, with all models/assets/plugin dependencies preinstalled. Optional image/vision cloud backends can be left empty in that profile. Online functions remain in the code for a separate online profile. Never replace a working `.env` with this example wholesale.

For an externally managed Hailo stack, the intended overrides are `ASR_SERVER=hailowhisper`, the actual `HAILO_WHISPER_HOST/PORT` (usually loopback:8807), `OLLAMA_ENDPOINT` for the actual Hailo-Ollama service (often loopback:8000), and `SERVE_OLLAMA=false`. The launcher requires `/api/version`; native `/api/chat`, tool/NDJSON behavior, loaded context and simultaneous NPU resource use must be accepted on the installed stack. A missing `/api/ps` uses the existing conservative 4096 fallback; that is not evidence of the real NPU context. Faster-Whisper's initial prompt is not automatically supported by Hailo-Whisper.

## Reproducible validation

Use a disposable checkout with no production daemon, data, secrets or external plugins:

```sh
yarn --version                         # 1.22.22
yarn install --frozen-lockfile
yarn build
node node_modules/typescript/bin/tsc --noEmit --incremental false
npm test
npm run typecheck:tests
npm run test:python
npm run test:ui
yarn audit --groups dependencies --json
git diff --check
```

Node tests require real `curl`, `ffprobe` and `rsync`; audio playback uses the existing fake SoX. The test preloader isolates data in `.test-artifacts/` and disables external plugins. If intentionally installing with `--ignore-scripts` for review, apply `patch-package --error-on-fail` explicitly and run the ffprobe package's permission setup before audio tests. Do not use ignored native install scripts as evidence of a complete model runtime installation.

## Additional dependency-security maintenance

An audit of the official lock reported 45 production dependency-path findings (20 high, 20 moderate, 5 low). This integration refreshes only affected compatible series: Undici 7.30.1 and 6.29.1, Moment 2.31.0, follow-redirects 1.16.2, qs 6.17.1, brace-expansion 2.1.7, gRPC-JS 1.14.7 and adm-zip 0.6.1. Google GenAI remains at patched 1.25.0. Upstream UUID/XML resolutions and all provider functions remain present.

The resulting production audit has no high/critical/low findings and two moderate advisories in `@google-cloud/text-to-speech > google-gax > rimraf > glob > minimatch`: [glob cancellation](https://github.com/advisories/GHSA-3g3m-2fjr-6pw4) and [minimatch amplification](https://github.com/advisories/GHSA-g3hv-75wg-m249). Fix versions require different major dependency series; forcing them into this SDK tree without compatibility validation is deferred. The optional Google Cloud TTS provider is not enabled by the local/offline profile, but the dependencies remain installed. This is not an audit-clean or production-accepted security claim.

## Physical acceptance still required

Pi 5/16 GB and Hailo-10H are the intended hardware, not tested hardware in this environment. Before deployment, identify the installed source/build/daemon/OS/kernel and local changes. Then test actual codec/ALSA capture, 20 wake cycles, button/camera interruption, GLaDOS voice, Hailo model loading and concurrency, offline cold start, memory through full reboot, Home/focus/autostart, 50 launch/stop cycles, sustained thermals/latency/disk use and rollback on a separate system copy first.

The existing stale structured-memory-versus-freeform-update limitation and unverified full-Pi-reboot recall are not claimed fixed. ASR/TTS/RAG/other provider cancellation is not claimed to be application-wide hard real time. Companion custom driver/launcher integration is a separate branch based on official Whisplay v3.2.7.
