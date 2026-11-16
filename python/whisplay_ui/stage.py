"""Stage pane: the 80 px animated visual plus the 24 px caption row.

Every animation is a pure function of `t` (seconds since the state was
entered), so frames are reproducible and independent of the frame rate.
"""
import math

import numpy as np
from PIL import Image, ImageDraw

from . import theme
from . import visual_state as vs
from . import optic
from .draw_util import (
    STATE_COLORS,
    clamp01,
    corner_brackets,
    draw_text,
    ease_in_out,
    ease_out,
    fit_text,
    fmt_elapsed,
    fmt_mmss,
    hash01,
    mix,
    smooth_noise,
)

VISUAL_H = theme.STAGE_VISUAL_H
CAPTION_H = theme.STAGE_H - theme.STAGE_VISUAL_H
MID = theme.STAGE_MID_Y
CAPTION_MID = theme.CAPTION_MID_Y - theme.STAGE_VISUAL_H - 2
HEX = "0123456789ABCDEF"
IDLE_RAIN_SECONDS = 30.0
RAIN_FADE = 2.0
ERROR_GLITCH = 0.0   # no glitch effect: a failure is shown plainly
PROMPT_USER = "pi@whisplay"
PROMPT_PATH = "~"


class StageInfo:
    """Inputs the stage needs besides the state and time."""

    def __init__(self, fonts, flags):
        self.fonts = fonts
        self.flags = flags
        self.quality = 0
        self.raw_status = ""
        self.hint = ""
        self.tokens = {}
        self.transcript = ""
        self.tool_label = ""
        self.music_progress = None
        self.music_duration_ms = None


def rain_active(state, t, info):
    return (
        state == vs.IDLE
        and info.flags.rain
        and info.quality == 0
        and t < IDLE_RAIN_SECONDS
    )


def visual_fps(state, t, info):
    """Frames per second the visual needs at time t (0 = static)."""
    if state == vs.IDLE:
        return theme.RAIN_FPS if rain_active(state, t, info) else 0
    if state == vs.ERROR:
        return 30 if t < ERROR_GLITCH else 0
    if state in (vs.APPROVAL, vs.RESULT, vs.CAMERA, vs.GENERIC, vs.ANSWER):
        return 0
    return theme.STATE_FPS.get(state, 0)


def cursor_on(t):
    return (t % theme.BLINK_PERIOD) < theme.BLINK_ON


def next_blink_edge(t):
    phase = t % theme.BLINK_PERIOD
    if phase < theme.BLINK_ON:
        return theme.BLINK_ON - phase
    return theme.BLINK_PERIOD - phase


# ---------------------------------------------------------------- visual
def render_visual(state, t, info):
    """Returns (image, cursor_rect or None). cursor_rect is in visual coords."""
    image = Image.new("RGB", (theme.WIDTH, VISUAL_H), theme.VOID)
    draw = ImageDraw.Draw(image)
    color = STATE_COLORS.get(state, theme.MUTED)
    if state != vs.IDLE:
        corner_brackets(draw, 8, 3, theme.WIDTH - 9, VISUAL_H - 4, 5, theme.LINE)
    cursor_rect = None
    painter = _PAINTERS.get(state, _generic)
    cursor_rect = painter(image, draw, t, info, color)
    if state != vs.IDLE and info.flags.scanlines and info.quality == 0:
        image = _scanlines(image)
    return image, cursor_rect


def _scanlines(image):
    arr = np.array(image, dtype=np.uint8)
    foreground = np.any(arr[1::2] != np.asarray(theme.VOID), axis=2)
    rows = arr[1::2]
    rows[foreground] = (rows[foreground].astype(np.uint16) * 184 >> 8).astype(np.uint8)
    return Image.fromarray(arr, "RGB")


def _idle(image, draw, t, info, color):
    fonts = info.fonts
    if rain_active(vs.IDLE, t, info):
        fade = clamp01(t / 0.5) * clamp01((IDLE_RAIN_SECONDS - t) / RAIN_FADE)
        _rain(image, draw, t, fonts, fade)
    return terminal_identity(image, draw, t, info)


