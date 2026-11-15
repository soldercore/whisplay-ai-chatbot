"""capri_wake.py with the optional openWakeWord detector (CAPRI_OWW_MODEL), against a scripted microphone. No audio device, no model.

  python3 -m unittest python/test/test_capri_oww.py -v
"""
import array, contextlib, importlib.util, io, os, queue, sys, tempfile, unittest
from pathlib import Path

SCRIPT = Path(__file__).resolve().parent.parent / "capri_wake.py"
FRAME = 640


def frame(amp):
    """One 20 ms frame whose rms is `amp` (a square wave: no DC)."""
    return array.array("h", [amp if i % 2 else -amp for i in range(FRAME // 2)]).tobytes()


class Timeline:
    """seconds of (amplitude, seconds) segments, played as 20 ms frames with a simulated clock."""
    def __init__(self, segments):
        self.frames = []
        for amp, seconds in segments:
            self.frames += [frame(amp)] * round(seconds / 0.02)
        self.pos = 0

    @property
    def clock(self):
        return 1000.0 + self.pos * 0.02

    def read(self):
        if self.pos >= len(self.frames):
            raise queue.Empty()
        self.pos += 1
        return 1000.0 + (self.pos - 1) * 0.02, self.frames[self.pos - 1]


class FakeDetector:
    """Fires when the frame with this exact amplitude (the end of the wake word) goes by."""
    MARK = 3001

    def __init__(self, path):
        self.fired = 0

    def reset(self): pass

    def score(self, block):
        return 0.95 if array.array("h", block)[1] == self.MARK else None


def load(timeline, recognized, oww=True, detector=FakeDetector, calls=None):
    env = dict(os.environ)
    for key in ("CAPRI_OWW_MODEL", "CAPRI_OWW_THRESHOLD"):
        os.environ.pop(key, None)
    if oww:
        os.environ["CAPRI_OWW_MODEL"] = "capri.onnx"
    os.environ["CAPRI_DIAGNOSTICS"] = "0"
    spec = importlib.util.spec_from_file_location("capri_under_test", SCRIPT)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    os.environ.clear(); os.environ.update(env)
    calls = calls if calls is not None else {}
    calls.update(recognize=[], chime=0, opens=0)
    module.authorize_capture = lambda: None
    module.recording_allowed = lambda: True
    module.OwwDetector = detector

    @contextlib.contextmanager
    def live_mic():
        calls["opens"] += 1
        yield timeline.read
    module.live_mic = live_mic

    def recognize(raw, file, hint=None):
        if not raw: return ""                      # the real one returns at once, without a request
        calls["recognize"].append(dict(seconds=len(raw) / 32000, hint=hint, first_amp=array.array("h", raw[:FRAME])[1]))
        return recognized.pop(0) if recognized else ""
    module.recognize = recognize

    def chime():
        calls["chime"] += 1
        return timeline.clock
    module.chime = chime
    real = tempfile.TemporaryDirectory
    module.tempfile = type("T", (), {"TemporaryDirectory": staticmethod(lambda **kw: real())})
    return module


def run(module):
    out, err = io.StringIO(), io.StringIO()
    with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
        try:
            module.main()
        except queue.Empty:
            pass
    return out.getvalue().splitlines(), err.getvalue()


WORD = (3000, 0.4)
WORD_END = (FakeDetector.MARK, 0.02)       # the frame the detector fires on
ROOM = (100, 1.0)


class OpenWakeWord(unittest.TestCase):
    def test_wake_word_and_command_in_one_breath(self):
        calls = {}
        line = Timeline([ROOM, WORD, WORD_END, (2500, 1.2), (100, 1.5)])
        out, _ = run(load(line, ["what time is it"], calls=calls))
        self.assertTrue(any(l.startswith("CAPRI_COMMAND") and "what time is it" in l for l in out), out)
        self.assertEqual(calls["chime"], 0, "a command spoken in the same breath needs no chime")
        self.assertEqual(len(calls["recognize"]), 1)
        self.assertIsNone(calls["recognize"][0]["hint"], "the command is transcribed without the wake hint")
        self.assertIn(calls["recognize"][0]["first_amp"], (3000, FakeDetector.MARK), "the audio starts inside the wake word: the pre-roll is kept")
        self.assertEqual(calls["opens"], 1, "one microphone open, no second capture")

    def test_a_leading_capri_fragment_is_dropped(self):
        line = Timeline([ROOM, WORD, WORD_END, (3000, 1.0), (100, 1.5)])
        out, _ = run(load(line, ["Capri, turn the volume down"]))
        self.assertTrue(any('"turn the volume down"' in l for l in out), out)

    def test_bare_wake_word_chimes_and_listens_for_the_command(self):
        calls = {}
        line = Timeline([ROOM, WORD, WORD_END, (100, 1.6), (3000, 1.0), (100, 1.5)])
        out, _ = run(load(line, ["turn off the TV"], calls=calls))
        self.assertEqual(calls["chime"], 1)
        self.assertIn("CAPRI_LISTENING", out)
        self.assertIn("CAPRI_PROCESSING", out)
        self.assertTrue(any(l.startswith("CAPRI_COMMAND") and "turn off the TV" in l for l in out), out)
        self.assertEqual(calls["opens"], 1)

    def test_false_detection_followed_by_silence_does_nothing(self):
        calls = {}
        line = Timeline([ROOM, (100, 0.4), WORD_END, (100, 8.0)])
        out, _ = run(load(line, [], calls=calls))
        self.assertFalse(any(l.startswith("CAPRI_COMMAND") for l in out), out)
        self.assertIn("CAPRI_IDLE", out)
        self.assertEqual(calls["recognize"], [], "no Whisper request without speech")

    def test_unrecognised_speech_after_a_detection_ends_idle_not_as_a_command(self):
        line = Timeline([ROOM, WORD, WORD_END, (3000, 1.0), (100, 1.0), (100, 8.0)])
        out, _ = run(load(line, ["", ""]))
        self.assertFalse(any(l.startswith("CAPRI_COMMAND") for l in out), out)

    def test_without_the_model_setting_the_whisper_wake_stage_is_unchanged(self):
        calls = {}
        line = Timeline([ROOM, (3000, 1.5), (100, 1.5)])
        out, _ = run(load(line, ["Capri, what time is it"], oww=False, calls=calls))
        self.assertTrue(any(l.startswith("CAPRI_COMMAND") and "what time is it" in l for l in out), out)
        self.assertEqual(calls["recognize"][0]["hint"], "Capri.")

    def test_a_detector_that_cannot_load_falls_back_to_whisper(self):
        class Broken:
            def __init__(self, path): raise ImportError("openwakeword is not installed")
        calls = {}
        line = Timeline([ROOM, (3000, 1.5), (100, 1.5)])
        out, err = run(load(line, ["Capri, what time is it"], detector=Broken, calls=calls))
        self.assertIn("CAPRI_OWW_UNAVAILABLE ImportError", err)
        self.assertTrue(any(l.startswith("CAPRI_COMMAND") for l in out), out)
        self.assertEqual(calls["recognize"][0]["hint"], "Capri.")

    def test_a_score_below_the_threshold_is_not_a_wake(self):
        class Weak(FakeDetector):
            def score(self, block):
                return 0.5 if array.array("h", block)[1] == self.MARK else None
        calls = {}
        out, _ = run(load(Timeline([ROOM, WORD, WORD_END, (2500, 1.2), (100, 1.5)]), ["x"], detector=Weak, calls=calls))
        self.assertEqual(calls["chime"], 0)
        self.assertFalse(any(l.startswith("CAPRI_COMMAND") for l in out), out)

    def test_ready_is_printed_once_before_listening(self):
        out, _ = run(load(Timeline([ROOM, WORD, WORD_END, (3000, 1.0), (100, 1.5)]), ["go"]))
        self.assertEqual(out.count("CAPRI_READY"), 1)
        self.assertEqual(out[0], "CAPRI_READY")


if __name__ == "__main__":
    unittest.main()
