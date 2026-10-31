# Integration validation — 2026-10-31

Development branch: `integrate/chatbot-v2.1.9`. Baseline and official tag identities are in `../upstream-integration.json`. Results describe an x86_64 development environment, not the installed Raspberry Pi.

| Check | Result |
|---|---|
| Frozen install, Yarn 1.22.22 | Passed with committed lock; dependency scripts deliberately disabled in this analysis environment |
| Explicit `patch-package --error-on-fail` and build prebuild | Google GenAI 1.25.0 patch applied successfully |
| `yarn build` | Passed; daemon socket absent, so registration skipped |
| `npm run typecheck` | Passed |
| `npm run typecheck:tests` | Passed, including all 27 spec files and production sources |
| `npm test` | **492 passed, 0 failed, 0 skipped** |
| `npm run test:python` | **15 passed**: 7 Faster-Whisper, 4 Hailo-Whisper, 4 wake-host contracts |
| Chatbot fake-LCD self-test | **54 checks passed** |
| Static checks | 28 shell, 39 Python, 9 JS/CJS files passed syntax checks |
| Production dependency audit | 0 critical/high/low, **2 moderate remaining** |
| Full dependency audit, including development tree | Same two moderate findings; audit exits nonzero as expected |
| Source preservation | Protected UI/fonts, persona/memory/tools, Ollama modules, speech reveal, launcher, startup-data and ownership modules unchanged from custom reference |
| Historical Git refs | Checked unchanged; original reference worktree clean |

The Node ASR suite itself runs the seven Faster-Whisper Python tests; do not add these counts together as if every execution were a distinct test case. Real rsync is used by five deployment tests, including receiver-state preservation, symlinks, dry-run, explicit targeting and multiline remote build arguments. Other model/hardware/network edges use fake APIs, recorders and boards. No genuine ASR/TTS/LLM model is installed or evaluated here.

Environment: Node 24.19.0, Python 3.12, Yarn 1.22.22; UI tests use Pillow 13.0.0 and CairoSVG 2.9.1 from isolated `/tmp` dependencies. Real curl/ffprobe and an extracted test-only Debian rsync 3.2.7 binary are used. The ffprobe package's executable permission was set explicitly because its install script was disabled. This does not establish ARM64/native model-library installation.

Initial baseline audio tests failed because ffprobe lacked executable permission; all 21 audio tests passed after correcting the test dependency. During integration, explicit lifecycle dependencies were added to existing VM fixtures without weakening assertions. The final complete suite passes. Historical phase-document counts are not substituted for these results.

The two moderate advisories and deferred major upgrades are described in `CUSTOM_BUILD.md`. The library/runtime security scan is not clean; passing tool-authorization tests does not remove dependency advisories.

## Remaining acceptance work

- Verify installed app source, `dist`, local modifications, daemon, OS/kernel, codec, plugins and model/voice files without changing production.
- Build/test ARM64 native dependencies and the paired driver against the actual Pi kernel.
- Exercise actual Hailo-Whisper/LLM inference and NPU resource sharing; Hailo API/version/context compatibility remains unverified.
- Verify real microphone/chime/VAD timing, 20 wake cycles, GLaDOS timbre/data directory and speech/display alignment.
- Verify memory persistence through full Pi reboot and the existing structured-fact/freeform-update limitation; no data migration or historical record repair was performed.
- Verify offline cold start, Home/focus/autostart, external backend ownership, 50 start/stop cycles, sustained load/thermal/disk behavior and rollback on a separate system copy.

No Pi connection, installation, service restart, model pull, main-branch merge or release publication occurred. Branches are delivered locally with portable Git bundles because GitHub authentication in this environment failed.