def terminal_identity(image, draw, t, info):
    """Original prompt and cursor, shared without decorative stage effects."""
    fonts = info.fonts
    stack = fonts.prompt
    parts = [(PROMPT_USER, theme.GREEN), (":", theme.MUTED), (PROMPT_PATH, theme.CYAN), ("$", theme.MUTED)]
    width = sum(stack.width(text) for text, _ in parts) + 4 + theme.CURSOR_W
    x = int((theme.WIDTH - width) / 2)
    draw.rectangle([x - 6, MID - 12, x + width + 5, MID + 11], fill=theme.VOID)
    baseline = MID + 5
    for text, fill in parts:
        x = stack.draw(draw, image, x, baseline, text, fill)
    cx = int(x + 4)
    rect = (cx, baseline - 12, cx + theme.CURSOR_W, baseline + 2)
    if cursor_on(t):
        draw.rectangle([rect[0], rect[1], rect[2] - 1, rect[3] - 1], fill=theme.GREEN)
    return rect


def _rain(image, draw, t, fonts, fade):
    if fade <= 0:
        return
    stack = fonts.pixel8
    cell = 9
    for col in range(12):
        x = 14 + col * 18 + int(hash01(col, 11) * 6)
        speed = 16 + 20 * hash01(col, 1)
        span = VISUAL_H + 60
        head = (t * speed + hash01(col, 2) * span) % span - 20
        for k in range(5):
            y = int(head - k * cell)
            if y < -cell or y > VISUAL_H:
                continue
            row = int((head - k * cell) // cell)
            ch = HEX[int(hash01(col, row, int(t * 3)) * 16)]
            base = theme.GREEN_DIM if k == 0 else theme.GREEN_DEEP
            fill = mix(theme.VOID, base, fade * (1.0 - k * 0.15))
            stack.draw(draw, image, x, y + 7, ch, fill)


def _boot(image, draw, t, info, color):
    fonts = info.fonts
    title = "Whisplay"
    width = fonts.title.width(title)
    draw_text(draw, image, fonts.title, int((theme.WIDTH - width) / 2), MID - 8, title, theme.INK)
    x0, x1, y = 68, 172, MID + 14
    draw.line([(x0, y), (x1, y)], fill=theme.HAIR)
    p = ease_in_out((t % 2.4) / 2.4)
    seg = 28
    sx = int(x0 + (x1 - x0 - seg) * p)
    draw.line([(sx, y), (sx + seg, y)], fill=theme.ACCENT)
    return None


def _calibrate(image, draw, t, info, color):
    segments, seg_w, gap = 24, 7, 2
    total = segments * (seg_w + gap) - gap
    x0 = (theme.WIDTH - total) // 2
    level = clamp01(0.3 + 0.35 * smooth_noise(t * 2.2, 5) + 0.12 * math.sin(t * 7.0))
    lit = level * segments
    threshold = int(segments * 0.6)
    for i in range(segments):
        x = x0 + i * (seg_w + gap)
        if i < lit:
            fill = theme.GREEN if i < threshold else theme.AMBER
        else:
            fill = theme.GREEN_DEEP
        draw.rectangle([x, MID - 6, x + seg_w - 1, MID + 5], fill=fill)
    tx = x0 + threshold * (seg_w + gap) - 2
    draw.line([(tx, MID - 11), (tx, MID + 10)], fill=theme.CYAN)
    return None


def _listen(image, draw, t, info, color):
    bars, step, bar_w = 34, 6, 3
    total = bars * step - (step - bar_w)
    x0 = (theme.WIDTH - total) // 2
    intro = ease_out(t / 0.25)
    energy = 0.45 + 0.55 * smooth_noise(t * 1.7, 7)
    draw.line([(x0, MID), (x0 + total - 1, MID)], fill=theme.GREEN_DEEP)
    for i in range(bars):
        env = math.sin(math.pi * (i + 0.5) / bars) ** 0.8
        noise = 0.7 * smooth_noise(i * 0.35 + t * 5.0, 3) + 0.3 * abs(math.sin(t * 9.0 + i * 0.6))
        h = int(1 + 27 * env * energy * noise * intro)
        x = x0 + i * step
        draw.rectangle([x, MID - h, x + bar_w - 1, MID + h], fill=theme.GREEN_MID)
        core = int(h * 0.55)
        if core > 0:
            draw.rectangle([x, MID - core, x + bar_w - 1, MID + core], fill=theme.GREEN)
    return None


def _transcribe(image, draw, t, info, color):
    stack = info.fonts.prompt
    cells, step = 20, 10
    x0 = (theme.WIDTH - cells * step) // 2 + 1
    period = 1.4
    head = ((t / period) % 1.0) * (cells + 6) - 3
    for i in range(cells):
        x = x0 + i * step
        d = head - i
        if d < 0:
            draw.rectangle([x + 3, MID - 3, x + 4, MID - 2], fill=theme.CYAN_DIM)
        elif d < 1:
            draw.rectangle([x, MID - 10, x + 7, MID + 3], fill=theme.CYAN)
        else:
            ch = HEX[int(hash01(i, int(t * 8)) * 16)]
            fill = mix(theme.CYAN, theme.CYAN_DIM, clamp01((d - 1) / 6.0))
            stack.draw(draw, image, x, MID + 2, ch, fill)
    y = MID + 18
    x_start, x_end = 30, 210
    draw.line([(x_start, y), (x_end, y)], fill=theme.CYAN_DIM)
    p = 0.5 - 0.5 * math.cos(t * 2.6)
    seg = 36
    sx = int(x_start + (x_end - x_start - seg) * p)
    draw.line([(sx, y), (sx + seg, y)], fill=theme.CYAN)
    return None


def _think(image, draw, t, info, color):
    rows, cols, step = 3, 15, 14
    x0 = (theme.WIDTH - (cols - 1) * step) // 2
    for row in range(rows):
        cy = MID + (row - 1) * step
        for col in range(cols):
            cx = x0 + col * step
            wave = 0.5 + 0.5 * math.sin(t * 3.2 - col * 0.5 + row * 1.1)
            drift = 0.5 + 0.5 * math.sin(t * 1.3 + col * 0.21 - row * 0.7)
            b = clamp01(wave * wave * 0.8 + drift * 0.3)
            half = 1 if b < 0.45 else 2
            fill = mix(theme.AMBER_DIM, theme.AMBER, b)
            draw.rectangle([cx - half, cy - half, cx + half - 1, cy + half - 1], fill=fill)
    return None


def _tool(image, draw, t, info, color):
    fonts = info.fonts
    label = info.tool_label or "tool"
    text = fit_text(fonts.small_bold, label, 190)
    width = fonts.small_bold.width(text)
    draw_text(draw, image, fonts.small_bold, int((theme.WIDTH - width) / 2), MID - 8, text, theme.INK)
    x0, x1, y = 40, 200, MID + 12
    draw.line([(x0, y), (x1, y)], fill=theme.HAIR)
    p = 0.5 - 0.5 * math.cos(t * 2.4)
    block = 36
    bx = int(x0 + (x1 - x0 - block) * p)
    draw.line([(bx, y), (bx + block, y)], fill=theme.ACCENT, width=2)
    return None


OPTIC_STAGE = 72


def _optic_mark(image, ring, mark, gap=0):
    mark_image = optic.render(OPTIC_STAGE, None, 2, ring, 0, ring, gap=gap, mark=mark)
    image.paste(mark_image, ((theme.WIDTH - OPTIC_STAGE) // 2, (VISUAL_H - OPTIC_STAGE) // 2))


def _error(image, draw, t, info, color):
    _optic_mark(image, theme.ALERT, "!", gap=56)
    return None


def _approval(image, draw, t, info, color):
    _optic_mark(image, theme.ACCENT, "?")
    return None


def _result(image, draw, t, info, color):
    if is_denied(info.raw_status):
        _optic_mark(image, theme.ALERT, "x")
    else:
        _optic_mark(image, theme.ACCENT, "ok")
    return None


def _music(image, draw, t, info, color):
    bars, step, bar_w = 16, 12, 8
    total = bars * step - (step - bar_w)
    x0 = (theme.WIDTH - total) // 2
    floor = MID + 24
    for i in range(bars):
        level = 0.25 + 0.75 * smooth_noise(t * 4.0 + i * 1.7, 9) * (0.6 + 0.4 * math.sin(t * 2.0 + i * 0.4) ** 2)
        h = max(2, int(44 * level))
        x = x0 + i * step
        draw.rectangle([x, floor - h, x + bar_w - 1, floor], fill=theme.GREEN_MID)
        draw.rectangle([x, floor - h, x + bar_w - 1, floor - h + 1], fill=theme.GREEN)
    return None


def _camera(image, draw, t, info, color):
    corner_brackets(draw, 70, 14, 170, 66, 10, theme.CYAN)
    draw.ellipse([theme.WIDTH // 2 - 3, MID - 3, theme.WIDTH // 2 + 3, MID + 3], outline=theme.CYAN)
    return None


def _generic(image, draw, t, info, color):
    stack = info.fonts.body
    text = fit_text(stack, (info.raw_status or "").strip() or "...", 200)
    width = stack.width(text)
    stack.draw(draw, image, int((theme.WIDTH - width) / 2), MID + 5, text, theme.TEXT)
    return None


_PAINTERS = {
    vs.BOOT: _boot,
    vs.IDLE: _idle,
    vs.CALIBRATE: _calibrate,
    vs.LISTEN: _listen,
    vs.TRANSCRIBE: _transcribe,
    vs.THINK: _think,
    vs.TOOL: _tool,
    vs.ERROR: _error,
    vs.APPROVAL: _approval,
    vs.RESULT: _result,
    vs.MUSIC: _music,
    vs.CAMERA: _camera,
    vs.GENERIC: _generic,
}


def is_denied(raw_status):
    return (raw_status or "").strip().lower() == "denied"


# ---------------------------------------------------------------- caption
def caption_parts(state, t, info):
    """(label, colour, right text, right colour, progress or None)."""
    color = STATE_COLORS.get(state, theme.MUTED)
    right, right_color, progress = "", theme.MUTED, None
    if state == vs.BOOT:
        label = "Starting"
    elif state == vs.IDLE:
        label, right, right_color = "Ready", "", theme.INK3
    elif state == vs.CALIBRATE:
        label, right = "Calibrating", "Mic level"
    elif state == vs.LISTEN:
        label, right = "Listening", fmt_mmss(t)
    elif state == vs.TRANSCRIBE:
        label, right = "Recognizing", fmt_elapsed(t)
    elif state == vs.THINK:
        label, right = "Thinking", fmt_elapsed(t)
    elif state == vs.TOOL:
        label, right = "Tool call", fmt_elapsed(t)
    elif state == vs.ERROR:
        label = "Error"
        raw = (info.raw_status or "").strip()
        # Show the raw status only when it is itself an error string (not
        # the "idle" that arrives while the error is latched).
        if raw and raw.lower() != "error" and vs.classify(raw) == vs.ERROR:
            right = raw
    elif state == vs.APPROVAL:
        label, right = "Confirm", "Action required"
    elif state == vs.RESULT:
        if is_denied(info.raw_status):
            label, color = "Denied", theme.RED
        else:
            label = "Allowed"
    elif state == vs.MUSIC:
        label = "Playing"
    elif state == vs.CAMERA:
        label = "Camera"
    else:
        label = (info.raw_status or "").strip() or "Status"
    if info.music_progress is not None:
        progress = clamp01(float(info.music_progress))
        duration = info.music_duration_ms or 0
        if duration:
            right = "%s / %s" % (_mmss_ms(duration * progress), _mmss_ms(duration))
    return label, color, right, right_color, progress


def _mmss_ms(ms):
    ms = int(ms)
    return "%d:%02d" % (ms // 60000, (ms % 60000) // 1000)


def render_caption(parts, t, info, state):
    label, color, right, right_color, progress = parts
    image = Image.new("RGB", (theme.WIDTH, CAPTION_H), theme.VOID)
    draw = ImageDraw.Draw(image)
    fonts = info.fonts
    x = theme.CHROME_LEFT
    lamp = theme.INK3 if color in (theme.INK2, theme.INK3, theme.MUTED) else color
    draw.ellipse([x, CAPTION_MID - 3, x + 6, CAPTION_MID + 3], fill=lamp)
    label_end = draw_text(draw, image, fonts.small_bold, x + 14, CAPTION_MID, fit_text(fonts.small_bold, label, 130), theme.INK)
    if right:
        stack = fonts.small
        text = fit_text(stack, right, theme.CHROME_RIGHT - label_end - 12)
        width = stack.width(text)
        draw_text(draw, image, stack, int(theme.CHROME_RIGHT - width), CAPTION_MID, text, right_color if right_color != theme.MUTED else theme.INK3)
    y = CAPTION_H - 1
    draw.line([(theme.CHROME_LEFT, y), (theme.CHROME_RIGHT - 1, y)], fill=theme.HAIR)
    if progress is not None:
        y = CAPTION_H - 4
        x0, x1 = theme.CHROME_LEFT, theme.CHROME_RIGHT - 1
        draw.line([(x0, y), (x1, y)], fill=theme.HAIR)
        fill_x = x0 + int((x1 - x0) * progress)
        if fill_x > x0:
            draw.line([(x0, y), (fill_x, y)], fill=theme.ACCENT)
    return image
