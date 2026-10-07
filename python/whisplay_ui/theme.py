"""Design tokens for the terminal UI: palette, layout, timing and env flags.

Every colour is RGB565-exact: each 8-bit channel is the bit-replicated 5/6-bit
value, so the truncating RGB888 -> RGB565 conversion leaves it unchanged.
"""
import os


def _hex(value):
    value = value.lstrip("#")
    return (int(value[0:2], 16), int(value[2:4], 16), int(value[4:6], 16))


# ---- Palette -------------------------------------------------------------
VOID = _hex("000000")
RAISED = _hex("080C08")
PANEL = _hex("101810")
LINE = _hex("182821")
DIM = _hex("5A6D5A")
MUTED = _hex("9CAA9C")
TEXT = _hex("E7F7DE")
BRIGHT = _hex("FFFFFF")
GREEN = _hex("4AEB7B")
GREEN_MID = _hex("29A24A")
GREEN_DIM = _hex("186931")
GREEN_DEEP = _hex("083018")
CYAN = _hex("5ACBDE")
CYAN_DIM = _hex("215152")
AMBER = _hex("FFB231")
AMBER_MID = _hex("B57D21")
AMBER_DIM = _hex("634510")
RED = _hex("FF5952")
RED_DIM = _hex("521818")

# ---- Layout (absolute pixels unless noted) -------------------------------
WIDTH = 240
HEIGHT = 280
STATUS_H = 23             # status bar rows 0..21 plus the divider row 22
DIVIDER_Y = 22
PANE_Y = 23               # first row of the stage / strip pane
STAGE_H = 104             # stage image: visual rows 0..79, caption rows 80..103 (pane coords)
STAGE_VISUAL_H = 80
STAGE_MID_Y = 40          # visual centre line (absolute y=63)
CAPTION_MID_Y = 93        # caption centre line (absolute y=116)
BODY_TOP_STAGE = 127
BODY_TOP_CONSOLE = 49
BODY_TOP_TERMINAL = 94
STRIP_MID_Y = 12          # strip centre line (absolute y=35)
CHROME_LEFT = 14
CHROME_RIGHT = 226
TEXT_LEFT = 12
TEXT_WIDTH = 216          # 24 cells of 9 px
LINE_H = 20
BASELINE = 15             # baseline offset inside a 20 px line
BODY_PAD = 6
APPROVAL_H = 38
CURSOR_W = 8
CURSOR_H = 15
CURSOR_DY = 3
CURSOR_RIGHT_LIMIT = 229

# ---- Timing (seconds) ----------------------------------------------------
CROSSFADE = 0.18
MORPH = 0.22
LED_LERP = 0.15
TEXT_FADE = 0.12
TAG_FADE = 0.12
DECODE_BASE = 0.06
DECODE_STAGGER = 0.012
BLINK_PERIOD = 1.06
BLINK_ON = 0.53
BLINK_EDGE = 0.06
WRITING_WINDOW = 0.7
WAITING_WINDOW = 1.5
DONE_OUTLINE = 0.4
PHOSPHOR = 0.15
ERROR_LATCH = 4.0
ERROR_LED_BLINK = 5.0
KEYFRAME_INTERVAL = 10.0
MAX_FRAME_DT = 0.066

# Typewriter
TW_BASE_CPS = 55.0
TW_MAX_CPS = 480.0
TW_CATCHUP = 0.35
TW_HOLD = 0.3
TW_HOLD_CHARS = 12
ECHO_CPS = 120.0

# Scrolling
FOLLOW_TAU = 0.12
AUTO_SCROLL_PX = 15.0

# Frame rates per visual state (frames per second; 0 = static)
STATE_FPS = {
    "BOOT": 8,
    "IDLE": 0,
    "CALIBRATE": 20,
    "LISTEN": 30,
    "TRANSCRIBE": 20,
    "THINK": 20,
    "TOOL": 20,
    "ANSWER": 0,
    "ERROR": 10,
    "APPROVAL": 0,
    "RESULT": 0,
    "MUSIC": 12,
    "CAMERA": 3,
    "GENERIC": 3,
}
RAIN_FPS = 8
SPEAKING_FPS = 24

# Adaptive quality thresholds (milliseconds of render time, EMA)
DEGRADE_1_MS = 12.0
DEGRADE_2_MS = 25.0
RECOVER_MS = 6.0


def _env_bool(env, key, default):
    raw = env.get(key)
    if raw is None or str(raw).strip() == "":
        return default
    return str(raw).strip().lower() in ("1", "true", "yes", "on")


def _env_int(env, key, default, low, high):
    try:
        value = int(str(env.get(key, default)).strip())
    except (TypeError, ValueError):
        value = default
    return max(low, min(high, value))


class Flags:
    """Feature toggles read from the environment (D2, D3, D4, D1 in the spec)."""

    def __init__(self, env=None):
        env = os.environ if env is None else env
        self.rain = _env_bool(env, "WHISPLAY_UI_RAIN", True)
        self.scanlines = _env_bool(env, "WHISPLAY_UI_SCANLINES", True)
        self.decode = _env_bool(env, "WHISPLAY_UI_DECODE", True)
        self.speech_focus = _env_bool(env, "WHISPLAY_UI_SPEECH_FOCUS", True)
        emoji = str(env.get("WHISPLAY_UI_EMOJI", "strip") or "strip").strip().lower()
        self.emoji = emoji if emoji in ("strip", "off") else "strip"
        self.fps_cap = _env_int(env, "WHISPLAY_UI_FPS", 30, 5, 30)
        self.debug = _env_bool(env, "WHISPLAY_UI_DEBUG", False)
