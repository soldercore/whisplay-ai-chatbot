# Whisplay conversational control — isolated candidate, 2026-11-02

This is an opt-in integration, not a production deployment. Original personality A, Qwen, ASR/TTS, push-to-talk and persistent memory remain the production configuration. Both repositories use the isolated branch `codex/whisplay-voice-control`; chatbot base is `3157bed`, daemon base is the approved Control Center `6008414`. No additional menu is introduced.

## One execution boundary

`whisplay` is registered centrally only with `WHISPLAY_VOICE_CONTROL_ENABLED=true`. It calls `control.read/execute/present/cancel` on the existing local daemon socket. This replaces the old three volume tools while enabled. CPU/RAM/temperature/storage use the existing `getSystemHealth` collector. Existing offered-list, schema, execution-contract and cancellation checks still authorize every call; no shell runner is added. No dependency or lockfile changes.

The daemon reads capabilities from its registered apps, installed binaries, detected mixer/controller and availability of the fixed root-owned privilege helper. It calls the existing Control Center operations; it does not duplicate mixer curves, radio/service commands, confirmation UI or metric collectors. The socket read path requires the daemon UID. Mutations additionally require the tracked, running, foreground GLaDOS process group. This is application authorization, not isolation from compromised code running as the same Linux user.

Supported candidate operations: installed capabilities; apps/display/audio/network/services status; brightness 20–100%; volume 0–100%; relative changes up to 20 percentage points; Home; screen lock; GLaDOS-only recording lock; radio enable/disable; start/restart of SSH/Ollama/Whisper/Piper; reboot/shutdown. Unknown actions, extra fields, invalid types and arbitrary paths/units are rejected. Service stop, daemon restart, Wi-Fi credentials/profile changes, Bluetooth pairing and arbitrary commands are not exposed by this bridge.

Broad capability questions require a fresh capability read. For device questions, Qwen chooses a validated function call using Ollama's JSON-schema output constraint and the existing JSON tool-call parser. The broad topic gate does not map phrases to actions. Measurements-only intent narrows the offered decoder to the health tool. An unsupported/unexecuted proposal cannot stream a success claim to TTS: there is at most one retry, then an explicit unverified result. Known tool results are rendered as short operating facts, preserving supplied labels/units and pending/completed status. The character prompt is unchanged; device instructions are separate and opt-in. Normal conversation retains the existing path when disabled.

