"""Wrapper integration contracts; no Flask installation, model or audio device.

Execute both real route handlers with Flask request/response and WhisperModel
test doubles. This verifies forwarding, not acoustic recognition accuracy.
"""
import base64
import os
from pathlib import Path
import runpy
from types import ModuleType, SimpleNamespace
import unittest
from unittest.mock import Mock, patch

ROOT = Path(__file__).resolve().parents[2]
HOSTS = [ROOT / "python/speech-service/faster-whisper-host.py",
         ROOT / "docker/faster-whisper-http/faster-whisper-host.py"]


class HostContract(unittest.TestCase):
    def invoke(self, host, payload, texts=(" GLaDOS, can you hear me?",)):
        routes = {}
        flask = ModuleType("flask")

        class App:
            def __init__(self, _name):
                pass

            def route(self, path, methods):
                self.assert_route = (path, methods)

                def register(handler):
                    routes[(path, tuple(methods))] = handler
                    return handler
                return register

        flask.Flask = App
        flask.request = SimpleNamespace(get_json=lambda **_kwargs: payload)
        flask.jsonify = lambda value: value
        whisper = ModuleType("faster_whisper")
        model = Mock()
        model.transcribe.return_value = ([SimpleNamespace(text=text) for text in texts],
                                         SimpleNamespace(language="en"))
        whisper.WhisperModel = Mock(return_value=model)
        with patch.dict("sys.modules", {"flask": flask, "faster_whisper": whisper}):
            runpy.run_path(str(host), run_name="test_host")
            response = routes[("/recognize", ("POST",))]()
        return response, model

    def test_initial_prompt_reaches_actual_model_call(self):
        for host in HOSTS:
            with self.subTest(host=host):
                response, model = self.invoke(host, {
                    "filePath": "fixture.wav", "language": "en", "initial_prompt": "GLaDOS"})
                self.assertEqual(response["recognition"], "GLaDOS, can you hear me?")
                model.transcribe.assert_called_once_with("fixture.wav", language="en",
                                                          vad_filter=True, initial_prompt="GLaDOS")
                self.assertEqual(response["language"], "en")
                self.assertIsInstance(response["time_cost"], (int, float))

    def test_legacy_requests_have_no_hint(self):
        for host in HOSTS:
            with self.subTest(host=host):
                response, model = self.invoke(host, {"filePath": "fixture.wav", "language": "en"})
                self.assertEqual(response["recognition"], "GLaDOS, can you hear me?")
                self.assertIsNone(model.transcribe.call_args.kwargs.get("initial_prompt"))
                self.assertIsNone(model.transcribe.call_args.kwargs.get("hotwords"))

    def test_text_and_internal_segments_are_never_normalized(self):
        examples = [
            (" GLaDOS, can you hear me?",),
            (" Gladdles, can you hear me?",),
            (" Gladles?",),
            (" What is the weather?",),
            (" I meant to say gladdles, not gladles.",),
            (' She said "Gladdles, can you hear me?"',),
            (" First sentence.", " Gladdles, can you hear me?"),
        ]
        for host in HOSTS:
            for texts in examples:
                with self.subTest(host=host, texts=texts):
                    response, model = self.invoke(host, {"filePath": "fixture.wav", "language": "en",
                                                        "initial_prompt": "GLaDOS"}, texts)
                    self.assertEqual(response["recognition"], "".join(texts).strip())
                    self.assertEqual(model.transcribe.call_args.kwargs.get("initial_prompt"), "GLaDOS")

    def test_base64_path_forwards_hint_and_removes_only_temporary_audio(self):
        for host in HOSTS:
            with self.subTest(host=host):
                response, model = self.invoke(host, {"base64": base64.b64encode(b"fixture audio").decode(),
                                                    "language": "en", "initial_prompt": "GLaDOS"})
                self.assertEqual(response["language"], "en")
                self.assertEqual(model.transcribe.call_args.kwargs.get("initial_prompt"), "GLaDOS")
                audio_path = model.transcribe.call_args.args[0]
                self.assertFalse(os.path.exists(audio_path))

    def test_invalid_prompt_is_rejected_before_model_call(self):
        for host in HOSTS:
            for value in [12, [], {}, True]:
                with self.subTest(host=host, value=value):
                    response, model = self.invoke(host, {"filePath": "fixture.wav", "initial_prompt": value})
                    self.assertEqual(response, ({"error": "initial_prompt must be a string"}, 400))
                    model.transcribe.assert_not_called()

    def test_empty_or_null_prompt_disables_hint(self):
        for host in HOSTS:
            for value in ["", None]:
                with self.subTest(host=host, value=value):
                    _, model = self.invoke(host, {"filePath": "fixture.wav", "initial_prompt": value})
                    self.assertIsNone(model.transcribe.call_args.kwargs.get("initial_prompt") or None)

    def test_missing_audio_preserves_existing_error(self):
        for host in HOSTS:
            with self.subTest(host=host):
                response, model = self.invoke(host, {"initial_prompt": "GLaDOS"})
                self.assertEqual(response, ({"error": "Either filePath or base64 must be provided"}, 400))
                model.transcribe.assert_not_called()


if __name__ == "__main__":
    unittest.main()
