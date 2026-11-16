#!/usr/bin/env python3
"""All states of the preview scenario (the same 36 the portrait preview shows) in the landscape layout, as exact 280 x 240 frames.
  python3 python/dev/land_states.py [--out DIR] [--rotate cw|ccw] [--scale 3]"""
import argparse
import os
import sys

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
from PIL import Image, ImageDraw, ImageFont  # noqa: E402

parser = argparse.ArgumentParser()
parser.add_argument("--out", default=os.path.join(os.path.dirname(HERE), "..", "land-states"))
parser.add_argument("--rotate", default="cw")
parser.add_argument("--scale", type=int, default=3)
args = parser.parse_args()
os.makedirs(args.out, exist_ok=True)


def bezel(image):
    mask = Image.new("L", (image.width * 4, image.height * 4), 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, mask.width - 1, mask.height - 1), radius=160, fill=255)
    base = Image.new("RGB", image.size, (22, 22, 24))
    base.paste(image, (0, 0), mask.resize(image.size, Image.LANCZOS))
    return base


s = pv.Session(env={"WHISPLAY_UI_LAYOUT": "landscape", "WHISPLAY_UI_ROTATE": args.rotate})
shots = []
try:
    assert type(s.rt.terminal_ui).__name__ == "LandscapeUI"

    def shot(name):
        img = s.lcd.image()
        img = img.rotate(90, expand=True) if args.rotate == "cw" else img.rotate(-90, expand=True)
        shots.append((name, img))
    s.shot = shot
    pv.scenario(s)
finally:
    s.close()
font = ImageFont.load_default()
cols = 4
w, h, pad, lab = 280, 240, 10, 14
rows = (len(shots) + cols - 1) // cols
sheet = Image.new("RGB", (pad + cols * (w + pad), pad + rows * (h + lab + pad)), (40, 40, 44))
d = ImageDraw.Draw(sheet)
for i, (name, img) in enumerate(shots):
    x, y = pad + (i % cols) * (w + pad), pad + (i // cols) * (h + lab + pad)
    d.text((x, y), name, fill=(200, 200, 200), font=font)
    sheet.paste(bezel(img), (x, y + lab))
    bezel(img).resize((w * args.scale, h * args.scale), Image.NEAREST).save(os.path.join(args.out, name + ".png"))
sheet.resize((sheet.width * 2, sheet.height * 2), Image.NEAREST).save(os.path.join(args.out, "all_states.png"))
print(len(shots), "states ->", args.out)
