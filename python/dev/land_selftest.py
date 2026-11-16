#!/usr/bin/env python3
"""Checks of the landscape layout on the production renderer (fake LCD, manual clock):
every state renders; nothing is drawn outside the rounded panel corners (radius 40); the rotated panel equals the
renderer's own canvas (both rotations); long, CJK and unbroken text stays inside; an idle screen schedules no frames;
render cost per state. Exit status 1 on any failure.   python3 python/dev/land_selftest.py"""
import os
import statistics
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
try:
    import cairosvg  # noqa: F401
except Exception:
    import types
    _stub = types.ModuleType("cairosvg")

    def _no_svg(*a, **k):
        raise RuntimeError("cairosvg is not installed")
    _stub.svg2png = _no_svg
    sys.modules["cairosvg"] = _stub
import numpy as np  # noqa: E402
import preview_ui as pv  # noqa: E402
from PIL import Image, ImageDraw  # noqa: E402

failures = []
checks = 0


def check(ok, what):
    global checks
    checks += 1
    if not ok:
        failures.append(what)
        print("FAIL", what)


def corner_mask():
    m = Image.new("L", (280 * 4, 240 * 4), 0)
    ImageDraw.Draw(m).rounded_rectangle((0, 0, 280 * 4 - 1, 240 * 4 - 1), radius=44 * 4, fill=255)   # the 44 px check radius
    return np.asarray(m.resize((280, 240), Image.LANCZOS)) > 0


INSIDE = corner_mask()


def logical(s, rotate):
    img = s.lcd.image()
    return np.asarray(img.rotate(90, expand=True) if rotate == "cw" else img.rotate(-90, expand=True))


LONG = ("The quick brown fox jumps over the lazy dog while the committee deliberates about nothing in particular and the "
        "weather forecast remains stubbornly unchanged for the entire week ahead. ") * 3
CASES = [
    ("boot", dict(status="starting", text="Waiting for message...")),
    ("home", dict(status="idle|capri", text="")),
    ("home-heard", dict(status="idle|capri,heard", text="")),
    ("calibrate", dict(status="detecting", text="")),
    ("listen", dict(status="listening|capri", text="Listening...")),
    ("listen-audio", dict(status="listening|capri,audio", text="Listening...")),
    ("listen-hold", dict(status="listening", text="Listening...")),
    ("recognize", dict(status="recognizing", text="turn off the tv screen")),
    ("think", dict(status="answering...|said", text="what's the weather in Tokyo tomorrow and should I take an umbrella with me")),
    ("think-long", dict(status="answering...|said", text=("word " * 80).strip())),
    ("tool", dict(status="tool calling", text="[webSearch] Tokyo weather tomorrow")),
    ("answer", dict(status="answering", text=LONG, scroll_speed=3, transaction_id=5)),
    ("answer-cjk", dict(status="answering", text="今天天气很好，我们去公园散步吧。" * 6, scroll_speed=3, transaction_id=6)),
    ("answer-unbroken", dict(status="answering", text="A" * 200, scroll_speed=3, transaction_id=7)),
    ("error", dict(status="error", text="Offline: cannot reach the language model")),
    ("approval", dict(status="Confirm", text="[shell] Run command rm -rf ~/.cache/whisplay/tmp", approval_mode=True)),
    ("allowed", dict(status="Allowed", text="Operation allowed.", approval_mode=False)),
    ("music", dict(status="music", text="Now playing: Lo-fi beats", music_progress=0.4, music_duration_ms=215000)),
    ("terminal", dict(status="answering", text="Listing your home folder:", music_progress=None, music_duration_ms=None,
                      terminal_text="$ ls -la\ntotal 24\n" + "drwxr-xr-x 5 pi pi 4096 a-very-long-file-name-that-does-not-fit-on-one-line\n" * 3)),
    ("response", dict(status="idle|capri,resp:4.5", text="", terminal_text="")),
]

for rotate in ("cw", "ccw"):
    s = pv.Session(env={"WHISPLAY_UI_LAYOUT": "landscape", "WHISPLAY_UI_ROTATE": rotate})
    try:
        ui = s.rt.terminal_ui
        check(ui is not None and type(ui).__name__ == "LandscapeUI", f"{rotate}: LandscapeUI active")
        costs = {}
        for name, kw in CASES:
            kw = dict(kw)
            kw.setdefault("emoji", "😐")
            try:
                s.send(**kw)
                times = []
                for _ in range(40):
                    t0 = time.perf_counter()
                    s.run_until(s.now + 0.05)
                    times.append((time.perf_counter() - t0) * 1000)
                if name == "response":
                    pass
            except Exception as error:     # the renderer falls back to classic on failure; that is a failure here
                check(False, f"{rotate}/{name}: exception {error!r}")
                continue
            check(s.rt.terminal_ui is not None, f"{rotate}/{name}: terminal UI still active")
            frame = logical(s, rotate)
            canvas = np.asarray(s.rt.terminal_ui.frame).astype(np.uint16)
            r, g, b = canvas[..., 0] >> 3, canvas[..., 1] >> 2, canvas[..., 2] >> 3      # the panel holds RGB565
            canvas = np.dstack(((r << 3) | (r >> 2), (g << 2) | (g >> 4), (b << 3) | (b >> 2))).astype(np.uint8)
            check(frame.shape == (240, 280, 3), f"{rotate}/{name}: logical size {frame.shape}")
            check(np.array_equal(frame, canvas), f"{rotate}/{name}: panel equals canvas ({int((frame != canvas).any(axis=2).sum())} px differ)")
            outside = frame.any(axis=2) & ~INSIDE
            check(not outside.any(), f"{rotate}/{name}: {int(outside.sum())} px drawn outside the rounded corners, first {np.argwhere(outside)[:3].tolist()}")
            check(frame.any(), f"{rotate}/{name}: blank screen")
            costs[name] = statistics.median(times)
        # the idle screen schedules no frames once settled
        s.send(status="idle|capri", text="", terminal_text="", approval_mode=False)
        s.run_until(s.now + 3.0)
        before = s.frames
        s.run_until(s.now + 20.0)
        check(s.frames - before <= 2, f"{rotate}: idle drew {s.frames - before} frames in 20 s")
        print(rotate, "median wall ms per 50 ms step (includes harness):", {k: round(v, 1) for k, v in costs.items()})
    finally:
        s.close()

print(f"{checks} checks, {len(failures)} failed")
sys.exit(1 if failures else 0)
