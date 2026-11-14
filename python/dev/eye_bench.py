#!/usr/bin/env python3
"""Renderer cost on the real device: python3 eye_bench.py ENVS_JSON LABEL  (works on trees with or without the eye).

Runs the production renderer with a fake LCD and a manual clock, so only render work is measured (no waiting). Reports
CPU time per phase, frame time distribution, LCD bytes and peak memory, and for the speaking phase the playback sync.
"""
import json
import os
import resource
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import preview_ui as pv  # noqa: E402
import numpy as np  # noqa: E402


def rss_mb():
    for line in open("/proc/self/status"):
        if line.startswith("VmRSS"):
            return int(line.split()[1]) / 1024.0
    return 0.0


def main():
    envs = json.load(open(sys.argv[1]))
    label = sys.argv[2]
    sentences = list(envs.values())
    s = pv.Session()
    times = []
    real_frame = s.frame

    def timed_frame():
        t0 = time.perf_counter()
        r = real_frame()
        times.append((time.perf_counter() - t0) * 1000.0)
        return r
    s.frame = timed_frame
    rows = []

    def phase(name, seconds, **kw):
        if kw:
            s.send(**kw)
        s.run_until(s.now + 0.5)
        n0, p0, c0 = len(times), len(s.lcd.pushes), time.process_time()
        s.run_until(s.now + seconds)
        cpu = time.process_time() - c0
        ft = times[n0:]
        kib = sum(w * h for _x, _y, w, h in s.lcd.pushes[p0:]) * 2 / 1024.0 / seconds
        rows.append(dict(phase=name, frames=len(ft), cpu_pct=cpu / seconds * 100.0, ms_mean=float(np.mean(ft)) if ft else 0.0,
                         ms_p95=float(np.percentile(ft, 95)) if ft else 0.0, ms_max=float(max(ft)) if ft else 0.0, lcd_kib_s=kib))
    phase("idle strip 60 s", 60.0, status="idle|capri", text="Screen off.", emoji="😴")
    phase("idle microphone 60 s", 60.0, status="idle", text="")
    phase("listening 20 s", 20.0, status="listening|auto", text="Listening...")
    phase("thinking 20 s", 20.0, status="answering...|said", text="turn off the tv")
    s.send(status="answering", text="Screen off. " * 12, emoji="")
    s.run_until(s.now + 0.3)
    n0, p0, c0 = len(times), len(s.lcd.pushes), time.process_time()
    dur = 0.0
    for k, item in enumerate(sentences):
        payload = {"char_end": 40 * (k + 1), "duration_ms": item["durationMs"]}
        if item.get("levels"):
            payload["env"] = item["levels"]
        s.send(scroll_sync=payload)
        step = item["durationMs"] / 1000.0 + 0.3
        s.run_until(s.now + step)
        dur += step
    cpu = time.process_time() - c0
    ft = times[n0:]
    rows.append(dict(phase="speaking %.1f s (3 real sentences)" % dur, frames=len(ft), cpu_pct=cpu / dur * 100.0, ms_mean=float(np.mean(ft)),
                     ms_p95=float(np.percentile(ft, 95)), ms_max=float(max(ft)),
                     lcd_kib_s=sum(w * h for _x, _y, w, h in s.lcd.pushes[p0:]) * 2 / 1024.0 / dur))
    out = dict(label=label, rss_mb=round(rss_mb(), 1), peak_rss_mb=round(resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1024.0, 1), rows=rows)
    print(json.dumps(out))


if __name__ == "__main__":
    main()
