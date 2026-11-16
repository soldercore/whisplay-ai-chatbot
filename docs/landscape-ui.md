# Landscape UI (candidate)

`WHISPLAY_UI_LAYOUT=landscape` draws the terminal UI on a 280 x 240 canvas and turns it 90 degrees onto the 240 x 280 panel.
Unset (or `portrait`) nothing changes: every landscape file is only imported when the variable is set.

## Hardware and pipeline (verified)
- Panel 240 x 280 (`whisplay.py` `LCD_WIDTH/LCD_HEIGHT`), rounded corners (radius about 40 px, checked at 44). No orientation support in the
  driver or the Whisplay daemon; the daemon pushes whatever the app writes to the shared RGB565 framebuffer.
- The app composes a frame, diffs it against what the panel shows and sends only changed rectangles through `TerminalUI._send`. The landscape
  layout overrides only that method (`land_ui.LandscapeUI._send`): rectangle and pixels are rotated there (`WHISPLAY_UI_ROTATE=cw|ccw`).

## What changed
- `theme.py`: landscape block (canvas size, a cool graphite ramp, one accent, safe insets). Portrait values untouched.
- `land.py` (scenes), `land_ui.py` (coordinator, subclass of `TerminalUI`: reuses text, speech-sync, typewriter, decode effect, state tracker, push logic).
- `terminal_ui.py`: the LCD size check expects the physical size in landscape. `__init__.py`: factory picks `LandscapeUI`.
- `dev/land_shots.py`, `land_film.py`, `land_selftest.py`, `land_perf.py`; `preview_ui.py`: stub for a missing `cairosvg` on a development PC.

## Design
One object carries every state, the trace (77 columns): flat at rest, a live signal while listening (taller when audio is detected),
scanned and quantised while the speech is recognised, one travelling pulse while the model thinks, out and back during a tool call, driven by the
spoken words while speaking, broken at an error. The rail above it (LISTEN, DECODE, THINK, SPEAK) shows the stage; one bar slides to the active one.
Home: the time, date, the resting trace, the next action. Answers keep the existing text effects; what you said stays quoted under the answer.

## Not covered
- Camera preview and generated images are drawn portrait by `chatbot-ui.py` (physical coordinates); turn the device back for them.
- The Whisplay daemon's launcher menus (separate repository) stay portrait.

## Checks
`python3 python/dev/land_selftest.py` (every state, rounded-corner safety, panel == canvas for both rotations, long/CJK/unbroken text, idle schedules no frames),
`python3 python/dev/preview_ui.py --selftest` (portrait, unchanged; its threaded "listening animates" check is timing-sensitive), `land_perf.py` for CPU.

## Rollback
Remove `WHISPLAY_UI_LAYOUT` from `.env` and restart the app (or restore the deploy stage's backup). No data or other setting is involved.
