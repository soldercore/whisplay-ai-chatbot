"""Read-only resource discovery. Never imports a hardware driver."""
import os
from pathlib import Path

PYTHON_ROOT = Path(__file__).resolve().parent


def resource_path(name):
    candidate = Path(name)
    if candidate.is_absolute():
        return candidate
    roots = [PYTHON_ROOT]
    runtime = os.environ.get("WHISPLAY_DIAGNOSTIC_RUNTIME_DIR")
    if os.environ.get("WHISPLAY_LATENCY_DIAGNOSTICS") == "true" and runtime and Path(runtime).is_absolute():
        roots.append(Path(runtime) / "python")
    for root in roots:
        target = root / candidate
        if target.exists():
            return target
    return roots[0] / candidate


def font_path():
    return resource_path(os.environ.get("CUSTOM_FONT_PATH") or "NotoSansSC-Bold.ttf")
