"""Hardware-free preflight, or privacy-safe wrapper for the existing display."""
import ast
import importlib
import json
import os
from pathlib import Path
import runpy
import sys
import signal
import traceback
import threading
import ctypes
from runtime_resources import PYTHON_ROOT, font_path, resource_path

MODULES = ("PIL.Image", "PIL.ImageFont", "numpy", "cairosvg")


def failure(error):
    # Deliberately exclude exception messages, paths, locals and source text.
    allowed = {"ModuleNotFoundError", "ImportError", "FileNotFoundError", "PermissionError",
               "OSError", "RuntimeError", "ValueError", "TypeError", "AttributeError", "SyntaxError"}
    result = {"event": "display_failure", "phase": "startup",
              "error_type": type(error).__name__ if type(error).__name__ in allowed else "Exception"}
    module = getattr(error, "name", None)
    if module and module.split(".")[0] in {"PIL", "numpy", "cairosvg", "gpiod", "spidev", "WhisPlay", "picamera2", "cv2"}:
        result["module"] = module
    known = {"chatbot-ui.py", "utils.py", "whisplay_client.py", "whisplay.py", "fonts.py", "diagnostic_display.py"}
    frames = [f for f in traceback.extract_tb(error.__traceback__) if Path(f.filename).name in known]
    if frames:
        result.update(frame=Path(frames[-1].filename).name, line=frames[-1].lineno)
    return result


def thread_failure(args):
    record = failure(args.exc_value)
    record["phase"] = "runtime"
    print("[Diagnostics] " + json.dumps(record), file=sys.stderr, flush=True)
    # Wake the main thread's installed finally/cleanup path. Never leave a dead
    # renderer thread behind a still-responsive socket server.
    os.kill(os.getpid(), signal.SIGTERM)


def preflight():
    checks = [{"resource": "python_version", "ok": sys.version_info >= (3, 10)}]
    try:
        identity = os.pidfd_open(os.getpid())
        os.close(identity)
        checks.append({"resource": "linux_pidfd", "ok": hasattr(signal, "pidfd_send_signal")})
    except (AttributeError, OSError):
        checks.append({"resource": "linux_pidfd", "ok": False})
    try:
        libc = ctypes.CDLL(None)
        old = ctypes.c_int()
        valid = libc.prctl(37, ctypes.byref(old), 0, 0, 0) == 0
        valid = valid and libc.prctl(36, 1, 0, 0, 0) == 0
        restored = libc.prctl(36, old.value, 0, 0, 0) == 0
        checks.append({"resource": "linux_subreaper", "ok": valid and restored})
    except (AttributeError, OSError):
        checks.append({"resource": "linux_subreaper", "ok": False})
    for name in MODULES:
        try:
            importlib.import_module(name)
            checks.append({"resource": name, "ok": True})
        except Exception as error:
            checks.append({"resource": name, "ok": False, "error_type": type(error).__name__})
    try:
        from PIL import ImageFont
        ImageFont.truetype(str(font_path()), 20)
        checks.append({"resource": "base_font", "ok": True})
    except Exception as error:
        checks.append({"resource": "base_font", "ok": False, "error_type": type(error).__name__})
    emojis = resource_path("emoji_svg")
    checks.append({"resource": "emoji_svg", "ok": emojis.is_dir() and any(emojis.glob("*.svg"))})
    # The archive is an installation source, not an executable runtime requirement.
    checks.append({"resource": "emoji_svg.zip", "ok": resource_path("emoji_svg.zip").is_file(), "optional": True})
    for name in ("chatbot-ui.py", "camera.py", "utils.py", "whisplay_client.py", "whisplay.py"):
        try:
            ast.parse((PYTHON_ROOT / name).read_text())
            checks.append({"resource": name, "ok": True})
        except Exception as error:
            checks.append({"resource": name, "ok": False, "error_type": type(error).__name__})
    if os.environ.get("WHISPLAY_UI", "terminal") != "classic":
        for name in ("whisplay_ui/__init__.py", "whisplay_ui/renderer.py"):
            checks.append({"resource": name, "ok": (PYTHON_ROOT / name).is_file()})
        for name in ("JetBrainsMono-Medium.ttf", "JetBrainsMono-SemiBold.ttf", "Silkscreen-Regular.ttf"):
            try:
                from PIL import ImageFont
                ImageFont.truetype(str(PYTHON_ROOT / "fonts" / name), 14)
                checks.append({"resource": name, "ok": True})
            except Exception as error:
                checks.append({"resource": name, "ok": False, "error_type": type(error).__name__})
    daemon = Path("/tmp/whisplay-daemon.sock").is_socket()
    if not daemon:
        for name in ("spidev", "gpiod"):
            try:
                importlib.import_module(name)  # Import only: no board instance/GPIO opening.
                checks.append({"resource": name, "ok": True})
            except Exception as error:
                checks.append({"resource": name, "ok": False, "error_type": type(error).__name__})
    return {"kind": "display_preflight", "ok": all(c["ok"] or c.get("optional") for c in checks),
            "checks": checks, "daemon_observed": daemon, "hardware_initialized": False,
            "hardware_startup_guaranteed": False, "python_version": list(sys.version_info[:3])}


if __name__ == "__main__":
    if sys.argv[1:] == ["--preflight"]:
        result = preflight()
        print(json.dumps(result), flush=True)
        sys.exit(0 if result["ok"] else 1)
    try:
        threading.excepthook = thread_failure
        runpy.run_path(str(PYTHON_ROOT / "chatbot-ui.py"), run_name="__main__")
    except SystemExit:
        raise
    except BaseException as error:
        print("[Diagnostics] " + json.dumps(failure(error)), file=sys.stderr, flush=True)
        sys.exit(1)
