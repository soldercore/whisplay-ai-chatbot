"""HTTP/SDK contracts only: no installed Hailo runtime, hardware or real model."""
import base64
from pathlib import Path
import runpy
import sys
import tempfile
from types import ModuleType, SimpleNamespace
import unittest
from unittest.mock import Mock, patch
import wave
import numpy as np  # Keep imports stable across the isolated SDK module contexts.

HOST = Path(__file__).resolve().parents[1] / "speech-service/hailo-whisper-host.py"


class HailoHostContract(unittest.TestCase):
    def load(self, payload=None, available=True):
        routes = {}
        flask = ModuleType("flask")

        class App:
            def __init__(self, _name):
                pass

            def route(self, name, methods):
                def register(handler):
                    routes[(name, tuple(methods))] = handler
                    return handler
                return register

        flask.Flask = App
        flask.jsonify = lambda value: value
        flask.request = SimpleNamespace(get_json=lambda **_kwargs: payload)
        modules = {"flask": flask}
        model = Mock()
        model.generate_all_segments.return_value = [SimpleNamespace(text=" GLaDOS heard you.")]
        if available:
            for name in ("hailo_platform", "hailo_platform.genai", "hailo_apps",
                         "hailo_apps.python", "hailo_apps.python.core",
                         "hailo_apps.python.core.common", "hailo_apps.python.core.common.core",
                         "hailo_apps.python.core.common.defines"):
                modules[name] = ModuleType(name)
                modules[name].__path__ = []
            device = Mock()
            device.create_params.return_value = SimpleNamespace()
            modules["hailo_platform"].VDevice = device
            modules["hailo_platform.genai"].Speech2Text = Mock(return_value=model)
            modules["hailo_platform.genai"].Speech2TextTask = SimpleNamespace(TRANSCRIBE="transcribe")
            modules["hailo_apps.python.core.common.core"].resolve_hef_path = Mock(return_value="fixture.hef")
            constants = modules["hailo_apps.python.core.common.defines"]
            constants.HAILO10H_ARCH = "hailo10h"
            constants.SHARED_VDEVICE_GROUP_ID = "fixture"
            constants.WHISPER_CHAT_APP = "whisper_chat"
        else:
            modules["hailo_platform"] = None
        with patch.dict(sys.modules, modules), patch.object(sys, "argv", ["host", "--host", "127.0.0.1"]):
            runpy.run_path(str(HOST), run_name="test_host")
        return routes, model

    def audio(self, path):
        with wave.open(str(path), "wb") as audio:
            audio.setnchannels(1)
            audio.setsampwidth(2)
            audio.setframerate(16000)
            audio.writeframes(b"\x00\x10" * 160)

    def test_missing_sdk_is_not_ready_and_never_returns_a_successful_empty_transcript(self):
        routes, model = self.load({"filePath": "not-opened.wav"}, available=False)
        health, code = routes[("/health", ("GET",))]()
        self.assertEqual(code, 503)
        self.assertFalse(health["model_loaded"])
        self.assertEqual(routes[("/recognize", ("POST",))]()[1], 503)
        model.generate_all_segments.assert_not_called()

    def test_loaded_model_is_ready_and_receives_real_pcm_and_language(self):
        with tempfile.TemporaryDirectory() as root:
            audio = Path(root) / "original.wav"
            self.audio(audio)
            routes, model = self.load({"filePath": str(audio), "language": "en"})
            self.assertEqual(routes[("/health", ("GET",))]()[1], 200)
            response = routes[("/recognize", ("POST",))]()
            self.assertEqual(response["recognition"], "GLaDOS heard you.")
            args = model.generate_all_segments.call_args.kwargs
            self.assertEqual(args["language"], "en")
            self.assertEqual(args["task"], "transcribe")
            self.assertEqual(args["audio_data"].shape, (160,))
            self.assertAlmostEqual(float(args["audio_data"][0]), 0.125)
            self.assertTrue(audio.exists())

    def test_base64_only_removes_its_temporary_audio(self):
        with tempfile.TemporaryDirectory() as root:
            audio = Path(root) / "original.wav"
            self.audio(audio)
            routes, _model = self.load({"base64": base64.b64encode(audio.read_bytes()).decode()})
            created = []
            original = tempfile.mkstemp

            def tracked(*args, **kwargs):
                fd, name = original(*args, **kwargs, dir=root)
                created.append(Path(name))
                return fd, name

            with patch("tempfile.mkstemp", side_effect=tracked):
                self.assertEqual(routes[("/recognize", ("POST",))]()["recognition"], "GLaDOS heard you.")
            self.assertTrue(audio.exists())
            self.assertTrue(created)
            self.assertTrue(all(not path.exists() for path in created))

    def test_missing_audio_and_sdk_failures_are_explicit_without_fake_success(self):
        routes, model = self.load({})
        self.assertEqual(routes[("/recognize", ("POST",))]()[1], 400)
        model.generate_all_segments.assert_not_called()
        with tempfile.TemporaryDirectory() as root:
            audio = Path(root) / "audio.wav"
            self.audio(audio)
            routes, model = self.load({"filePath": str(audio)})
            model.generate_all_segments.side_effect = RuntimeError("fixture SDK failure")
            response, status = routes[("/recognize", ("POST",))]()
            self.assertEqual(status, 500)
            self.assertNotIn("recognition", response)
            self.assertTrue(audio.exists())


if __name__ == "__main__":
    unittest.main()
