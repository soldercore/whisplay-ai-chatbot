"""Design tokens for the terminal UI: palette, layout, timing and env flags.

Every colour is RGB565-exact: each 8-bit channel is the bit-replicated 5/6-bit
value, so the truncating RGB888 -> RGB565 conversion leaves it unchanged.
"""
import os


def _hex(value):
    value = value.lstrip("#")
    return (int(value[0:2], 16), int(value[2:4], 16), int(value[4:6], 16))


# ---- Palette -------------------------------------------------------------
# One warm neutral ramp and a single accent (the optic's light). Amber is used only for what is
# live or needs attention; nothing else is coloured. Old token names stay as aliases so every
# scene keeps working; they now point into this ramp.
def _q(r, g, b):
    """Snap to the nearest-below RGB565-exact value (bit-replicated channels)."""
    r5, g6, b5 = r >> 3, g >> 2, b >> 3
    return ((r5 << 3) | (r5 >> 2), (g6 << 2) | (g6 >> 4), (b5 << 3) | (b5 >> 2))


VOID = (0, 0, 0)               # true black: it must disappear into the bezel of the LCD
HAIR = _q(40, 36, 32)          # hairlines
INK = _q(238, 231, 220)        # primary text
INK2 = _q(170, 162, 150)       # secondary text
INK3 = _q(134, 127, 116)       # tertiary text (>= 4.5:1 on VOID)
TICK = _q(70, 64, 58)          # decorative marks only (idle dial ticks)
ACCENT = _q(255, 160, 32)      # the optic
ACCENT_MID = _q(190, 118, 24)
ACCENT_DIM = _q(106, 66, 16)
ACCENT_DEEP = _q(46, 29, 9)
ALERT = _q(255, 90, 74)
ALERT_DIM = _q(104, 34, 28)
WHITE = _q(255, 255, 255)

RAISED = _q(18, 15, 12)
PANEL = _q(24, 20, 16)
LINE = HAIR
DIM = INK3
MUTED = INK2
TEXT = INK
BRIGHT = WHITE
GREEN = ACCENT
GREEN_MID = ACCENT_MID
GREEN_DIM = ACCENT_DIM
GREEN_DEEP = ACCENT_DEEP
AMBER = ACCENT
AMBER_MID = ACCENT_MID
AMBER_DIM = ACCENT_DIM
CYAN = INK2
CYAN_DIM = INK3
RED = ALERT
RED_DIM = ALERT_DIM

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
DECODE_BASE = 0.07
DECODE_STAGGER = 0.016
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
    "CALIBRATE": 12,
    "LISTEN": 12,
    "TRANSCRIBE": 12,
    "THINK": 12,
    "TOOL": 12,
    "ANSWER": 0,
    "ERROR": 10,
    "APPROVAL": 0,
    "RESULT": 0,
    "MUSIC": 12,
    "CAMERA": 3,
    "GENERIC": 3,
}
RAIN_FPS = 8
SPEAKING_FPS = 20
OPTIC_FPS = 20            # steady optic animation (listening, recognizing, thinking)
OPTIC_SETTLE_FPS = 30     # while the shutter is moving between poses (a few tenths of a second)

# Adaptive quality thresholds (milliseconds of render time, EMA)
DEGRADE_1_MS = 12.0
DEGRADE_2_MS = 25.0
RECOVER_MS = 6.0


# ---- Landscape layout -------------------------------------------------------
# WHISPLAY_UI_LAYOUT=landscape draws a 280x240 canvas and turns it 90 degrees onto the 240x280 panel (terminal_ui._send).
# The scene modules for this layout are land.py and land_ui.py; the portrait design above is unchanged and stays the default.
LAYOUT = (os.environ.get("WHISPLAY_UI_LAYOUT") or "portrait").strip().lower()
LANDSCAPE = LAYOUT == "landscape"
PHYS_WIDTH = 240
PHYS_HEIGHT = 280
ROTATE = (os.environ.get("WHISPLAY_UI_ROTATE") or "cw").strip().lower()   # which edge of the panel becomes the top


def _scale(rgb, k):
    return _q(int(rgb[0] * k), int(rgb[1] * k), int(rgb[2] * k))


ACCENTS = {   # one technical accent over a cool graphite ramp; the alert colour must never be mistaken for it
    "lime": ((184, 240, 0), (255, 86, 62)),
    "ice": ((92, 214, 255), (255, 86, 62)),
    "vermilion": ((255, 86, 52), (255, 200, 0)),
    "ultra": ((126, 140, 255), (255, 86, 62)),
}

if LANDSCAPE:
    WIDTH = 280
    HEIGHT = 240
    HAIR = _q(36, 42, 48)
    INK = _q(226, 232, 236)
    INK2 = _q(152, 164, 173)
    INK3 = _q(112, 124, 134)
    TICK = _q(62, 72, 80)
    _name = (os.environ.get("WHISPLAY_UI_ACCENT") or "lime").strip().lower()
    _acc, _alert = ACCENTS.get(_name, ACCENTS["lime"])
    ACCENT = _q(*_acc)
    ACCENT_MID = _scale(_acc, 0.72)
    ACCENT_DIM = _scale(_acc, 0.42)
    ACCENT_DEEP = _scale(_acc, 0.16)
    ALERT = _q(*_alert)
    ALERT_DIM = _scale(_alert, 0.4)
    RAISED = _q(10, 13, 16)
    PANEL = _q(16, 20, 24)
    LINE = HAIR
    DIM = INK3
    MUTED = INK2
    TEXT = INK
    GREEN, GREEN_MID, GREEN_DIM, GREEN_DEEP = ACCENT, ACCENT_MID, ACCENT_DIM, ACCENT_DEEP
    AMBER, AMBER_MID, AMBER_DIM = ACCENT, ACCENT_MID, ACCENT_DIM
    CYAN, CYAN_DIM = INK2, INK3
    RED, RED_DIM = ALERT, ALERT_DIM
    # Rounded panel corners (radius about 40 px, checked at 44): content keeps inside these insets.
    STATUS_SAFE_LEFT = 24
    STATUS_SAFE_RIGHT = 256
    STATUS_CENTER_Y = 12
    CONTENT_SAFE_BOTTOM = 224
    CHROME_LEFT = 14
    CHROME_RIGHT = 266
    TEXT_LEFT = 12
    TEXT_WIDTH = 256         # 28 cells of 9 px
    CURSOR_RIGHT_LIMIT = 269


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
        self.rain = _env_bool(env, "WHISPLAY_UI_RAIN", False)
        self.scanlines = _env_bool(env, "WHISPLAY_UI_SCANLINES", False)
        self.decode = _env_bool(env, "WHISPLAY_UI_DECODE", True)
        self.speech_focus = _env_bool(env, "WHISPLAY_UI_SPEECH_FOCUS", True)
        emoji = str(env.get("WHISPLAY_UI_EMOJI", "off") or "off").strip().lower()
        self.emoji = emoji if emoji in ("strip", "off") else "off"
        self.fps_cap = _env_int(env, "WHISPLAY_UI_FPS", 30, 5, 30)
        # Mechanical eye replaces the strip emoji; "off" restores the emoji. Extra idle breathing ticks per second; 0 = the idle eye only changes on frames that are drawn anyway (cursor blink, clock).
        self.eye = str(env.get("WHISPLAY_UI_EYE", "off") or "off").strip().lower() == "on"   # the optic is the identity element now
        self.eye_idle_fps = _env_int(env, "WHISPLAY_UI_EYE_IDLE_FPS", 0, 0, 5)
        self.debug = _env_bool(env, "WHISPLAY_UI_DEBUG", False)
