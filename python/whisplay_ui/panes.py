"""Console strip (answer / speaking), command-output pane and approval bar."""
from PIL import Image, ImageDraw

from . import theme
from .draw_util import clamp01, draw_text, fit_text

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


def render_strip(fonts, mode, t, emoji_image=None, progress=None):
    """Keep the answer's geometry stable; no synthetic speaking waveform."""
    image = Image.new("RGB", (theme.WIDTH, STRIP_H), theme.VOID)
    draw = ImageDraw.Draw(image)
    draw_text(draw, image, fonts.prompt, theme.CHROME_LEFT, theme.STRIP_MID_Y, "GLaDOS", theme.TEXT)
    if progress is not None:
        y = STRIP_H-2
        draw.line((theme.CHROME_LEFT,y,theme.CHROME_RIGHT-1,y), fill=theme.LINE)
        end = theme.CHROME_LEFT+int((theme.CHROME_RIGHT-theme.CHROME_LEFT-1)*clamp01(progress))
        if end > theme.CHROME_LEFT:
            draw.line((theme.CHROME_LEFT,y,end,y), fill=theme.GREEN)
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
    _chip(draw, image, fonts, theme.CHROME_LEFT + 2, mid, "HOLD", "CANCEL", theme.MUTED, theme.DIM)
    _chip(draw, image, fonts, theme.WIDTH // 2 + 8, mid, "TAP", "ALLOW", theme.AMBER, theme.AMBER_DIM)
    return image


def _chip(draw, image, fonts, x, mid, key, label, fg, border):
    key_w = int(fonts.pixel8.width(key)) + 7
    draw.rectangle([x, mid - 7, x + key_w, mid + 6], outline=border)
    draw_text(draw, image, fonts.pixel8, x + 4, mid, key, fg)
    draw_text(draw, image, fonts.meta_bold, x + key_w + 6, mid, label, theme.TEXT)