Ollama documents the JSON-schema `format` API in its [structured output documentation](https://docs.ollama.com/capabilities/structured-outputs). The installed Qwen demonstrations below verify its use here, rather than assuming that ordinary tool descriptions guarantee calls.

## Speech, recovery and data preservation

Brightness/volume return an actual mixer readback or explicitly last-commanded brightness. Home/screen lock and risky operations first return a bounded ticket: nothing has changed. The host waits for LLM completion, TTS playback completion and queued conversation saving before requesting handoff. It uses the existing local summary path during handoff, avoiding another model summary that could delay process exit. A failed/unconfirmed save cancels handoff. The memory storage format and subject-matching fix are unchanged.

The daemon then uses its existing owned-process cleanup. Only after GLaDOS has exited and its process group is cleaned up does it show the existing Cancel-first, 30-second physical confirmation. Home/screen lock need speech handoff but no risky-action dialog. Tickets expire after 120 seconds; restart, interruption, cancellation and intervening physical navigation prevent stale focus changes. Tickets cannot target a later GLaDOS process. Recording lock is reversible in Audio and does not mute other programs. The four-tap Home gesture and button wake path remain unchanged. No microphone capture or wake-word process is added.

## Actual installed-model demonstrations

Raw evidence is in [interactions.json](evaluation/whisplay-voice-2026-11-02/interactions.json) and [rpc.jsonl](evaluation/whisplay-voice-2026-11-02/rpc.jsonl). These were real text requests through the candidate provider using the Pi's installed `qwen3.5:2b-q4_K_M`, thinking disabled, effective context 4096. Model-returned calls were executed, not mocked. The reversible setting changed the physical speaker mixer.

| Natural request | Actual model-selected call | Actual result |
| --- | --- | --- |
| Describe Whisplay's available controls. | `whisplay({action:"capabilities"})` | Actual discovery; temporary test connection honestly exposed volume control and existing read scopes, marking other controls unavailable. |
| Tell me how hot you are, how much RAM is free and how much room is left on storage. | `getSystemHealth({})` | CPU 2.5%; 56.75 °C; RAM available 11.513 GiB; storage available 47.027 GiB. Supplied units/labels preserved. |
| Please make your speaker a little quieter. | `whisplay({action:"volume",change:-10})` | Mixer 80 → 70%, verified readback; finally restored to 80%. |

These are **not deployed ASR→speech/physical-confirmation acceptance results**. A temporary, same-user, volume-only test API reused the candidate dispatcher and existing live Linux backends. It held the existing application kernel lock with production at Home, used isolated memory/history, did not own the LCD, and permitted no connectivity/power changes. Its explicit test authorization override is not used by the production dispatcher. No production code, configuration or saved memory was changed. Each interaction took about 13–14 seconds; this is limited text-test timing, not a general performance or voice-latency benchmark.

Earlier attempts are retained on the Pi (`whisplay-voice-uopr0mxe`, `whisplay-voice-v2-gwgxjd52`, `whisplay-voice-v3-j6zmjome`, `whisplay-voice-v4-x4pjo64_`). They exposed skipped calls, fabricated metrics/success and one wrong health/capabilities selection. They are failures, not acceptance evidence. They motivated constrained decoding, grounding and factual result rendering; three final successes do not prove every paraphrase or ambiguous multi-action request works.

## Verification and remaining limits

On the Pi: complete chatbot suite **525/525**, daemon suite **93/93**, example suite **8/8**. Source and test TypeScript checks pass. Added coverage verifies invalid input/auth rejection, correct foreground peer authorization, busy mixer refusal, no action before physical confirmation, Cancel/Confirm, expiration/replay, stale process tickets, capability probe timeout, result label accuracy, unexecuted success suppression, interrupted handoff and speech/memory ordering. Full tests used LF-preserving Git archives; initial Windows CRLF packaging failures are not reported as product failures or passes.

The installed fixed privilege helper/sudoers are absent. Wi-Fi changes, privileged service operations, reboot and shutdown must therefore be reported unavailable. They were neither enabled nor executed. Bluetooth controller presence is discovered; authorization/hardware failures remain possible and are reported by the existing operation. Network/service states are not internet, SSH remote-reachability or backend-readiness tests. No automatic diagnosis or repair is claimed.

The candidate is ready for review and a separately approved paired deployment test. Remaining essential hardware acceptance: one spoken read, one reversible spoken volume/brightness request, and Home→existing physical Cancel/Confirm→button recovery with the real tracked application. Do not repeat all menu tests or execute power/connectivity actions merely to test dialogs. Post-deployment inference/ASR/TTS performance and real peer process-group matching have not been measured for this candidate.

## Reversible deployment proposal — approval required

Deploy only the paired changed source files after preserving current daemon/chatbot files, compiled outputs, registrations and `.env`, with verified checksums. Production chatbot HEAD is `de8a196` plus the already approved memory fix; candidate base `3157bed` contains that same fix. Do not replace production history/data or switch to persona experiments. Compile in isolated staging with the pinned existing dependencies and direct `tsc`; the normal build hook can register apps and must not run against the live socket. Keep the feature off until both components are installed and health/capability compatibility is checked. Do not install the optional privilege helper as part of this proposal.

After approval, use the normal daemon/app manager and the minimal hardware checks above. On failure, turn the feature off, restore only the backed-up code/compiled files/configuration changes for this integration and restart through the normal manager. Never roll memory back to an older snapshot. Verify original A/model/voice, app flags, PTT and service health. No deployment or service restart was performed during development.
