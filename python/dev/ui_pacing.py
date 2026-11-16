#!/usr/bin/env python3
"""Frame pacing of the production renderer per UI state (fake LCD: no hardware, no port, no daemon) and a MODEL of what the Whisplay daemon
does with those frames. Part 1 is measured; part 2 applies the daemon's published loop (read the shared framebuffer, push the whole frame
when it changed, then sleep 1/RENDER_FPS) to the measured frame times, with an ASSUMED full-frame SPI time (ms, argument).
  python3 dev/ui_pacing.py [spi_ms=12.5] [seconds=6]"""
import os, statistics, sys, time

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import preview_ui as pv  # noqa: E402
from whisplay_ui import clock  # noqa: E402

spi_ms = float(sys.argv[1]) if len(sys.argv) > 1 else 12.5
seconds = float(sys.argv[2]) if len(sys.argv) > 2 else 6.0
DAEMON_INTERVAL = 0.05     # daemon_shared.RENDER_FPS = 20
READ_MS = 0.4              # 134,400-byte read + compare (measured separately)
ANSWER = ("Tomorrow in Tokyo: light rain in the morning, clearing by the afternoon. High 21 degrees, low 15, with a sixty percent chance of "
          "showers before noon. Yes, take a compact umbrella.")


def run(s, secs):
    end, rec = s.now + secs, []
    while True:
        t = max(s.now, s.next_frame)
        if t > end:
            break
        s.now = t
        clock.set_time(t)
        n0 = len(s.lcd.pushes)
        w0 = time.perf_counter()
        wait = s.frame()
        ms = (time.perf_counter() - w0) * 1000
        px = sum(w * h for (_x, _y, w, h) in s.lcd.pushes[n0:])
        rec.append((t, ms, px))
        s.next_frame = float("inf") if wait is None else t + max(wait, 1e-3)
    s.now = end
    clock.set_time(end)
    return rec


def daemon(updates, secs):
    """updates: times at which the app wrote new pixels. Returns push times and, per update, its latency to the screen (None = never shown)."""
    pushes, shown = [], {}
    t, i = 0.0, 0
    while t < secs:
        newest = None
        while i < len(updates) and updates[i] <= t:
            newest = i
            i += 1
        if newest is not None:
            for k in range(newest + 1):      # every update up to the newest is covered by this push; only the newest is displayed
                shown.setdefault(k, None)
            shown[newest] = t + (READ_MS + spi_ms) / 1000 - updates[newest]
            pushes.append(t)
            t += (READ_MS + spi_ms) / 1000
        else:
            t += READ_MS / 1000
        t += DAEMON_INTERVAL
    return pushes, shown


def scenario(name, setup, secs=seconds):
    s = pv.Session()
    try:
        setup(s)
        t0 = s.now
        rec = run(s, secs)
    finally:
        s.close()
    upd = [t - t0 for (t, ms, px) in rec if px > 0]
    base = 0.0

    ms = [m for (_t, m, p) in rec if p > 0] or [0]
    px = [p for (_t, _m, p) in rec if p > 0] or [0]
    span = secs
    pushes, shown = daemon(upd, secs)
    gaps = [(b - a) * 1000 for a, b in zip(pushes, pushes[1:])]
    lat = [v * 1000 for v in shown.values() if v is not None]
    dropped = sum(1 for v in shown.values() if v is None)
    cpu = sum(m for (_t, m, _p) in rec) / 1000 / secs * 100
    print(f"{name:<18} frames/s {len(upd) / span:5.1f} | render ms mean {statistics.mean(ms):4.1f} p95 {sorted(ms)[int(len(ms) * .95) - 1]:4.1f} max {max(ms):4.1f} "
          f"| px/frame {int(statistics.mean(px)):6d} | UI CPU {cpu:4.1f}% | screen updates/s {len(pushes) / span:4.1f}, "
          f"gap ms mean {statistics.mean(gaps) if gaps else 0:4.0f} min {min(gaps) if gaps else 0:3.0f} max {max(gaps) if gaps else 0:3.0f} | "
          f"frames never shown {dropped}/{len(upd)} | latency ms mean {statistics.mean(lat) if lat else 0:3.0f} max {max(lat) if lat else 0:3.0f}", flush=True)


def idle(s):
    s.send(status="idle|capri", emoji="😴", text=""); s.run_until(s.now + 3)


def listening(s):
    s.send(status="idle|capri", emoji="😴", text=""); s.run_until(s.now + 2)
    s.send(status="listening|capri", emoji="😴", text="Listening..."); s.run_until(s.now + 0.5)


def recognizing(s):
    s.send(status="listening|capri", emoji="😴", text="Listening..."); s.run_until(s.now + 1)
    s.send(status="recognizing", emoji="😴", text=""); s.run_until(s.now + 0.5)


def thinking(s):
    s.send(status="answering...|said", emoji="😴", text="what's the weather in Tokyo"); s.run_until(s.now + 0.8)


def speaking(s):
    s.send(status="answering", emoji="🌧", scroll_speed=3, transaction_id=2); s.run_until(s.now + 0.3)
    shown = 0
    while shown < len(ANSWER):                      # Node re-sends the whole text every ~80 ms while it streams
        shown = min(len(ANSWER), shown + 7)
        s.send(status="answering", text=ANSWER[:shown], scroll_speed=3, transaction_id=2); s.run_until(s.now + 0.08)
    s.run_until(s.now + 0.5)
    s.send(scroll_sync={"char_end": len(ANSWER), "duration_ms": 9000})   # the sentence's audio starts: words are revealed over its duration


def tool(s):
    s.send(status="tool calling", emoji="😴", text="[webSearch] Tokyo weather tomorrow", tool_placeholders={"t1": "% webSearch..."}); s.run_until(s.now + 0.5)


ONLY = os.environ.get("ONLY")
def wake(s):
    s.send(status="idle|capri", emoji="😴", text=""); s.run_until(s.now + 2)
    s.send(status="idle|capri,heard", emoji="😴", text="")


def rss_mb():
    for line in open("/proc/self/status"):
        if line.startswith("VmRSS"):
            return int(line.split()[1]) / 1024.0
    return 0.0


ONLY = os.environ.get("ONLY")
print(f"assumed full-frame SPI time {spi_ms} ms; daemon loop 1/20 s + push; renderer measured on this machine")
rss0 = rss_mb()
for name, setup, secs_ in (("idle (30 s)", idle, 30.0), ("wake heard", wake, seconds), ("listening", listening, seconds), ("recognizing", recognizing, seconds),
                           ("thinking", thinking, seconds), ("speaking", speaking, seconds), ("tool call", tool, seconds)):
    if not ONLY or name.split()[0] in ONLY.split(","):
        scenario(name, setup, secs_)
print("process RSS %.0f MB (%.0f MB at start)" % (rss_mb(), rss0))
