# Whisplay voice control revision 2 (development, not deployed)

Clear Home/exit/close/turn-off-GLaDOS requests use the existing zero-inference tool path. They request Home, never Pi power. The existing speech/memory handoff and daemon-owned process cleanup release the application before Home appears; four taps remain available.

The opt-in `WHISPLAY_VOICE_CONTROL_ENABLED` flag, model/context configuration, original persona, memory format, Whisper, Piper and push-to-talk are unchanged. Paired daemon revision 2 is additive to control API 1; an older daemon rejects unsupported actions. No privileged helper is installed.

- Immediate existing operations: volume/restore/mute, brightness, Wi-Fi/Bluetooth scans, permitted radio enabling. Brightness has a daemon-owned user ceiling so app redraws cannot reset it. Screen locking hands off after speech; waking uses the button.
- Actual reads: installed capabilities, apps, display/audio, individual radios/connections/discovered devices, fixed service status; system measurements reuse `getSystemHealth`.
- Cancel-first physical handoff: radio disabling, Wi-Fi connection changes, Bluetooth device actions, recording lock, fixed service start/restart and Pi power. Requests capture a unique discovered target. Credentials are entered only on the existing masked local Wi-Fi screen.
- Verified installed limitation: privileged helper absent, so Wi-Fi radio/profile/join, service mutations and reboot/shutdown remain unavailable. Bluetooth has a controller but actual authorization is checked by BlueZ; no successful power-on or pairing is inferred from discovery.
- Credential-bearing Wi-Fi input is withheld before transcript logging, display, memory and model dispatch. Invalid credential tool fields remain invalid and their values are withheld from tool logs/history. Password-topic questions receive the same local-entry guidance.

No new launcher, menus, listening mode, dependency, model, shell runner, sudo grant or memory format. Muted speakers cannot deliver an audible mute acknowledgement; display and button recovery remain. User brightness and mute-restore state are daemon-session state, not a new persisted configuration.

Deployment requires approval for the paired scoped changes, verified copies of current production source/compiled files and daemon files, a protected configuration/memory backup and a rehearsed file restore. Use the existing normal app/daemon lifecycle, not provisioning or branch replacement. Preserve external service processes. Compile staged TypeScript directly without the build registration hook. Roll back both file sets on stability/correctness failure; never restore stale memory over newer user data.

Acceptance after approval is limited to two physical checks: voice Home, then a reversible setting with actual readback and restoration. The previous deployed volume result was 2.326 seconds from button release to playback dispatch, not acoustic onset; this candidate has no new physical latency measurement.
