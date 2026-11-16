"""The GLaDOS optic: the one identity element of the interface.

A precision dial (a ring with 36 ticks) around a single lens. State is told by what the dial and the
lens do, never by decoration: dim and still = ready, all ticks lit = heard / listening, a comet that
circles = working, a gap and red = something failed. Everything is drawn supersampled (4x) and reduced
with a box filter, so edges are smooth on the 240x280 panel; frames are cached by their quantised
parameters, so a held state costs nothing after its first render.
"""
import math
from functools import lru_cache

from PIL import Image, ImageDraw

from . import theme
from .draw_util import mix

SS = 4
TICKS = 36


def _scaled(value):
    return int(round(value * SS))


@lru_cache(maxsize=96)
def render(size, ticks, ring, ring_color, pupil, pupil_color, gap=0, ticks_color=None, highlight=True, mark=None):
    """RGB image size x size on a VOID background.

    ticks: tuple of TICKS intensities in 0..4 (quantised, so frames cache); 0 = dim tick.
    ring: ring stroke in px; ring_color: colour of the ring.
    pupil: lens radius in px (0 = none), pupil_color its colour.
    gap: degrees of the ring left open at the top (error); mark: "!" "ok" "x" glyph drawn in the lens.
    """
    big = size * SS
    image = Image.new("RGB", (big, big), theme.VOID)
    draw = ImageDraw.Draw(image)
    c = big / 2.0
    radius = (size / 2.0 - 1.0) * SS
    stroke = max(1, _scaled(ring))
    box = [c - radius, c - radius, c + radius, c + radius]
    if gap:
        start = -90 + gap / 2.0
        draw.arc(box, start, start + 360 - gap, fill=ring_color, width=stroke)
    else:
        draw.ellipse(box, outline=ring_color, width=stroke)
    if ticks is not None and size >= 96:
        accent = ticks_color or theme.ACCENT
        inner, outer = radius - _scaled(9), radius - _scaled(4)
        for index in range(TICKS):
            level = ticks[index]
            angle = math.radians(index * 360.0 / TICKS - 90.0)
            color = theme.TICK if level <= 0 else mix(theme.ACCENT_MID, accent, (level - 1) / 3.0)
            width = _scaled(1.4 if level <= 0 else 2.2)
            x0, y0 = c + math.cos(angle) * inner, c + math.sin(angle) * inner
            x1, y1 = c + math.cos(angle) * outer, c + math.sin(angle) * outer
            draw.line([(x0, y0), (x1, y1)], fill=color, width=width)
    if pupil > 0:
        r = pupil * SS
        draw.ellipse([c - r, c - r, c + r, c + r], fill=pupil_color)
        if highlight and pupil >= 5:
            hr = max(1.0, pupil * 0.16) * SS
            hx, hy = c - pupil * 0.36 * SS, c - pupil * 0.36 * SS
            draw.ellipse([hx - hr, hy - hr, hx + hr, hy + hr], fill=mix(pupil_color, theme.INK, 0.55))
    if mark:
        _mark(draw, c, pupil_color if pupil <= 0 else theme.VOID, mark, size)
    return image.reduce(SS)


def _mark(draw, c, color, mark, size):
    u = size * SS / 112.0
    w = max(2, int(round(5 * u)))
    if mark == "!":
        draw.line([(c, c - 15 * u), (c, c + 4 * u)], fill=color, width=w)
        draw.ellipse([c - 3 * u, c + 11 * u, c + 3 * u, c + 17 * u], fill=color)
    elif mark == "ok":
        draw.line([(c - 15 * u, c + 1 * u), (c - 5 * u, c + 11 * u), (c + 16 * u, c - 12 * u)], fill=color, width=w, joint="curve")
    elif mark == "x":
        draw.line([(c - 12 * u, c - 12 * u), (c + 12 * u, c + 12 * u)], fill=color, width=w)
        draw.line([(c - 12 * u, c + 12 * u), (c + 12 * u, c - 12 * u)], fill=color, width=w)
    elif mark == "?":
        draw.arc([c - 11 * u, c - 17 * u, c + 11 * u, c + 5 * u], 200, 90 + 360, fill=color, width=w)
        draw.line([(c, c + 4 * u), (c, c + 7 * u)], fill=color, width=w)
        draw.ellipse([c - 3 * u, c + 12 * u, c + 3 * u, c + 18 * u], fill=color)


def _quant(value):
    return max(0, min(4, int(round(value * 4))))


def ticks_all(level):
    return (_quant(level),) * TICKS


def ticks_comet(phase, length=9, copies=1):
    """Bright head with a fading tail circling the dial; phase in turns (0..1)."""
    out = [0] * TICKS
    for copy in range(copies):
        head = (phase + copy / float(copies)) * TICKS
        for index in range(TICKS):
            behind = (head - index) % TICKS
            if behind < length:
                out[index] = max(out[index], _quant(1.0 - behind / float(length)))
    return tuple(out)


def ticks_remaining(fraction):
    """Ticks drain clockwise from the top as time runs out: fraction left in 0..1."""
    lit = fraction * TICKS
    out = []
    for index in range(TICKS):
        out.append(4 if index + 1 <= lit else _quant(lit - index) if lit > index else 0)
    return tuple(out)
