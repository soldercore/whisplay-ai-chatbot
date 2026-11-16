#!/usr/bin/env python3
"""Landscape previews at the native 280 x 240 from the production renderer (fake LCD, deterministic clock).
Every frame passes through LandscapeUI._send, i.e. the real 90 degree rotation, and is rotated back for viewing.
  python3 python/dev/land_shots.py [--out DIR] [--accent lime|ice|vermilion|ultra] [--rotate cw|ccw] [--scale 3] [--no-bezel] [--only a,b]"""
import argparse
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
try:  # a development PC without the Cairo library: emoji SVGs are then unavailable
    import cairosvg  # noqa: F401
except Exception:
    import types
    _stub = types.ModuleType("cairosvg")

    def _no_svg(*a, **k):
        raise RuntimeError("cairosvg is not installed")
    _stub.svg2png = _no_svg
    sys.modules["cairosvg"] = _stub
import preview_ui as pv  # noqa: E402
from PIL import Image, ImageDraw  # noqa: E402

parser = argparse.ArgumentParser()
parser.add_argument("--out", default=os.path.join(os.path.dirname(HERE), "..", "land-shots"))
parser.add_argument("--accent", default="lime")
parser.add_argument("--rotate", default="cw")
parser.add_argument("--scale", type=int, default=3)
parser.add_argument("--no-bezel", action="store_true")
parser.add_argument("--only", default="")
args = parser.parse_args()
out = os.path.abspath(args.out)
os.makedirs(out, exist_ok=True)
ANSWER = ("Tomorrow in Tokyo: light rain in the morning, clearing by the afternoon. High 21 degrees, low 15, with a sixty percent "
          "chance of showers before noon. Yes, take a compact umbrella.")
LONG = ANSWER + " " + ANSWER
shots = []


def bezel(image):
    """Rounded panel corners (radius about 40 px): what the eye actually sees."""
    mask = Image.new("L", (image.width * 4, image.height * 4), 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, mask.width - 1, mask.height - 1), radius=40 * 4, fill=255)
    mask = mask.resize(image.size, Image.LANCZOS)
    base = Image.new("RGB", image.size, (22, 22, 24))
    base.paste(image, (0, 0), mask)
    return base


def logical(s):
    img = s.lcd.image()
    img = img.rotate(90, expand=True) if args.rotate == "cw" else img.rotate(-90, expand=True)
    return img


def snap(s, name):
    img = logical(s)
    assert img.size == (280, 240), img.size
    shots.append((name, img))
    shown = img if args.no_bezel else bezel(img)
    shown.save(os.path.join(out, name + "_1x.png"))
    shown.resize((280 * args.scale, 240 * args.scale), Image.NEAREST).save(os.path.join(out, name + ".png"))


env = {"WHISPLAY_UI_LAYOUT": "landscape", "WHISPLAY_UI_ACCENT": args.accent, "WHISPLAY_UI_ROTATE": args.rotate}
want = set(x for x in args.only.split(",") if x)


def on(name):
    return not want or name in want


