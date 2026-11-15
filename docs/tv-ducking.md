# TV audio ducking (`TV_DUCKING`)

Status: candidate `candidate/tv-ducking`, **not deployed, not physically verified**. Default off.

## Behaviour

* Capri hears the wake word and starts the command capture (`CAPRI_LISTENING`, ChatFlow still in `sleep`): `TvDucker.begin()` runs in the background and is never awaited, so the microphone and the capture do not wait for the TV.
* One connection to the LG C1 reads `audio/getStatus` (volume, mute, output), decides, sends ONE `audio/setVolume` (one webOS overlay) to the target and verifies by reading back. A typical operation takes 150-300 ms (measured in production logs for the same calls).
* Target = `TV_DUCK_PERCENT` (default 40, clamped 10-90) of the current volume, at least 3. Volume 20 becomes 8. A TV at 6 or below, or where ducking would change less than 3 steps, is left alone.
* A muted TV is never touched. A TV in standby refuses the connection, and only audio calls are ever sent, so nothing can switch it on.
* Follow-ups (clarification, question) go `answer -> wake_listening`, never through `sleep`, so the TV stays lowered. Every end of a conversation (silence, goodbye, ASR failure, failed answer, interruption, a wake word without a command) returns to `sleep`, and `transitionTo("sleep")` calls `end()`.
* Restore reads the TV first and sets the original volume only if volume equals the value GLaDOS set, the output is unchanged and the TV is not muted. A volume the user changed, a mute, or another output is left alone. A TV that cannot be reached is not reported as restored.
* A safety timer (`TV_DUCK_IDLE_SECONDS`, default 120, 15-600) restores a conversation that somehow never reaches idle; every flow transition postpones it.

## State and recovery

`data/.glados-tv/duck-state.json` (mode 600, same private directory as the TV credentials) holds `{before, ducked, output, at}`. It is written before the first volume command and removed after a restore or when it is obsolete. It is used only if it is younger than 10 minutes. On start (`recover()`) it is applied only when the TV still shows exactly the ducked volume on the same output. A failed restore keeps the file; the next conversation then adopts the original volume instead of ducking again (no 8 -> 3 stacking). After an unreachable TV there is no new probe for 30 s.

Shutdown makes a best-effort restore through `onAppShutdown`; if the process exits first, the state file makes the next start finish it. The application lifecycle was not changed.

## Configuration and rollback

`TV_DUCKING=1` enables it (unset, empty or 0 = off); restart the application to change it. `TV_DUCK_PERCENT`, `TV_DUCK_IDLE_SECONDS` are optional. Rollback is the standard file-by-file restore of the deployed files, or setting `TV_DUCKING=0` and restarting; a leftover state file expires on its own after 10 minutes.

## Known limits

* webOS shows its volume overlay during each change. This cannot be suppressed through the audio API.
* Verified in logs: the volume/mute calls work and verify on the user's C1. Not verified: that volume changes affect the user's actual speaker path (for ARC/optical the read-back check fails and ducking does nothing).
* The wake-word-only path ("Capri" followed by silence) is ducked briefly and restored when Capri goes idle.

* The TV API has no atomic compare-and-set. Each operation reads the TV and sends its command on the same connection, so a manual change can only be overwritten if it lands within that single round trip (a few milliseconds).

## Tests

`tv-ducking.spec.ts` (unit, fake TV, including source mutations that must be caught) and `tv-ducking-flow.spec.ts` (real state handlers and real Capri listener lifecycle).

## Rollback without abandoning a ducked volume
Startup recovery runs even with `TV_DUCKING=0`, so the safe order is: set `TV_DUCKING=0`, restart the application (a fresh duck-state.json is applied if the TV still shows the ducked volume), then restore files. The deploy script `restore` mode does exactly this first.
