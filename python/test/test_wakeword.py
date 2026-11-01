"""Exercise the real wake host with a fake model/recorder, never a microphone."""
import io
import os
from pathlib import Path
import runpy
import subprocess
import sys
from types import ModuleType
import unittest
from unittest.mock import Mock, patch
import numpy as np  # Keep imports stable across isolated model module contexts.

HOST = Path(__file__).resolve().parents[1] / "wakeword.py"


class WakeHostContract(unittest.TestCase):
    def load(self):
        package = ModuleType("openwakeword")
        module = ModuleType("openwakeword.model")
        module.Model = Mock(return_value=Mock(predict=lambda _audio: {"hey_jarvis": 0.9}))
        with patch.dict(sys.modules, {"openwakeword": package, "openwakeword.model": module}):
            return runpy.run_path(str(HOST), run_name="test_wake_host")

    def test_device_precedence_matches_capture_configuration(self):
        host = self.load()
        cases = [
            ({"WAKE_WORD_ALSA_DEVICE": "wake", "ALSA_INPUT_DEVICE": "capture"}, "wake"),
            ({"ALSA_INPUT_DEVICE": "capture"}, "capture"),
            ({"SOUND_CARD_NAME": "whisplaysound"}, "hw:whisplaysound,0"),
            ({"SOUND_CARD_INDEX": "2"}, "hw:2,0"),
        ]
        for env, expected in cases:
            with self.subTest(env=env), patch.dict(os.environ, env, clear=True):
                self.assertEqual(host["detect_alsa_input_device"](), expected)

    def test_automatic_card_detection_and_missing_cards_fallback(self):
        host = self.load()
        with patch.dict(os.environ, {}, clear=True), \
             patch("builtins.open", return_value=io.StringIO(" 1 [es8389soundcard ]: fixture\n")):
            self.assertEqual(host["detect_alsa_input_device"](), "hw:es8389soundcard,0")
        with patch.dict(os.environ, {}, clear=True), patch("builtins.open", side_effect=OSError):
            self.assertEqual(host["detect_alsa_input_device"](), "default")

    def test_recorder_exits_before_wake_line_even_when_term_requires_kill(self):
        for stubborn in (False, True):
            with self.subTest(stubborn=stubborn):
                host = self.load()
                events = []
                recorder = Mock()
                recorder.stdout = io.BytesIO(b"\x00\x10" * 1280)
                recorder.stderr = io.BytesIO()
                recorder.returncode = None
                recorder.poll.side_effect = lambda: recorder.returncode
                recorder.terminate.side_effect = lambda: events.append("terminate")
                recorder.kill.side_effect = lambda: events.append("kill")

                def wait(timeout):
                    events.append("wait")
                    if stubborn and "kill" not in events:
                        raise subprocess.TimeoutExpired("fixture-sox", timeout)
                    recorder.returncode = 0

                recorder.wait.side_effect = wait

                def output(*args, **_kwargs):
                    if args and str(args[0]).startswith("WAKE "):
                        self.assertIsNotNone(recorder.returncode)
                        events.append("wake")

                with patch.dict(os.environ, {"WAKE_WORD_ALSA_DEVICE": "hw:fixture,0"}, clear=True), \
                     patch("subprocess.Popen", return_value=recorder) as start, \
                     patch("signal.signal"), patch("builtins.print", side_effect=output):
                    host["main"]()
                self.assertEqual(events, ["terminate", "wait", "kill", "wait", "wake"]
                                 if stubborn else ["terminate", "wait", "wake"])
                self.assertIn("hw:fixture,0", start.call_args.args[0])

    def test_capture_failure_exits_with_error_instead_of_looping_without_audio(self):
        host = self.load()
        recorder = Mock(stdout=io.BytesIO(), stderr=io.BytesIO(b"fixture device busy"), returncode=1)
        recorder.poll.return_value = 1
        with patch.dict(os.environ, {"WAKE_WORD_ALSA_DEVICE": "fixture"}, clear=True), \
             patch("subprocess.Popen", return_value=recorder), patch("signal.signal"), \
             patch("builtins.print"), self.assertRaises(SystemExit) as result:
            host["main"]()
        self.assertEqual(result.exception.code, 1)


if __name__ == "__main__":
    unittest.main()
