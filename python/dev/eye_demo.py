#!/usr/bin/env python3
"""Eye animation demo, measurements and checks on the production renderer with a fake LCD and a manual clock.

    python3 python/dev/eye_demo.py --envs envs.json --out out_dir [--perf] [--check]

envs.json maps a WAV name to {"durationMs", "levels"} where `levels` is exactly what Node's speechTimingFromWav()
produces (one hex digit per 20 ms of the sentence's own audio). The demo plays the sentences back to back, sends the
same scroll_sync payload Node sends at playback start, and records what the screen shows.
"""
import argparse
import json
import os
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
try:  # a development PC without the Cairo library: emoji SVGs are then unavailable (the eye does not need them)
    import cairosvg  # noqa: F401
except Exception:
    import types
    _stub = types.ModuleType("cairosvg")
    def _no_svg(*a, **k):
        raise RuntimeError("cairosvg is not installed")
    _stub.svg2png = _no_svg
    sys.modules["cairosvg"] = _stub
import preview_ui as pv  # noqa: E402  (changes directory, loads the renderer)
from PIL import Image, ImageDraw  # noqa: E402
import numpy as np  # noqa: E402
from whisplay_ui import theme  # noqa: E402

EYE = 20
EYE_X = theme.CHROME_RIGHT - EYE
EYE_Y = theme.PANE_Y + theme.STRIP_MID_Y - EYE // 2


def eye_crop(session):
    img = session.lcd.image()
    return img.crop((EYE_X, EYE_Y, EYE_X + EYE, EYE_Y + EYE))


def truth(levels, t_ms):
    """Loudness of the sentence audio at t_ms, linear interpolation of the same envelope the display receives."""
    pos = t_ms / 20.0
    if pos < 0 or pos >= len(levels):
        return 0.0
    i = int(pos)
    f = pos - i
    a = int(levels[i], 16) / 15.0
    b = int(levels[i + 1], 16) / 15.0 if i + 1 < len(levels) else 0.0
    return a * (1 - f) + b * f


def play(session, sentences, gap=0.35, interrupt_at=None, fps=None, record=None, env_off=False):
    """Run the speaking sequence. Returns per-frame records: time, displayed level, true level, eye crop."""
    s = session
    text = " ".join(x["text"] for x in sentences)
    s.send(status="answering", emoji="", text=text)
    s.run_until(s.now + 0.3)
    cursor = 0
    starts, t0 = [], s.now
    t = t0
    schedule = []
    for item in sentences:
        cursor += len(item["text"]) + 1
        schedule.append((t, cursor, item))
        t += item["durationMs"] / 1000.0 + gap
    end_audio = schedule[-1][0] + schedule[-1][2]["durationMs"] / 1000.0
    frames = []
    idx = 0
    stop_at = end_audio + 1.2 if interrupt_at is None else interrupt_at + 0.8
    step = 1.0 / 60.0
    cur = None
    interrupted = False
    while s.now < stop_at:
        nxt = s.now + step
        if idx < len(schedule) and nxt >= schedule[idx][0] and not (interrupt_at is not None and schedule[idx][0] >= interrupt_at):
            ts, char_end, item = schedule[idx]
            s.run_until(ts)
            payload = {"char_end": char_end, "duration_ms": item["durationMs"]}
            if not env_off:
                payload["env"] = item["levels"]
            s.send(scroll_sync=payload)
            cur = (ts, item)
            idx += 1
        if interrupt_at is not None and not interrupted and nxt >= interrupt_at:
            s.run_until(interrupt_at)
            s.send(status="listening", text="")      # the user pressed the button: playback is stopped by Node
            interrupted = True
        s.run_until(nxt)
        true_level = 0.0
        if cur and not interrupted:
            true_level = truth(cur[1]["levels"], (s.now - cur[0]) * 1000.0)
        eye = s.rt.terminal_ui.eye
        kind = s.rt.terminal_ui.pane_kind
        frames.append({"t": s.now - t0, "shown": eye.level_now if eye and kind == "strip" else 0.0, "true": true_level, "crop": eye_crop(s), "kind": kind})
    return frames, schedule, t0


