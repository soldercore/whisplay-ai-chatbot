#!/usr/bin/env python3
"""Key-state screenshots of the redesigned interface from the production renderer (fake LCD, deterministic clock).
Output: <out>/<name>.png at 2x plus <out>/states.png (the full set) and <out>/film_*.png (animation filmstrips).
  python3 python/dev/design_shots.py [--out DIR]"""
import argparse
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import preview_ui as pv  # noqa: E402
from PIL import Image  # noqa: E402

parser = argparse.ArgumentParser()
parser.add_argument("--out", default=os.path.join(os.path.dirname(HERE), "..", "design-shots"))
args = parser.parse_args()
out = os.path.abspath(args.out)
os.makedirs(out, exist_ok=True)
ANSWER = ("Tomorrow in Tokyo: light rain in the morning, clearing by the afternoon. High 21 degrees, low 15, with a sixty percent "
          "chance of showers before noon. Yes, take a compact umbrella.")
shots = []


def snap(s, name):
    image = s.lcd.image()
    shots.append((name, image))
    image.resize((480, 560), Image.NEAREST).save(os.path.join(out, name + ".png"))


def film(s, name, status, text, seconds, step=0.25, crop=(56, 56, 184, 184), **extra):
    """Frames from the instant of the update (t=0) every `step` seconds, cropped to the optic."""
    frames = []
    s.send(status=status, emoji="😐", text=text, **extra)
    t_end = s.now + seconds
    s.run_until(s.now + 0.001)
    frames.append(s.lcd.image().crop(crop))
    while s.now < t_end - 1e-6:
        s.run_until(s.now + step)
        frames.append(s.lcd.image().crop(crop))
    w, h = frames[0].size
    sheet = Image.new("RGB", (w * len(frames) + 4 * (len(frames) - 1), h), (30, 30, 30))
    for i, f in enumerate(frames):
        sheet.paste(f, (i * (w + 4), 0))
    sheet.save(os.path.join(out, "film_%s.png" % name))


s = pv.Session()
try:
    s.send(status="idle|capri", emoji="😴", text=""); s.run_until(s.now + 1.0); snap(s, "01_idle")
    s.send(status="idle|capri,heard", emoji="😴", text=""); s.run_until(s.now + 0.4); snap(s, "02_wake_detected")
    s.send(status="listening|capri", emoji="😐", text="Listening..."); s.run_until(s.now + 1.0); snap(s, "03_listening")
    s.send(status="listening|capri,audio", emoji="😐", text="Listening..."); s.run_until(s.now + 0.5); snap(s, "03b_listening_audio")
    s.send(status="recognizing", emoji="😐", text=""); s.run_until(s.now + 0.5); snap(s, "04_recognizing")
    s.send(status="answering...|said", emoji="😐", text="what's the weather in Tokyo"); s.run_until(s.now + 0.9); snap(s, "05_thinking")
    s.send(status="answering", emoji="🌧", scroll_speed=3, transaction_id=2); s.run_until(s.now + 0.3)
    shown = 0
    while shown < len(ANSWER):
        shown = min(len(ANSWER), shown + 7)
        s.send(status="answering", text=ANSWER[:shown], scroll_speed=3, transaction_id=2); s.run_until(s.now + 0.08)
    s.run_until(s.now + 0.5)
    s.send(scroll_sync={"char_end": 90, "duration_ms": 3600}); s.run_until(s.now + 1.2); snap(s, "06_speaking")
    s.run_until(s.now + 6.0)
    s.send(status="idle|capri,resp:4.5"); s.run_until(s.now + 1.0); snap(s, "07_response_stays")
    s.send(status="idle|capri,resp:4.5,heard"); s.run_until(s.now + 0.4); snap(s, "07b_wake_over_response")
    s.send(status="error", emoji="😐", text="Offline: cannot reach the language model"); s.run_until(s.now + 1.0); snap(s, "08_error")
    s.send(status="tool calling", emoji="😐", text="[webSearch] Tokyo weather", tool_placeholders={"t1": "% webSearch..."}); s.run_until(s.now + 0.8); snap(s, "09_tool")
    s.send(status="Confirm", emoji="😐", text="[shell] Run command rm -rf ~/tmp", approval_mode=True); s.run_until(s.now + 0.5); snap(s, "10_approval")
finally:
    s.close()

for i in range(0, 1):
    pass
s = pv.Session()
try:
    s.send(status="idle|capri", emoji="😴", text=""); s.run_until(s.now + 1.5)
    # wake: the shutter snaps open (every 50 ms for half a second), then settles into listening
    film(s, "wake", "idle|capri,heard", "", 0.55, 0.05)
    film(s, "heard_to_listening", "listening|capri", "Listening...", 1.2, 0.1)
    film(s, "speech_detected", "listening|capri,audio", "Listening...", 0.8, 0.1)
    film(s, "recognizing", "recognizing", "", 1.0, 0.125)
    film(s, "thinking", "answering...", "", 3.2, 0.4)
    film(s, "listening_drain", "listening|capri,answer:5", "Listening...", 5.0, 0.6)
finally:
    s.close()

# the response text decode (the existing glitch effect): a sentence arrives, frames every ~27 ms
s = pv.Session()
try:
    s.send(status="answering", emoji="🌧", scroll_speed=3, transaction_id=3); s.run_until(s.now + 0.3)
    line = "Oh, how delightful. Another test."
    frames, shown = [], 0
    crop = (0, 60, 240, 130)
    while shown < len(line):
        shown = min(len(line), shown + 7)
        s.send(status="answering", text=line[:shown], scroll_speed=3, transaction_id=3)
        for _ in range(3):
            s.run_until(s.now + 0.027)
            frames.append(s.lcd.image().crop(crop))
    s.run_until(s.now + 0.4)
    frames.append(s.lcd.image().crop(crop))
    cols_d = 3
    rows_d = (len(frames) + cols_d - 1) // cols_d
    w, h = frames[0].size
    sheet_d = Image.new("RGB", (cols_d * (w + 4), rows_d * (h + 4)), (30, 30, 30))
    for i, f in enumerate(frames):
        sheet_d.paste(f, ((i % cols_d) * (w + 4), (i // cols_d) * (h + 4)))
    sheet_d.save(os.path.join(out, "film_text_decode.png"))
finally:
    s.close()

cols = 4
rows = (len(shots) + cols - 1) // cols
sheet = Image.new("RGB", (cols * 250, rows * 290), (28, 28, 28))
for i, (name, image) in enumerate(shots):
    sheet.paste(image, ((i % cols) * 250 + 5, (i // cols) * 290 + 5))
sheet.save(os.path.join(out, "states.png"))
print("wrote", len(shots), "states to", out)
