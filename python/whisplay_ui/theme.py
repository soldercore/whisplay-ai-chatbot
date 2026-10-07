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

# ---- Safe area: rounded LCD corners ---------------------------------------
# Identical in soldercore/Whisplay daemon/cyber_ui/theme.py and
# soldercore/whisplay-ai-chatbot python/whisplay_ui/theme.py; keep in sync.
# The Whisplay panel has rounded corners (radius about 40 px). Status-bar
# content stays between STATUS_SAFE_LEFT and STATUS_SAFE_RIGHT on the
# STATUS_CENTER_Y line, and content that runs to the side margins ends above
# CONTENT_SAFE_BOTTOM, so nothing reaches the curve even for a 44 px radius
# (SAFE_CHECK_RADIUS, enforced by the tests in both repos).
SCREEN_CORNER_RADIUS = 40
SAFE_CHECK_RADIUS = 44
STATUS_SAFE_LEFT = 24     # first usable column
STATUS_SAFE_RIGHT = 216   # last usable column (inclusive), = WIDTH - 24
STATUS_CENTER_Y = 13      # centre line of badge, labels, battery and Wi-Fi
STATUS_H = 27             # status bar rows 0..25 plus the divider row 26
DIVIDER_Y = 26
PANE_Y = 27               # content top: first row under the status bar
CONTENT_SAFE_BOTTOM = 264 # = HEIGHT - 16

STAGE_H = 104             # stage image: visual rows 0..79, caption rows 80..103 (pane coords)
STAGE_VISUAL_H = 80
STAGE_MID_Y = 40          # visual centre line (pane coords)
CAPTION_MID_Y = 93        # caption centre line (pane coords)
BODY_TOP_STAGE = PANE_Y + STAGE_H
BODY_TOP_CONSOLE = PANE_Y + 26     # 26 px answer strip
BODY_TOP_TERMINAL = PANE_Y + 71    # 71 px command-output pane
STRIP_MID_Y = 12          # strip centre line (pane coords)
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
