#!/usr/bin/env python3
"""One continuous run through the states (idle, wake, listening, speech, recognizing, thinking, streamed answer with the decode effect,
speaking, response stays) rendered by the production renderer on a fake LCD, saved as an animated GIF at the real time base (20 fps).
  python3 python/dev/design_gif.py [--out FILE]"""
import argparse
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import preview_ui as pv  # noqa: E402
from PIL import Image  # noqa: E402

parser = argparse.ArgumentParser()
parser.add_argument("--out", default="design-flow.gif")
args = parser.parse_args()
ANSWER = "Tomorrow in Tokyo: light rain in the morning, clearing by the afternoon. Take a compact umbrella."
frames = []


def advance(s, seconds, step=0.05):
    end = s.now + seconds
    while s.now < end - 1e-6:
        s.run_until(s.now + step)
        frames.append(s.lcd.image().resize((360, 420), Image.NEAREST))


s = pv.Session()
try:
    s.send(status="idle|capri", emoji="😴", text=""); advance(s, 1.5)
    s.send(status="idle|capri,heard", emoji="😴", text=""); advance(s, 0.9)
    s.send(status="listening|capri", emoji="😐", text="Listening..."); advance(s, 1.4)
    s.send(status="listening|capri,audio", emoji="😐", text="Listening..."); advance(s, 1.3)
    s.send(status="recognizing", emoji="😐", text=""); advance(s, 1.4)
    s.send(status="answering...|said", emoji="😐", text="what's the weather in Tokyo"); advance(s, 3.0)
    s.send(status="answering", emoji="🌧", scroll_speed=3, transaction_id=2); advance(s, 0.3)
    shown = 0
    while shown < len(ANSWER):
        shown = min(len(ANSWER), shown + 9)
        s.send(status="answering", text=ANSWER[:shown], scroll_speed=3, transaction_id=2); advance(s, 0.1)
    advance(s, 0.4)
    s.send(scroll_sync={"char_end": len(ANSWER), "duration_ms": 4200}); advance(s, 4.6)
    s.send(status="idle|capri,resp:4.5"); advance(s, 2.0)
finally:
    s.close()
frames[0].save(args.out, save_all=True, append_images=frames[1:], duration=50, loop=0, optimize=False)
print("wrote", args.out, len(frames), "frames,", os.path.getsize(args.out) // 1024, "KB")