def correlation(frames, lag_s):
    """Pearson correlation between the true audio level and the displayed level `lag_s` later."""
    ts = np.array([f["t"] for f in frames])
    shown = np.array([f["shown"] for f in frames])
    true = np.array([f["true"] for f in frames])
    shifted = np.interp(ts + lag_s, ts, shown)
    mask = ts < ts[-1] - 0.5
    return float(np.corrcoef(true[mask], shifted[mask])[0, 1])


def plot(frames, path, width=900, height=200):
    img = Image.new("RGB", (width, height), (8, 12, 8))
    d = ImageDraw.Draw(img)
    t_end = frames[-1]["t"]
    for key, color in (("true", (90, 109, 90)), ("shown", (74, 235, 123))):
        pts = [(int(f["t"] / t_end * (width - 1)), int((1 - f[key]) * (height - 20)) + 10) for f in frames]
        d.line(pts, fill=color, width=2)
    d.text((6, 4), "grey: loudness of the audio being played   green: level the eye shows", fill=(160, 190, 160))
    img.save(path)


def sheet(crops, path, cols=16, scale=6):
    rows = (len(crops) + cols - 1) // cols
    out = Image.new("RGB", (cols * (EYE * scale + 4), rows * (EYE * scale + 4)), (8, 12, 8))
    for i, c in enumerate(crops):
        out.paste(c.resize((EYE * scale, EYE * scale), Image.NEAREST), ((i % cols) * (EYE * scale + 4), (i // cols) * (EYE * scale + 4)))
    out.save(path)


def states_sheet(out_dir):
    """The strip and the microphone row in every state, whole screen at actual size."""
    shots = []
    s = pv.Session(env={"WHISPLAY_UI_EYE": "on"})
    try:
        base = dict(emoji="😴", battery_level=87, battery_color="#34d351", vpn_connected=False, rag_icon_visible=False,
                    image_icon_visible=False, wifi_signal_level=3)
        def go(name, settle=1.3, **kw):
            s.send(**{**base, **kw})
            s.run_until(s.now + settle)
            shots.append((name, s.lcd.image()))
        go("idle_ready", status="idle|capri", text="")
        go("listening", status="listening|auto", text="Listening...", settle=2.3)
        go("audio_detected", status="listening|auto,audio", text="Listening...", settle=2.3)
        go("thinking", status="answering...|said", text="turn off the tv screen", settle=1.05)
        go("response_idle", status="idle|capri", text="Screen off.", settle=1.0)
        go("tool_ok", status="answering", text="{tool:t1} Screen off.", tool_placeholders={"t1": "% tv-screen.ok..."}, settle=1.0)
        go("tool_failed", status="idle|capri", text="{tool:t1} Could not.", tool_placeholders={"t1": "% tv-screen.failed..."}, settle=1.5)
        go("tool_failed_settled", status="idle|capri", text="{tool:t1} Could not.", tool_placeholders={"t1": "% tv-screen.failed..."}, settle=7.0)
        go("receiving", status="answering", text="The weather in", settle=0.1)
    finally:
        s.close()
    pv.contact_sheet(shots, columns=5, scale=2).save(os.path.join(out_dir, "eye_states_screens.png"))
    return shots


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--envs", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--perf", action="store_true")
    ap.add_argument("--check", action="store_true", help="run the eye checks only")
    args = ap.parse_args()
    if args.check:
        sys.exit(checks())
    os.makedirs(args.out, exist_ok=True)
    envs = json.load(open(args.envs))
    texts = {"sapi1.wav": "Screen off.",
             "sapi2.wav": "Oh. It's you. I suppose the screen is off now, which is what you wanted, probably.",
             "sapi3.wav": "The weather in Oslo is, as usual, cold. You should still go outside."}
    sentences = [dict(text=texts[k], **v) for k, v in envs.items()]

    states_sheet(args.out)

    s = pv.Session(env={"WHISPLAY_UI_EYE": "on"})
    try:
        frames, schedule, t0 = play(s, sentences)
    finally:
        s.close()
    best = max(((correlation(frames, lag / 1000.0), lag) for lag in range(0, 200, 10)))
    print("sync: best correlation %.3f at display lag %d ms; at 0 ms %.3f" % (best[0], best[1], correlation(frames, 0.0)))
    plot(frames, os.path.join(args.out, "eye_sync_plot.png"))
    # frames every 3rd (20 fps) as a strip of crops for a visual sequence
    picks = [f["crop"] for f in frames[:: 6]][:96]
    sheet(picks, os.path.join(args.out, "eye_speaking_sequence.png"))
    gif = [f["crop"].resize((EYE * 8, EYE * 8), Image.NEAREST) for f in frames[:: 2]]
    gif[0].save(os.path.join(args.out, "eye_speaking.gif"), save_all=True, append_images=gif[1:], duration=33, loop=0)
    json.dump([{k: (round(v, 4) if isinstance(v, float) else v) for k, v in f.items() if k != "crop"} for f in frames], open(os.path.join(args.out, "eye_frames.json"), "w"))

    # Interruption in the middle of the second sentence.
    s = pv.Session(env={"WHISPLAY_UI_EYE": "on"})
    try:
        cut = sentences[0]["durationMs"] / 1000.0 + 0.35 + 1.5
        frames_i, _, _ = play(s, sentences, interrupt_at=0.3 + cut)
    finally:
        s.close()
    sheet([f["crop"] for f in frames_i[:: 3]][:64], os.path.join(args.out, "eye_interrupt_sequence.png"))
    before = [f for f in frames_i if f["t"] <= cut][-1]
    after = [f for f in frames_i if f["t"] >= cut + 0.05][0]
    print("interrupt: level before %.2f (%s pane); 50 ms after the press the %s pane shows no speaking level (%.2f)" % (before["shown"], before["kind"], after["kind"], after["shown"]))

    if args.perf:
        perf(args.out, sentences)


def checks():
    """Automated checks of the eye on the production renderer (fake LCD, manual clock)."""
    failures = []

    def check(ok, name):
        print(("  PASS " if ok else "  FAIL ") + name)
        if not ok:
            failures.append(name)

    def green(img):
        a = np.asarray(img).astype(int)
        return int((a[:, :, 1] - a[:, :, 0]).clip(0).sum())

    step = "f" * 25 + "0" * 25 + "8" * 25 + "0" * 25          # loud 0.5 s, silence 0.5 s, medium 0.5 s, silence 0.5 s
    s = pv.Session(env={"WHISPLAY_UI_EYE": "on"})
    try:
        ui = s.rt.terminal_ui
        s.send(status="answering", emoji="", text="One two three four five six seven eight.")
        s.run_until(0.5)
        s.send(scroll_sync={"char_end": 20, "duration_ms": 2000, "env": step})
        marks = {}
        for name, at in (("loud", 0.35), ("gap", 0.75), ("medium", 1.25), ("quiet_end", 2.0), ("after", 2.6)):
            s.run_until(0.5 + at)
            marks[name] = (ui.eye.level_now, green(eye_crop(s)))
        check(marks["loud"][0] > 0.8 and marks["medium"][0] < marks["loud"][0] - 0.2, "level follows the audio: loud > medium")
        check(marks["gap"][0] < 0.25 and marks["quiet_end"][0] < 0.15, "a pause in the audio reduces the movement")
        check(marks["loud"][1] > marks["medium"][1] > marks["gap"][1], "the rendered eye gets brighter with the audio level")
        s.run_until(5.0)
        check(not ui.body.speaking(s.now) and ui._strip_mode(s.now) != "SPEAKING", "animation ends when playback ends")
        before = green(eye_crop(s))
        s.run_until(9.0)
        check(abs(green(eye_crop(s)) - before) < 0.3 * before and ui.eye.level_now < 0.05,
              "after playback the eye returns to the quiet idle breath (no speaking level left)")
        # second sentence, then an interruption
        s.send(scroll_sync={"char_end": 30, "duration_ms": 2000, "env": step})
        s.run_until(s.now + 0.3)
        check(ui._strip_mode(s.now) == "SPEAKING", "a new sentence starts speaking")
        s.send(status="listening", text="")
        s.run_until(s.now + 0.05)
        check(ui.pane_kind == "microphone" and ui._strip_mode(s.now) != "SPEAKING", "interruption: the speaking strip is gone at once")
        # no envelope (not measurable audio): steady, never random
        s.send(status="answering", text="Hello there.")
        s.run_until(s.now + 0.5)
        s.send(scroll_sync={"char_end": 12, "duration_ms": 1500})
        crops = []
        for _ in range(12):
            s.run_until(s.now + 0.1)
            crops.append(np.asarray(eye_crop(s)).tobytes())
        check(len(set(crops)) == 1, "no envelope: the speaking eye stays steady instead of inventing movement")
        # malformed envelope must not break the display
        s.send(scroll_sync={"char_end": 12, "duration_ms": 800, "env": "zz!!"})
        s.run_until(s.now + 1.0)
        check(s.rt.terminal_ui is not None, "a malformed envelope is harmless (terminal UI still active)")
        # states are visually distinct at the real size
        imgs = {}
        for name, status, text in (("idle", "idle", ""), ("listen", "listening|auto", "Listening..."), ("think", "answering...|said", "x")):
            s.send(status=status, text=text)
            s.run_until(s.now + 1.3)
            imgs[name] = np.asarray(s.lcd.image().crop((196, 87, 216, 107))).tobytes()
        check(len(set(imgs.values())) == 3, "idle, listening and thinking eyes differ in the microphone row")
    finally:
        s.close()
    off = pv.Session(env={"WHISPLAY_UI_EYE": "off"})
    try:
        off.send(status="idle|capri", text="Screen off.", emoji="😴")
        off.run_until(2.0)
        check(off.rt.terminal_ui.eye is None, "WHISPLAY_UI_EYE=off restores the emoji path")
    finally:
        off.close()
    print("eye checks: %d failed" % len(failures))
    return 1 if failures else 0


def perf(out_dir, sentences):
    """Wall time of the production renderer per frame: eye on vs the unchanged emoji strip."""
    rows = []
    for label, env in (("emoji (baseline)", {"WHISPLAY_UI_EYE": "off"}), ("eye", {"WHISPLAY_UI_EYE": "on"})):
        s = pv.Session(env=env)
        try:
            def timed(name, seconds, **kw):
                if kw:
                    s.send(**kw)
                s.run_until(s.now + 0.5)
                f0, p0 = s.frames, len(s.lcd.pushes)
                t0 = time.perf_counter()
                c0 = time.process_time()
                s.run_until(s.now + seconds)
                wall, cpu = time.perf_counter() - t0, time.process_time() - c0
                n = s.frames - f0
                rows.append((label, name, n, seconds, cpu * 1000.0 / max(1, n), cpu / seconds * 100.0, sum(w * h for _x, _y, w, h in s.lcd.pushes[p0:]) * 2 / 1024.0 / seconds))
            timed("idle strip, 60 s", 60.0, status="idle|capri", text="Screen off.", emoji="😴")
            timed("idle microphone, 60 s", 60.0, status="idle", text="")
            timed("listening, 20 s", 20.0, status="listening|auto", text="Listening...")
            timed("thinking, 20 s", 20.0, status="answering...|said", text="turn off the tv")
            s.send(status="answering", text="Screen off. " * 8, emoji="")
            s.run_until(s.now + 0.3)
            n0, c0, p0 = s.frames, time.process_time(), len(s.lcd.pushes)
            for k, item in enumerate(sentences):
                s.send(scroll_sync={"char_end": 40 * (k + 1), "duration_ms": item["durationMs"], "env": item["levels"]})
                s.run_until(s.now + item["durationMs"] / 1000.0 + 0.2)
            dur = sum(i["durationMs"] for i in sentences) / 1000.0 + 0.2 * len(sentences)
            cpu = time.process_time() - c0
            n = s.frames - n0
            rows.append((label, "speaking, %.0f s" % dur, n, dur, cpu * 1000.0 / max(1, n), cpu / dur * 100.0, sum(w * h for _x, _y, w, h in s.lcd.pushes[p0:]) * 2 / 1024.0 / dur))
        finally:
            s.close()
    print("%-18s %-24s %7s %9s %8s %9s" % ("variant", "phase", "frames", "ms/frame", "cpu%", "LCD KiB/s"))
    for r in rows:
        print("%-18s %-24s %7d %9.2f %8.2f %9.1f" % (r[0], r[1], r[2], r[4], r[5], r[6]))
    json.dump(rows, open(os.path.join(out_dir, "eye_perf.json"), "w"))


if __name__ == "__main__":
    main()
