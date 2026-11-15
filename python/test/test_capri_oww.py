"""capri_wake.py with the optional openWakeWord detector (CAPRI_OWW_MODEL), against a scripted microphone. No audio device, no model.

  python3 -m unittest python/test/test_capri_oww.py -v
"""
import array, contextlib, importlib.util, io, os, queue, random, sys, tempfile, time, unittest, wave
from pathlib import Path

SCRIPT = Path(__file__).resolve().parent.parent / "capri_wake.py"
FRAME = 640


def frame(amp, dc=0):
    """One 20 ms frame whose AC rms is `amp` (a square wave) on top of a DC offset."""
    return array.array("h", [dc + (amp if i % 2 else -amp) for i in range(FRAME // 2)]).tobytes()


class Timeline:
    """seconds of (amplitude, seconds) segments, played as 20 ms frames with a simulated clock."""
    def __init__(self, segments):
        self.frames = []
        rng = random.Random(5)
        for amp, seconds, *wander in segments:
            for _ in range(round(seconds / 0.02)):
                # wander=(low, high): the frame mean moves like the real microphone's (DC offset plus rumble)
                self.frames.append(frame(amp, rng.randint(*wander[0]) if wander else 0))
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

    @staticmethod
    def is_mark(block):
        values = array.array("h", block)
        return values[1] - values[0] == 2 * FakeDetector.MARK        # the amplitude, whatever the DC offset

    def score(self, block):
        return 0.95 if self.is_mark(block) else None


def load(timeline, recognized, oww=True, detector=FakeDetector, calls=None, diagnostics=False, env_extra=None):
    env = dict(os.environ)
    for key in ("CAPRI_OWW_MODEL", "CAPRI_OWW_THRESHOLD"):
        os.environ.pop(key, None)
    if oww:
        os.environ["CAPRI_OWW_MODEL"] = "capri.onnx"
    os.environ["CAPRI_DIAGNOSTICS"] = "1" if diagnostics else "0"
    os.environ.update(env_extra or {})
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

    module.real_recognize = module.recognize

    def recognize(raw, file, hint=None):
        if not raw: return ""                      # the real one returns at once, without a request
        calls["recognize"].append(dict(seconds=len(raw) / 32000, hint=hint, first_amp=array.array("h", raw[:FRAME])[1]))
        if len(raw) / 32000 < 1.3: return ""        # the end of the wake word alone: Whisper finds no speech in it
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
        line = Timeline([ROOM, WORD, WORD_END, (3000, 0.1), (100, 1.6), (3000, 1.0), (100, 1.5)])   # the word still sounds for a moment after the detection
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
        self.assertEqual([r for r in calls["recognize"] if r["seconds"] > 0.5], [], "no Whisper request without speech")

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

    def test_a_bare_wake_word_chimes_at_once_even_if_there_is_sound_later(self):
        """The live failure: the user says "Capri", hears nothing, and says it again; the first one must already have chimed."""
        calls = {}
        line = Timeline([ROOM, WORD, WORD_END, (3000, 0.1), (100, 0.9), (3000, 4.0), (100, 1.5)])   # a second utterance 1 s later
        module = load(line, ["", "what is this"], calls=calls)
        when = {}
        original = module.chime
        def chime():
            when.setdefault("clock", line.clock)
            return original()
        module.chime = chime
        run(module)
        detected_at = 1000.0 + (round(1.0 / 0.02) + round(0.4 / 0.02) + 1) * 0.02
        self.assertEqual(calls["chime"], 1)
        self.assertLess(when["clock"] - detected_at, 0.9, "the chime comes within the half-second look, not after the later sound")

    def test_a_bare_wake_word_chimes_even_when_the_room_never_goes_quiet(self):
        """The live failure: recording for the command never ended (sound above the end-of-speech level for 15 s) and no chime came."""
        calls = {}
        line = Timeline([ROOM, WORD, WORD_END, (200, 20.0)])      # room noise 100; 200 is above the end gate (170) but not speech
        module = load(line, [], calls=calls)
        when = {}
        original = module.chime
        def chime():
            when.setdefault("clock", line.clock)
            return original()
        module.chime = chime
        run(module)
        detected_at = 1000.0 + (round(1.0 / 0.02) + round(0.4 / 0.02) + 1) * 0.02
        self.assertEqual(calls["chime"], 1)
        self.assertLess(when["clock"] - detected_at, 0.9)

    def test_speech_that_starts_while_the_chime_plays_is_kept(self):
        """The reported failure: "Capri", the chime, and the user starts speaking before the chime has finished."""
        calls = {}
        # detection, 0.5 s look (silence), the chime starts: 0.2 s of chime alone, then speech over the rest of the chime and beyond
        line = Timeline([ROOM, WORD, WORD_END, (100, 0.5), (1000, 0.2), (2500, 1.4), (100, 1.5)])
        out, _ = run(load(line, ["what time is it"], calls=calls))
        self.assertTrue(any(l.startswith("CAPRI_COMMAND") and "what time is it" in l for l in out), out)
        self.assertEqual(len(calls["recognize"]), 1)
        self.assertGreaterEqual(calls["recognize"][0]["seconds"], 2.1, "the words spoken during the chime are in the audio")

    def test_the_chime_alone_is_never_a_command(self):
        calls = {}
        line = Timeline([ROOM, WORD, WORD_END, (100, 0.5), (1000, 0.36), (100, 8.0)])
        out, _ = run(load(line, ["thank you so much"], calls=calls))
        self.assertFalse(any(l.startswith("CAPRI_COMMAND") for l in out), out)
        self.assertEqual(calls["recognize"], [], "nothing but the chime: Whisper is not asked")
        self.assertIn("CAPRI_IDLE", out)

    def test_a_blip_after_the_chime_is_not_sent_to_whisper(self):
        calls = {}
        line = Timeline([ROOM, WORD, WORD_END, (100, 0.5), (1000, 0.36), (100, 0.2), (2500, 0.2), (100, 8.0)])
        out, _ = run(load(line, ["thank you so much"], calls=calls))
        self.assertFalse(any(l.startswith("CAPRI_COMMAND") for l in out), out)
        self.assertEqual(calls["recognize"], [])

    def test_a_room_whose_dc_offset_wanders_does_not_keep_the_capture_open(self):
        """The measured live failure: 28 of 34 captures never ended, because the microphone's DC offset and rumble (frame mean moving
        between about -300 and +1000) counted as sound above the end-of-speech level. Real silence in the room is quiet (AC 90)."""
        wander = ((-300, 900),)
        calls = {}
        line = Timeline([(90, 1.0, *wander), (3000, 0.4, *wander), WORD_END + wander, (2500, 1.2, *wander), (90, 4.0, *wander)])
        out, _ = run(load(line, ["what time is it"], calls=calls))
        self.assertTrue(any(l.startswith("CAPRI_COMMAND") and "what time is it" in l for l in out), out)

    def test_diagnostic_lines_carry_the_wall_clock_and_the_whole_timeline(self):
        calls = {}
        line = Timeline([ROOM, WORD, WORD_END, (100, 0.5), (1000, 0.2), (2500, 1.4), (100, 1.5)])
        _, err = run(load(line, ["what time is it"], calls=calls, diagnostics=True))
        events = [l.split()[1] for l in err.splitlines() if l.startswith("CAPRI_DIAG")]
        for needed in ("detector", "listening", "oww_detect", "oww_bare", "chime", "command_out"):
            self.assertIn(needed, events, events)
        self.assertTrue(all(" ts=" in l for l in err.splitlines() if l.startswith("CAPRI_DIAG")), "every line has a timestamp")

    def test_a_half_heard_wake_word_is_logged_as_a_near_miss_with_its_score(self):
        class Near(FakeDetector):
            def score(self, block):
                values = array.array("h", block)
                if values[1] - values[0] == 2 * 2000: return 0.2          # rises, never reaches 0.3
                result = super().score(block)
                return 0.0 if result is None else result
        line = Timeline([ROOM, (2000, 0.3), ROOM, WORD, WORD_END, (2500, 1.2), (100, 1.5)])
        _, err = run(load(line, ["what time is it"], detector=Near, diagnostics=True))
        near = [l for l in err.splitlines() if l.startswith("CAPRI_DIAG oww_near")]
        self.assertEqual(len(near), 1, err)
        self.assertIn("max=0.2", near[0])

    def _real_recognize(self, module, env_dir=None):
        class Reply:
            def __enter__(self): return self
            def __exit__(self, *a): return False
            def read(self, *a): return b'{"recognition": "what time is it"}'
        class Opener:
            def open(self, request, timeout=0): return Reply()
        module.urllib.request.build_opener = lambda *a: Opener()
        module.recognize = module.real_recognize
        return module

    def test_audio_copies_are_opt_in_private_and_limited(self):
        import stat
        with tempfile.TemporaryDirectory() as d:
            target = Path(d) / "clips"
            module = self._real_recognize(load(Timeline([ROOM]), [], env_extra={"CAPRI_SAVE_AUDIO_DIR": str(target), "CAPRI_SAVE_AUDIO_KEEP": "3"}))
            for i in range(6):
                self.assertEqual(module.recognize(frame(2500) * 40, Path(d) / "work.wav"), "what time is it")
                time.sleep(0.003)
            files = sorted(target.glob("clip-*.wav"))
            self.assertEqual(len(files), 3, "only the newest three are kept")
            if os.name == "posix":
                self.assertEqual(stat.S_IMODE(target.stat().st_mode), 0o700)
                self.assertEqual(stat.S_IMODE(files[0].stat().st_mode), 0o600)
            with wave.open(str(files[0]), "rb") as w:
                self.assertEqual((w.getnchannels(), w.getsampwidth(), w.getframerate()), (1, 2, 16000))
            off = Path(d) / "off"
            module = self._real_recognize(load(Timeline([ROOM]), []))
            module.recognize(frame(2500) * 40, Path(d) / "work.wav")
            self.assertFalse(off.exists())
            self.assertEqual(list(Path(d).glob("**/clip-*.wav")), files, "nothing is saved unless the setting is present")

    def test_a_folder_that_cannot_be_written_never_breaks_recognition(self):
        with tempfile.TemporaryDirectory() as d:
            blocker = Path(d) / "file"
            blocker.write_text("x")
            module = self._real_recognize(load(Timeline([ROOM]), [], env_extra={"CAPRI_SAVE_AUDIO_DIR": str(blocker / "sub")}))
            self.assertEqual(module.recognize(frame(2500) * 40, Path(d) / "work.wav"), "what time is it")

    def test_a_soft_command_right_behind_the_wake_word_is_kept(self):
        calls = {}
        line = Timeline([ROOM, WORD, WORD_END, (400, 1.2), (100, 1.5)])      # soft (quiet room: noise 100, gate 200)
        out, _ = run(load(line, ["what time is it"], calls=calls))
        self.assertEqual(calls["chime"], 0)
        self.assertTrue(any(l.startswith("CAPRI_COMMAND") for l in out), out)

    def test_a_score_below_the_threshold_is_not_a_wake(self):
        class Weak(FakeDetector):
            def score(self, block):
                return 0.5 if self.is_mark(block) else None
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
