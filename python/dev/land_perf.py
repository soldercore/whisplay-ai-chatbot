#!/usr/bin/env python3
"""CPU cost of the renderer per state on this machine: frames the UI asks for per second and process CPU per frame, from
the manual clock (no sleeping). Run it for the layout you want to measure:  WHISPLAY_UI_LAYOUT=landscape python3 land_perf.py"""
import os
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
try:
    import cairosvg  # noqa: F401
except Exception:
    import types
    _stub = types.ModuleType("cairosvg")
    _stub.svg2png = lambda *a, **k: (_ for _ in ()).throw(RuntimeError("cairosvg is not installed"))
    sys.modules["cairosvg"] = _stub
import preview_ui as pv  # noqa: E402

ANSWER = ("Tomorrow in Tokyo: light rain in the morning, clearing by the afternoon. High 21 degrees, low 15, with a sixty percent "
          "chance of showers before noon. Yes, take a compact umbrella. " * 2)
CASES = [("idle", dict(status="idle|capri", text="")), ("listening", dict(status="listening|capri,audio", text="Listening...")),
         ("recognizing", dict(status="recognizing", text="what is the weather in tokyo")),
         ("thinking", dict(status="answering...|said", text="what is the weather in tokyo")),
         ("tool", dict(status="tool calling", text="[webSearch] Tokyo weather")),
         ("answer streaming", dict(status="answering", text=ANSWER, scroll_speed=3, transaction_id=4)),
         ("music", dict(status="music", text="Now playing", music_progress=0.4, music_duration_ms=215000))]
s = pv.Session(env={k: v for k, v in os.environ.items() if k.startswith("WHISPLAY_UI")})
print("layout", os.environ.get("WHISPLAY_UI_LAYOUT", "portrait"))
try:
    for name, kw in CASES:
        s.send(emoji="😐", **kw)
        s.run_until(s.now + 1.5)                       # settle
        frames0, cpu0, t0 = s.frames, time.process_time(), s.now
        s.run_until(s.now + 8.0)
        frames, cpu = s.frames - frames0, time.process_time() - cpu0
        fps = frames / 8.0
        per = 1000.0 * cpu / max(1, frames)
        print(f"{name:18} {fps:5.1f} frames/s  {per:6.2f} ms CPU/frame  = {100 * fps * per / 1000.0:5.2f}% of one core")
finally:
    s.close()
