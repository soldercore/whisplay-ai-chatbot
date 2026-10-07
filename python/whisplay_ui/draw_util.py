"""Small drawing helpers shared by the terminal UI scenes."""
import math

from . import theme


def lerp(a, b, t):
    return a + (b - a) * t


def clamp01(t):
    return 0.0 if t < 0.0 else 1.0 if t > 1.0 else t


def ease_out(t):
    t = clamp01(t)
    return 1.0 - (1.0 - t) ** 3


def ease_in_out(t):
    t = clamp01(t)
    return t * t * (3.0 - 2.0 * t)


def mix(c1, c2, t):
    t = clamp01(t)
    return (
        int(round(c1[0] + (c2[0] - c1[0]) * t)),
        int(round(c1[1] + (c2[1] - c1[1]) * t)),
        int(round(c1[2] + (c2[2] - c1[2]) * t)),
    )


def hash01(*values):
    """Deterministic pseudo-random number in [0, 1) from integers."""
    h = 2166136261
    for value in values:
        h ^= int(value) & 0xFFFFFFFF
        h = (h * 16777619) & 0xFFFFFFFF
    h ^= h >> 13
    h = (h * 0x5BD1E995) & 0xFFFFFFFF
    h ^= h >> 15
    return (h & 0xFFFFFF) / float(0x1000000)


def smooth_noise(x, seed=0):
    """1D value noise in [0, 1], smooth in x."""
    i = math.floor(x)
    f = x - i
    a = hash01(i, seed)
    b = hash01(i + 1, seed)
    return lerp(a, b, f * f * (3.0 - 2.0 * f))


def text_width(stack, text):
    return stack.width(text)


def draw_text(draw, image, stack, x, center_y, text, fill, cap=None):
    """Draw text vertically centred on center_y using the stack's cap height.
    Returns the x after the text."""
    if cap is None:
        cap = cap_height(stack)
    baseline = int(round(center_y + cap / 2.0))
    return stack.draw(draw, image, x, baseline, text, fill)


_CAP_CACHE = {}


def cap_height(stack):
    key = id(stack)
    cap = _CAP_CACHE.get(key)
    if cap is None:
        face = stack.primary
        try:
            bbox = face.font.getbbox("H")
            cap = max(1, bbox[3] - bbox[1])
        except Exception:
            cap = 8
        _CAP_CACHE[key] = cap
    return cap


def fit_text(stack, text, max_width, ellipsis="…"):
    if stack.width(text) <= max_width:
        return text
    if not stack.primary.covers(ellipsis):
        ellipsis = "..."
    budget = max_width - stack.width(ellipsis)
    out = []
    used = 0.0
    for ch in text:
        w = stack.advance(ch)
        if used + w > budget:
            break
        out.append(ch)
        used += w
    return "".join(out).rstrip() + ellipsis


def corner_brackets(draw, x0, y0, x1, y1, size, fill):
    """Viewfinder-style corner marks."""
    draw.line([(x0, y0), (x0 + size, y0)], fill=fill)
    draw.line([(x0, y0), (x0, y0 + size)], fill=fill)
    draw.line([(x1 - size, y0), (x1, y0)], fill=fill)
    draw.line([(x1, y0), (x1, y0 + size)], fill=fill)
    draw.line([(x0, y1), (x0 + size, y1)], fill=fill)
    draw.line([(x0, y1 - size), (x0, y1)], fill=fill)
    draw.line([(x1 - size, y1), (x1, y1)], fill=fill)
    draw.line([(x1, y1 - size), (x1, y1)], fill=fill)


def fmt_mmss(seconds):
    seconds = max(0, int(seconds))
    return "%02d:%02d" % (seconds // 60, seconds % 60)


def fmt_elapsed(seconds):
    seconds = max(0.0, seconds)
    if seconds < 60:
        return "%.1fs" % seconds
    return fmt_mmss(seconds)


STATE_COLORS = {
    "BOOT": theme.GREEN_MID,
    "IDLE": theme.GREEN,
    "CALIBRATE": theme.GREEN,
    "LISTEN": theme.GREEN,
    "TRANSCRIBE": theme.CYAN,
    "THINK": theme.AMBER,
    "TOOL": theme.AMBER,
    "ANSWER": theme.GREEN,
    "SPEAK": theme.GREEN,
    "ERROR": theme.RED,
    "APPROVAL": theme.AMBER,
    "RESULT": theme.GREEN,
    "MUSIC": theme.GREEN,
    "CAMERA": theme.CYAN,
    "GENERIC": theme.MUTED,
}
