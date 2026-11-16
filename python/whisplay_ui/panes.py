"""Console strip (answer / speaking), command-output pane and approval bar."""
import math

from PIL import Image, ImageDraw

from . import theme
from . import visual_state as vs
from . import optic
from .draw_util import mix
from .draw_util import clamp01, draw_text, fit_text, smooth_noise

STRIP_H = theme.BODY_TOP_CONSOLE - theme.PANE_Y
TERMINAL_H = theme.BODY_TOP_TERMINAL - theme.PANE_Y
TERMINAL_LINE_H = 10
TERMINAL_MAX_LINES = 5

STRIP_SPEAKING = "SPEAKING"
STRIP_RECEIVING = "RECEIVING"
STRIP_RESPONSE = "RESPONSE"
MINI = 20


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


def _seconds(value):
    try:
        return "%.1fs" % max(0.0, float(value))
    except (TypeError, ValueError):
        return ""


def render_strip(fonts, mode, t, emoji_image=None, progress=None, tokens=None):
    """One quiet line above the body: a small optic, what the device is doing, and one hint."""
    image = Image.new("RGB", (theme.WIDTH, STRIP_H), theme.VOID)
    draw = ImageDraw.Draw(image)
    tokens = tokens or {}
    mid = theme.STRIP_MID_Y
    if mode == STRIP_SPEAKING:
        levels = speaking_levels(t, 5)
        pupil = 3 + int(round(3 * sum(levels) / len(levels)))
        mark = optic.render(MINI, None, 1.5, theme.ACCENT, pupil, theme.ACCENT, highlight=False)
        label = "Speaking"
    elif mode == STRIP_RECEIVING:
        pupil = 2 + int(t * 4) % 3
        mark = optic.render(MINI, None, 1.5, theme.ACCENT_MID, pupil, theme.ACCENT_MID, highlight=False)
        label = "Writing"
    else:
        mark = optic.render(MINI, None, 1.5, theme.INK3, 3, theme.ACCENT_MID, highlight=False)
        label = "Response"
        # One measured value per response, from real events: RESPONSE (speech end to first audible reply) or, for a
        # device command, ACTION (speech end to the verified outcome). Nothing is drawn when it was not measured.
        measured = _seconds(tokens.get("act")) if "act" in tokens else _seconds(tokens.get("resp")) if "resp" in tokens else ""
        if measured:
            label = ("Action" if "act" in tokens else "Response") + " " + chr(0xB7) + " " + measured
    image.paste(mark, (theme.CHROME_LEFT, mid - MINI // 2))
    end = draw_text(draw, image, fonts.small_bold, theme.CHROME_LEFT + MINI + 8, mid, label, theme.INK)
    hint = ""
    if mode == STRIP_RESPONSE:
        if "heard" in tokens:
            hint = "Capri heard"
        elif tokens.get("pend") == "capri":
            hint = "Capri to answer"
        elif "pend" in tokens:
            hint = "Hold to answer"
        elif "capri" in tokens:
            hint = "Say Capri"
    if hint:
        right = theme.CHROME_RIGHT
        text = fit_text(fonts.small, hint, right - end - 8)
        draw_text(draw, image, fonts.small, int(right - fonts.small.width(text)), mid,
                  text, theme.ACCENT if "heard" in tokens else theme.INK3)
    if progress is not None:
        y = STRIP_H - 3
        x0, x1 = theme.CHROME_LEFT, theme.CHROME_RIGHT - 1
        draw.line([(x0, y), (x1, y)], fill=theme.HAIR)
        fill_x = x0 + int((x1 - x0) * clamp01(progress))
        if fill_x > x0:
            draw.line([(x0, y), (fill_x, y)], fill=theme.ACCENT)
    else:
        draw.line([(theme.CHROME_LEFT, STRIP_H - 1), (theme.CHROME_RIGHT - 1, STRIP_H - 1)], fill=theme.HAIR)
    return image


def terminal_lines(text):
    lines = [line for line in (text or "").replace("\r\n", "\n").replace("\r", "\n").split("\n") if line]
    return lines[-TERMINAL_MAX_LINES:]


def render_terminal(fonts, text):
    image = Image.new("RGB", (theme.WIDTH, TERMINAL_H), theme.VOID)
    draw = ImageDraw.Draw(image)
    x = theme.CHROME_LEFT
    draw_text(draw, image, fonts.small_bold, x, 7, "Output", theme.INK2)
    draw.line([(x + 56, 7), (theme.CHROME_RIGHT - 1, 7)], fill=theme.HAIR)
    stack = fonts.meta
    width = theme.CHROME_RIGHT - x
    for index, line in enumerate(terminal_lines(text)):
        baseline = 24 + index * TERMINAL_LINE_H
        stack.draw(draw, image, x, baseline, fit_text(stack, line.expandtabs(2), width), theme.INK2)
    _dotted(draw, TERMINAL_H - 1)
    return image


def render_approval(fonts):
    image = Image.new("RGB", (theme.WIDTH, theme.APPROVAL_H), theme.VOID)
    draw = ImageDraw.Draw(image)
    draw.line([(theme.CHROME_LEFT, 0), (theme.CHROME_RIGHT - 1, 0)], fill=theme.HAIR)
    mid = theme.APPROVAL_H // 2 - 1
    _chip(draw, image, fonts, theme.CHROME_LEFT + 2, mid, "Hold", "Cancel", theme.INK3)
    _chip(draw, image, fonts, theme.WIDTH // 2 + 8, mid, "Tap", "Allow", theme.ACCENT)
    return image


def _chip(draw, image, fonts, x, mid, key, label, key_color):
    end = draw_text(draw, image, fonts.small, x, mid, key, key_color)
    draw_text(draw, image, fonts.small_bold, end + 6, mid, label, theme.INK)


MIC_H = theme.CONTENT_SAFE_BOTTOM - theme.PANE_Y
MIC_STATES = frozenset((vs.IDLE, vs.LISTEN, vs.TRANSCRIBE, vs.THINK))
OPTIC = 112
OPTIC_Y = 36
MIC_FPS = 12


def _center(draw, image, stack, y, text, fill, width=204):
    text = fit_text(stack, text, width)
    draw_text(draw, image, stack, int((theme.WIDTH - stack.width(text)) / 2), y, text, fill)


def _limit(tokens):
    for key in ("answer", "auto"):
        value = tokens.get(key, "")
        if value.isdigit() and int(value) > 0:
            return int(value)
    return 0


def render_microphone(fonts, state, t, info, eye_image=None):
    """The optic and two lines of words. Physical-button affordance only: no touch handler, no microphone ownership."""
    image = Image.new("RGB", (theme.WIDTH, MIC_H), theme.VOID)
    draw = ImageDraw.Draw(image)
    tokens = getattr(info, "tokens", None) or {}
    third = ""
    if state == vs.LISTEN:
        limit = _limit(tokens)
        audio = "audio" in tokens
        ticks = optic.ticks_remaining(max(0.0, 1.0 - t / limit)) if limit else optic.ticks_all(0.75 if audio else 0.5)
        pupil = 15 if audio else 12 + int(round(1.5 * math.sin(t * math.pi * 1.6)))
        color = theme.mix_hint if False else mix(theme.ACCENT, theme.INK, 0.25) if audio else theme.ACCENT
        hero = optic.render(OPTIC, ticks, 2, theme.ACCENT, pupil, color)
        title = "Listening"
        if audio:
            sub = "Audio detected"
        elif "answer" in tokens:
            sub = "Answer now"
        elif "auto" in tokens:
            sub = "Speak now"
        elif "capri" in tokens:
            sub = "Speak your command"
        else:
            sub = "Release to send"
            third = "%d:%02d" % (int(t) // 60, int(t) % 60)
    elif state == vs.TRANSCRIBE:
        hero = optic.render(OPTIC, optic.ticks_comet((t / 1.2) % 1.0, 10), 2, theme.ACCENT_MID, 6, theme.ACCENT)
        title, sub = "Recognizing speech", ""
    elif state == vs.THINK:
        hero = optic.render(OPTIC, optic.ticks_comet((t / 2.6) % 1.0, 7, 2), 2, theme.ACCENT_MID, 5, theme.ACCENT_MID)
        title = "Thinking"
        said = getattr(info, "transcript", "")
        sub = ("“" + said.replace(chr(10), " ") + "”") if said else "Preparing response"
    elif "heard" in tokens:
        hero = optic.render(OPTIC, optic.ticks_all(1.0), 3, theme.ACCENT, 9, mix(theme.ACCENT, theme.INK, 0.7))   # a bright flash of the lens: heard, not yet listening
        title, sub = "Capri heard", ""
    else:
        capri = "capri" in tokens
        hero = optic.render(OPTIC, None, 2, theme.INK3, 7, theme.ACCENT_MID if capri else theme.INK3, highlight=False)
        hero = optic.render(OPTIC, optic.ticks_all(0.0), 2, theme.INK3, 7, theme.ACCENT_MID if capri else theme.INK3, highlight=False)
        title = "Ready"
        if tokens.get("pend") == "capri":
            sub = "Say Capri to answer"
        elif "pend" in tokens:
            sub = "Hold to answer"
        elif capri:
            sub = "Say Capri or hold to talk"
        else:
            sub = "Hold to talk"
    image.paste(hero, ((theme.WIDTH - OPTIC) // 2, OPTIC_Y))
    _center(draw, image, fonts.title, 178, title, theme.INK)
    if sub:
        _center(draw, image, fonts.small, 203, sub, theme.INK2)
    if third:
        _center(draw, image, fonts.small, 223, third, theme.INK3)
    return image
