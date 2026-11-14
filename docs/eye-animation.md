# Mechanical GLaDOS eye (status icon)

Replaces the small emoji in the response strip and adds the same icon to the right end of the microphone row's label
row (the name `GLADOS` moves left by the icon width). Nothing else in the layout changes. `WHISPLAY_UI_EYE=off` restores the
emoji path.

States: idle (quiet breath), listening (open iris, side segments pulse; follows the actual capture state of the
microphone pane), thinking/recognising/receiving (sweeping segments), speaking (follows the playback audio), error
(only for a tool outcome tagged `.failed` or `.unverified`: three flashes, steady red for 6 s, then idle).

## Speaking sync

`speechTimingFromWav` (already run once per sentence right after its playback starts) also returns `levels`: one hex digit
per 20 ms of that sentence's own WAV, absolute scale (-48 dBFS = 0, -12 dBFS = f). `StreamResponser` hands it to the
sentence-play event, `ChatFlow` sends it as `scroll_sync.env`, `chatbot-ui.py` keeps it in `speech_sync` and the terminal UI
reads it at the elapsed playback time with a 40 ms start-up allowance and 30 ms attack / 110 ms release smoothing.
No microphone, no second audio path, no LLM, no per-frame audio processing. Without an envelope (not a WAV, sentence over
40 s) the speaking eye stays steady; it never invents movement. The level is the audio stream's loudness, not the
ALSA/hardware volume setting.

## Cost

Frames are cached by quantised state (about 60 distinct images). Idle only changes on frames that are drawn anyway;
`WHISPLAY_UI_EYE_IDLE_FPS` (default 0) adds extra idle ticks, which would also trigger keyframe refreshes elsewhere, so keep it 0.
The LCD push now splits two distant small changes (for example the blinking cursor and the eye) into separate boxes when
that sends less than half the data.

Checks: `python3 python/dev/eye_demo.py --envs x --out x --check`, `src/test/eye-sync.spec.ts`, envelope tests in
`src/test/speech-sync.spec.ts`. Demo, sync plot and perf: `eye_demo.py --envs envs.json --out dir [--perf]`.
Physical verification (LCD legibility, real Piper level range, audio/eye alignment on the speaker) is still required.
