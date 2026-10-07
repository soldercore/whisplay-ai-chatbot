"""Console strip (answer / speaking), command-output pane and approval bar."""
import math

from PIL import Image, ImageDraw

from . import theme
from .draw_util import clamp01, draw_text, fit_text, smooth_noise

STRIP_H = theme.BODY_TOP_CONSOLE - theme.PANE_Y
TERMINAL_H = theme.BODY_TOP_TERMINAL - theme.PANE_Y
TERMINAL_LINE_H = 10
TERMINAL_MAX_LINES = 5

STRIP_SPEAKING = "SPEAKING"
STRIP_RECEIVING = "RECEIVING"
STRIP_RESPONSE = "RESPONSE"


def _dotted(draw, y):
    for dx in range(theme.CHROME_LEFT, theme.CHROME_RIGHT, 3):
        draw.point((dx, y), fill=theme.LINE)


def speaking_levels(t, bars=7):
    out = []
    for i in range(bars):
        env = 0.55 + 0.45 * math.sin(math.pi * (i + 0.5) / bars)
        level = env * (0.25 + 0.75 * smooth_noise(t * 7.0 + i * 1.9, 21))
        out.append(clamp01(level))
    return out


def render_strip(fonts, mode, t, emoji_image=None, progress=None):
    image = Image.new("RGB", (theme.WIDTH, STRIP_H), theme.VOID)
    draw = ImageDraw.Draw(image)
    mid = theme.STRIP_MID_Y
    x = theme.CHROME_LEFT
    color = theme.GREEN
    draw_text(draw, image, fonts.pixel8, x, mid, ">", color)
    end = draw_text(draw, image, fonts.pixel8, x + 9, mid, mode, color)
    if mode == STRIP_SPEAKING:
        bx = int(end) + 8
        for i, level in enumerate(speaking_levels(t)):
            h = 1 + int(level * 6)
            draw.rectangle([bx + i * 4, mid - h, bx + i * 4 + 1, mid + h - 1], fill=theme.GREEN if level > 0.45 else theme.GREEN_MID)
    elif mode == STRIP_RECEIVING:
        bx = int(end) + 6
        lit = int(t * 6) % 4
        for i in range(3):
            fill = theme.GREEN if i < lit else theme.GREEN_DEEP
            draw.rectangle([bx + i * 5, mid, bx + i * 5 + 1, mid + 1], fill=fill)
    if emoji_image is not None:
        ex = theme.CHROME_RIGHT - emoji_image.width
        ey = mid - emoji_image.height // 2
        image.paste(emoji_image, (ex, ey), emoji_image if emoji_image.mode == "RGBA" else None)
    if progress is not None:
        y = STRIP_H - 3
        x0, x1 = theme.CHROME_LEFT, theme.CHROME_RIGHT - 1
        draw.line([(x0, y), (x1, y)], fill=theme.LINE)
        fill_x = x0 + int((x1 - x0) * clamp01(progress))
        if fill_x > x0:
            draw.line([(x0, y), (fill_x, y)], fill=theme.GREEN)
    _dotted(draw, STRIP_H - 1)
    return image


def terminal_lines(text):
    lines = [line for line in (text or "").replace("\r\n", "\n").replace("\r", "\n").split("\n") if line]
    return lines[-TERMINAL_MAX_LINES:]


def render_terminal(fonts, text):
    image = Image.new("RGB", (theme.WIDTH, TERMINAL_H), theme.VOID)
    draw = ImageDraw.Draw(image)
    x = theme.CHROME_LEFT
    draw_text(draw, image, fonts.pixel8, x, 7, "$ EXEC", theme.CYAN)
    draw.line([(x + 44, 7), (theme.CHROME_RIGHT - 1, 7)], fill=theme.CYAN_DIM)
    stack = fonts.meta
    width = theme.CHROME_RIGHT - x
    for index, line in enumerate(terminal_lines(text)):
        baseline = 24 + index * TERMINAL_LINE_H
        stack.draw(draw, image, x, baseline, fit_text(stack, line.expandtabs(2), width), theme.GREEN)
    _dotted(draw, TERMINAL_H - 1)
    return image


def render_approval(fonts):
    image = Image.new("RGB", (theme.WIDTH, theme.APPROVAL_H), theme.VOID)
    draw = ImageDraw.Draw(image)
    draw.line([(theme.CHROME_LEFT, 0), (theme.CHROME_RIGHT - 1, 0)], fill=theme.LINE)
    mid = theme.APPROVAL_H // 2 - 2
    _chip(draw, image, fonts, theme.CHROME_LEFT + 6, mid, "TAP", "ALLOW", theme.GREEN, theme.GREEN_DIM)
    _chip(draw, image, fonts, theme.WIDTH // 2 + 8, mid, "HOLD", "DENY", theme.RED, theme.RED_DIM)
    return image


def _chip(draw, image, fonts, x, mid, key, label, fg, border):
    key_w = int(fonts.pixel8.width(key)) + 7
    draw.rectangle([x, mid - 7, x + key_w, mid + 6], outline=border)
    draw_text(draw, image, fonts.pixel8, x + 4, mid, key, fg)
    draw_text(draw, image, fonts.meta_bold, x + key_w + 6, mid, label, theme.TEXT)
