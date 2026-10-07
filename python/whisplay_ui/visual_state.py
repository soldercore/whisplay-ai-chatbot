"""Maps Node's `status` strings to visual states, with the error latch."""
from . import theme

BOOT = "BOOT"
IDLE = "IDLE"
CALIBRATE = "CALIBRATE"
LISTEN = "LISTEN"
TRANSCRIBE = "TRANSCRIBE"
THINK = "THINK"
TOOL = "TOOL"
ANSWER = "ANSWER"
ERROR = "ERROR"
APPROVAL = "APPROVAL"
RESULT = "RESULT"
MUSIC = "MUSIC"
CAMERA = "CAMERA"
GENERIC = "GENERIC"

CONSOLE_STATES = frozenset([ANSWER])


def classify(status):
    s = (status or "").strip().lower()
    if s in ("starting", "hello"):
        return BOOT
    if s == "idle":
        return IDLE
    if s == "detecting":
        return CALIBRATE
    if s == "listening":
        return LISTEN
    if s == "recognizing":
        return TRANSCRIBE
    if s in ("answering...", "thinking"):
        return THINK
    if s == "tool calling":
        return TOOL
    if s == "answering":
        return ANSWER
    if s == "confirm":
        return APPROVAL
    if s in ("allowed", "denied"):
        return RESULT
    if s == "music":
        return MUSIC
    if s == "camera":
        return CAMERA
    if "error" in s or "fail" in s:
        return ERROR
    return GENERIC


class StateTracker:
    """Tracks the current visual state.

    In IM mode Node sends "error" and then "idle" straight away, so ERROR is
    held for theme.ERROR_LATCH seconds unless a non-idle status arrives.
    """

    def __init__(self):
        self.state = None
        self.previous = None
        self.entered_at = 0.0
        self.raw = None
        self.latch_until = -1e9
        self.error_at = -1e9

    def update(self, status, now):
        raw = classify(status)
        if raw == ERROR and self.raw != ERROR:
            self.latch_until = now + theme.ERROR_LATCH
            self.error_at = now
        self.raw = raw
        state = raw
        if raw == IDLE and now < self.latch_until:
            state = ERROR
        elif raw not in (ERROR, IDLE):
            self.latch_until = -1e9
        if state != self.state:
            self.previous = self.state
            self.state = state
            self.entered_at = now
            return True
        return False
