#!/usr/bin/env python3
"""The landscape motion language as pictures: filmstrips of each state's trace and a full conversation as a GIF (2x, 15 fps).
  python3 python/dev/land_film.py [--out DIR]"""
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
from PIL import Image, ImageDraw  # noqa: E402

parser = argparse.ArgumentParser()
parser.add_argument("--out", default=os.path.join(os.path.dirname(HERE), "..", "land-film"))
args = parser.parse_args()
os.makedirs(args.out, exist_ok=True)
ANSWER = ("Tomorrow in Tokyo: light rain in the morning, clearing by the afternoon. High 21 degrees, low 15, with a sixty percent "
          "chance of showers before noon. Yes, take a compact umbrella.")


def view(s):
    img = s.lcd.image().rotate(90, expand=True)
    mask = Image.new("L", (img.width * 4, img.height * 4), 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, mask.width - 1, mask.height - 1), radius=160, fill=255)
    base = Image.new("RGB", img.size, (22, 22, 24))
    base.paste(img, (0, 0), mask.resize(img.size, Image.LANCZOS))
    return base


s = pv.Session(env={"WHISPLAY_UI_LAYOUT": "landscape"})
frames = []
try:
    def play(seconds, step=1 / 15.0):
        end = s.now + seconds
        while s.now < end - 1e-6:
            s.run_until(s.now + step)
            frames.append(view(s))

    s.send(status="idle|capri", text=""); play(0.7)
    s.send(status="idle|capri,heard", text=""); play(0.5)
    s.send(status="listening|capri", text="Listening..."); play(0.9)
    s.send(status="listening|capri,audio", text="Listening..."); play(1.2)
    s.send(status="recognizing", text="what's the weather in Tokyo tomorrow"); play(1.3)
    s.send(status="answering...|said", text="what's the weather in Tokyo tomorrow"); play(1.4)
    s.send(status="tool calling", text="[webSearch] Tokyo weather tomorrow"); play(1.6)
    s.send(status="answering", scroll_speed=3, transaction_id=2, text=""); play(0.3)
    shown = 0
    while shown < len(ANSWER):
        shown = min(len(ANSWER), shown + 7)
        s.send(status="answering", text=ANSWER[:shown], scroll_speed=3, transaction_id=2); play(0.08)
    s.send(scroll_sync={"char_end": 90, "duration_ms": 3600}); play(4.2)
    s.send(status="idle|capri,resp:4.5"); play(1.2)
    s.send(status="error", text="Offline: cannot reach the language model"); play(1.2)
finally:
    s.close()
big = [f.resize((f.width * 2, f.height * 2), Image.NEAREST) for f in frames]
big[0].save(os.path.join(args.out, "flow.gif"), save_all=True, append_images=big[1:], duration=67, loop=0, optimize=False)
# filmstrip of the trace across the states: every 0.2 s, cropped to the pipeline and the trace
rows = []
s = pv.Session(env={"WHISPLAY_UI_LAYOUT": "landscape"})
try:
    for label, status, text in (("listening", "listening|capri,audio", "Listening..."), ("recognizing", "recognizing", "what's the weather"),
                                ("thinking", "answering...|said", "what's the weather"), ("tool call", "tool calling", "[webSearch] Tokyo")):
        s.send(status=status, text=text)
        tiles = []
        for _ in range(8):
            s.run_until(s.now + 0.25)
            tiles.append(view(s).crop((14, 28, 266, 130)))
        row = Image.new("RGB", (len(tiles) * 256, tiles[0].height), (40, 40, 44))
        for i, tile in enumerate(tiles):
            row.paste(tile, (i * 256, 0))
        ImageDraw.Draw(row).text((6, 3), label, fill=(200, 200, 200))
        rows.append(row)
finally:
    s.close()
sheet = Image.new("RGB", (rows[0].width, sum(r.height + 4 for r in rows)), (40, 40, 44))
y = 0
for r in rows:
    sheet.paste(r, (0, y))
    y += r.height + 4
sheet.save(os.path.join(args.out, "trace_film.png"))
print("frames", len(frames), "->", args.out)