s = pv.Session(env=env)
try:
    s.send(status="starting", emoji="😐", text="Waiting for message..."); s.run_until(s.now + 0.8); snap(s, "00_boot") if on("00_boot") else None
    s.send(status="idle|capri", emoji="😴", text=""); s.run_until(s.now + 1.0); snap(s, "01_home") if on("01_home") else None
    s.send(status="idle|capri,heard", emoji="😴", text=""); s.run_until(s.now + 0.4); snap(s, "02_wake_heard") if on("02_wake_heard") else None
    s.send(status="detecting", emoji="😐", text=""); s.run_until(s.now + 1.0); snap(s, "03_calibrating") if on("03_calibrating") else None
    s.send(status="listening|capri", emoji="😐", text="Listening..."); s.run_until(s.now + 1.2); snap(s, "04_listening") if on("04_listening") else None
    s.send(status="listening|capri,audio", emoji="😐", text="Listening..."); s.run_until(s.now + 0.8); snap(s, "05_listening_audio") if on("05_listening_audio") else None
    s.send(status="recognizing", emoji="😐", text="what's the weather in Tokyo"); s.run_until(s.now + 0.7); snap(s, "06_recognizing") if on("06_recognizing") else None
    s.send(status="answering...|said", emoji="😐", text="what's the weather in Tokyo tomorrow and should I take an umbrella"); s.run_until(s.now + 1.2); snap(s, "07_thinking") if on("07_thinking") else None
    s.send(status="tool calling", emoji="😐", text="[webSearch] Tokyo weather tomorrow", tool_placeholders={"t1": "% webSearch..."}); s.run_until(s.now + 1.1); snap(s, "08_tool") if on("08_tool") else None
    s.send(status="answering", emoji="🌧", scroll_speed=3, transaction_id=2, text=""); s.run_until(s.now + 0.3)
    shown = 0
    while shown < 60:
        shown = min(len(ANSWER), shown + 7)
        s.send(status="answering", text=ANSWER[:shown], scroll_speed=3, transaction_id=2); s.run_until(s.now + 0.08)
    snap(s, "09_writing") if on("09_writing") else None
    while shown < len(ANSWER):
        shown = min(len(ANSWER), shown + 7)
        s.send(status="answering", text=ANSWER[:shown], scroll_speed=3, transaction_id=2); s.run_until(s.now + 0.08)
    s.run_until(s.now + 0.5)
    s.send(scroll_sync={"char_end": 90, "duration_ms": 3600}); s.run_until(s.now + 1.3); snap(s, "10_speaking") if on("10_speaking") else None
    s.run_until(s.now + 6.0)
    s.send(status="idle|capri,resp:4.5"); s.run_until(s.now + 1.0); snap(s, "11_response") if on("11_response") else None
    s.send(status="idle|capri,resp:4.5,heard"); s.run_until(s.now + 0.4); snap(s, "12_response_wake") if on("12_response_wake") else None
    s.send(status="error", emoji="😐", text="Offline: cannot reach the language model", terminal_text=""); s.run_until(s.now + 1.0); snap(s, "13_error") if on("13_error") else None
    s.send(status="Confirm", emoji="😐", text="[shell] Run command rm -rf ~/.cache/whisplay/tmp", approval_mode=True); s.run_until(s.now + 0.6); snap(s, "14_approval") if on("14_approval") else None
    s.send(status="Allowed", emoji="😐", text="Operation allowed.", approval_mode=False); s.run_until(s.now + 0.6); snap(s, "15_allowed") if on("15_allowed") else None
    s.send(status="music", emoji="🎵", text="Now playing: Lo-fi beats to code to", music_progress=0.42, music_duration_ms=215000); s.run_until(s.now + 1.0); snap(s, "16_music") if on("16_music") else None
    s.send(status="answering", text="Listing your home folder:", terminal_text="$ ls -la\ntotal 24\ndrwxr-xr-x 5 pi pi 4096 .\n-rw-r--r-- 1 pi pi 220 .bashrc\ndrwxr-xr-x 2 pi pi 4096 whisplay-ai-chatbot",
           music_progress=None, music_duration_ms=None); s.run_until(s.now + 0.8); snap(s, "17_terminal") if on("17_terminal") else None
    s.send(status="answering", text=LONG, terminal_text="", scroll_speed=3, transaction_id=9); s.run_until(s.now + 2.5); snap(s, "18_long_answer") if on("18_long_answer") else None
    s.send(status="idle|capri", text=""); s.run_until(s.now + 1.0)
finally:
    s.close()

cols = 3
rows = (len(shots) + cols - 1) // cols
cell_w, cell_h = 280 + 10, 240 + 10
sheet = Image.new("RGB", (cols * cell_w + 10, rows * cell_h + 10), (40, 40, 44))
for i, (name, img) in enumerate(shots):
    shown = img if args.no_bezel else bezel(img)
    sheet.paste(shown, (10 + (i % cols) * cell_w, 10 + (i // cols) * cell_h))
sheet = sheet.resize((sheet.width * 2, sheet.height * 2), Image.NEAREST)
sheet.save(os.path.join(out, "sheet.png"))
print("wrote", len(shots), "states to", out)
