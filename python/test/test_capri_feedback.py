"""Simulated-audio test of the Capri status lines added for the UI (CAPRI_HEARING, CAPRI_TIMING).

No microphone, daemon, Whisper or TV. Audio is 20 ms frames of 16-bit PCM on a fake clock, and the recognition
result of the staged script is compared with a reference copy (the previously deployed script) when one is given:
  PROD_CAPRI=/path/to/previous/capri_wake.py python3 python/test/test_capri_feedback.py
"""
import array, contextlib, importlib.util, io, json, os, sys, tempfile, types
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
FRAME_S = 0.02
NOISE, GAP = 30, 30
WORD_FRAMES, GAP_FRAMES = 18, 4
CLOCK = {"now": 0.0}


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    mod.recording_allowed = lambda: True
    mod.authorize_capture = lambda: None
    mod.chime = lambda: -1.0
    mod.time = types.SimpleNamespace(monotonic=lambda: CLOCK["now"], sleep=lambda _s: None)
    return mod


def frame(value):
    return array.array("h", [value] * 320).tobytes()


def speech(words, start_index=0):
    out = []
    for i, _ in enumerate(words):
        out += [frame(1000 + start_index + i)] * WORD_FRAMES + [frame(GAP)] * GAP_FRAMES
    return out


def silence(seconds):
    return [frame(NOISE)] * round(seconds / FRAME_S)


class Script:
    def __init__(self, frames):
        self.frames, self.i = frames, 0

    def read(self):
        if self.i >= len(self.frames):
            raise TimeoutError("script exhausted")
        self.i += 1
        CLOCK["now"] += FRAME_S
        return CLOCK["now"], self.frames[self.i - 1]


def recognizer(vocab):
    def recognize(raw, _file, hint=None):
        if not raw:
            return ""
        samples = array.array("h", raw)
        counts, order = {}, []
        for k in range(0, len(samples), 320):
            v = samples[k]
            if v >= 1000:
                idx = v - 1000
                if idx not in counts:
                    order.append(idx)
                counts[idx] = counts.get(idx, 0) + 1
        words = []
        for idx in order:
            word = vocab[idx]
            words.append(word if counts[idx] >= WORD_FRAMES else word[:max(1, len(word) * counts[idx] // WORD_FRAMES)])
        return " ".join(words)
    return recognize


def run_main(mod, mics, vocab):
    CLOCK["now"] = 0.0
    used = iter([Script(m) for m in mics])

    @contextlib.contextmanager
    def fake_mic():
        yield next(used).read

    mod.live_mic = fake_mic
    mod.recognize = recognizer(vocab)
    real_tmp = tempfile.TemporaryDirectory
    mod.tempfile.TemporaryDirectory = lambda **k: real_tmp()
    out, err = io.StringIO(), io.StringIO()
    with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
        try:
            mod.main()
        except (TimeoutError, StopIteration, RuntimeError):
            pass
    mod.tempfile.TemporaryDirectory = real_tmp
    lines = out.getvalue().splitlines()
    run_main.ready = lines[:1] == ["CAPRI_READY"]
    return [l for l in lines if l != "CAPRI_READY"]


def command_of(lines):
    for line in lines:
        if line.startswith("CAPRI_COMMAND "):
            return json.loads(line.split(" ", 1)[1])


CMD = ["turn", "off", "the", "TV", "screen"]
VOCAB = {i: w for i, w in enumerate(["capri"] + CMD)}


def main():
    new = load("new", ROOT / "python" / "capri_wake.py")
    prev_path = os.environ.get("PROD_CAPRI")
    prev = load("prev", prev_path) if prev_path else None
    calib = silence(0.5)
    rows, failures = [], []

    def check(name, cond, detail=""):
        rows.append((name, "PASS" if cond else "FAIL", detail))
        if not cond:
            failures.append(name)

    # 1. One utterance "Capri turn off the TV screen": same command, a timing line right before it, no HEARING (not a follow-up).
    words = ["capri"] + CMD
    one = calib + silence(0.5) + speech(words) + silence(2)
    lines = run_main(new, [one], VOCAB)
    check("CAPRI_READY is the first line, before any capture", run_main.ready)
    check("single utterance dispatches", command_of(lines) == "turn off the TV screen", repr(command_of(lines)))
    timing = [l for l in lines if l.startswith("CAPRI_TIMING ")]
    check("one timing line, immediately before the command", len(timing) == 1 and lines.index(timing[0]) == lines.index(next(l for l in lines if l.startswith("CAPRI_COMMAND "))) - 1, str(lines))
    ms = int(timing[0].split()[1])
    # Speech ended at the last word; the capture returns after its 0.6 s of silence, so about 600 ms (plus one frame) had passed.
    check("timing = ms since the last loud frame", 560 <= ms <= 680, f"{ms} ms")
    check("no AUDIO or PROCESSING outside the follow-up capture", "CAPRI_AUDIO" not in lines and "CAPRI_PROCESSING" not in lines)
    if prev:
        check("same command as the previous script", command_of(run_main(prev, [one], VOCAB)) == command_of(lines))

    # 2. "Capri" alone, chime, then the command: HEARING once during the follow-up, timing from the follow-up's own end.
    capri_only = calib + silence(0.5) + speech(["capri"]) + silence(2)
    follow = [frame(NOISE)] + silence(1.0) + speech(CMD, start_index=1) + silence(2)
    lines = run_main(new, [capri_only, follow], VOCAB)
    check("follow-up dispatches", command_of(lines) == "turn off the TV screen", repr(command_of(lines)))
    order = [l.split()[0] for l in lines]
    check("order: LISTENING, AUDIO (once), PROCESSING, TIMING, COMMAND", order == ["CAPRI_LISTENING", "CAPRI_AUDIO", "CAPRI_PROCESSING", "CAPRI_TIMING", "CAPRI_COMMAND"], str(order))
    check("follow-up timing is plausible", 560 <= int(lines[3].split()[1]) <= 680, lines[3])
    if prev:
        check("same follow-up command as the previous script", command_of(run_main(prev, [capri_only, follow], VOCAB)) == command_of(lines))

    # 3. A short noise burst in the follow-up is discarded without a HEARING, then the real command is heard once.
    blip = [frame(1000)] * 3 + silence(1.5)
    follow_blip = [frame(NOISE)] + silence(0.3) + blip + silence(0.5) + speech(CMD, start_index=1) + silence(2)
    lines = run_main(new, [capri_only, follow_blip], VOCAB)
    check("noise burst: one AUDIO, for the real sound only", lines.count("CAPRI_AUDIO") == 1 and lines.count("CAPRI_PROCESSING") == 1 and command_of(lines) == "turn off the TV screen", str(lines))

    # 4. Silence after the chime: no HEARING and no timing; the loop returns to idle.
    lines = run_main(new, [capri_only, [frame(NOISE)] + silence(8)], VOCAB)
    check("silent follow-up: no AUDIO, no PROCESSING, no TIMING, no command", "CAPRI_AUDIO" not in lines and "CAPRI_PROCESSING" not in lines and not any(l.startswith("CAPRI_TIMING") for l in lines) and command_of(lines) is None and "CAPRI_IDLE" in lines, str(lines))

    width = max(len(r[0]) for r in rows)
    for name, verdict, detail in rows:
        print(f"{verdict}  {name.ljust(width)}  {detail}")
    print(f"\n{len(rows) - len(failures)}/{len(rows)} passed")
    sys.exit(1 if failures else 0)


if __name__ == "__main__":
    main()
