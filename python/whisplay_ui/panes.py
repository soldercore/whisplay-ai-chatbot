"""Console strip (answer / speaking), command-output pane and approval bar."""
import math

from PIL import Image, ImageDraw

from . import theme
from . import visual_state as vs
from .stage import terminal_identity
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


def _seconds(value):
    try:
        return "%.1fs" % max(0.0, float(value))
    except (TypeError, ValueError):
        return ""


def render_strip(fonts, mode, t, emoji_image=None, progress=None, tokens=None):
    image = Image.new("RGB", (theme.WIDTH, STRIP_H), theme.VOID)
    draw = ImageDraw.Draw(image)
    mid = theme.STRIP_MID_Y
    x = theme.CHROME_LEFT
    color = theme.GREEN
    tokens = tokens or {}
    label = mode
    # One measured value per response, from real events: RESPONSE (speech end to first audible reply) or, for a
    # device command, ACTION (speech end to the verified outcome). Nothing is drawn when it was not measured.
    measured = _seconds(tokens.get("act")) if "act" in tokens else _seconds(tokens.get("resp")) if "resp" in tokens else ""
    if measured:
        label = ("ACTION" if "act" in tokens else mode) + " . " + measured
    draw_text(draw, image, fonts.pixel8, x, mid, ">", color)
    end = draw_text(draw, image, fonts.pixel8, x + 9, mid, label, color)
    hint = ""
    if mode == STRIP_RESPONSE:
        if tokens.get("pend") == "capri":
            hint = "CAPRI TO ANSWER"
        elif "pend" in tokens:
            hint = "HOLD TO ANSWER"
        elif "capri" in tokens:
            hint = "SAY CAPRI"
    if hint:
        right = theme.CHROME_RIGHT - (emoji_image.width + 6 if emoji_image is not None else 0)
        text = fit_text(fonts.pixel8, hint, right - end - 8)
        draw_text(draw, image, fonts.pixel8, int(right - fonts.pixel8.width(text)), mid, text, theme.DIM)
    if mode == STRIP_SPEAKING:
        # Actual speech state, not a simulated audio-level meter.
        draw.ellipse((int(end)+8, mid-2, int(end)+11, mid+1), fill=theme.GREEN)
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
    _chip(draw, image, fonts, theme.CHROME_LEFT + 2, mid, "HOLD", "CANCEL", theme.MUTED, theme.DIM)
    _chip(draw, image, fonts, theme.WIDTH // 2 + 8, mid, "TAP", "ALLOW", theme.AMBER, theme.AMBER_DIM)
    return image


def _chip(draw, image, fonts, x, mid, key, label, fg, border):
    key_w = int(fonts.pixel8.width(key)) + 7
    draw.rectangle([x, mid - 7, x + key_w, mid + 6], outline=border)
    draw_text(draw, image, fonts.pixel8, x + 4, mid, key, fg)
    draw_text(draw, image, fonts.meta_bold, x + key_w + 6, mid, label, theme.TEXT)


MIC_H = theme.CONTENT_SAFE_BOTTOM - theme.PANE_Y
MIC_STATES = frozenset((vs.IDLE, vs.LISTEN, vs.TRANSCRIBE, vs.THINK))


def render_microphone(fonts, state, t, info, eye_image=None):
    """Physical-button affordance. No touch handler or microphone ownership here."""
    image = Image.new("RGB", (theme.WIDTH, MIC_H), theme.VOID)
    draw = ImageDraw.Draw(image)
    prompt = Image.new("RGB", (theme.WIDTH, theme.STAGE_VISUAL_H), theme.VOID)
    terminal_identity(prompt, ImageDraw.Draw(prompt), t, info)
    image.paste(prompt, (0, -12))
    recording = state == vs.LISTEN
    busy = state in (vs.TRANSCRIBE, vs.THINK)
    tokens = getattr(info, "tokens", None) or {}
    label = "REC" if recording else "WORKING" if busy else "READY"
    draw_text(draw, image, fonts.meta_bold, 18, 70, ">", theme.GREEN)
    draw_text(draw, image, fonts.meta_bold, 30, 70, label, theme.TEXT)
    name = "GLADOS"
    right = 216
    if eye_image is not None:
        # The eye takes the right end of the label row; the name moves left by its width.
        image.paste(eye_image, (216 - eye_image.width, 70 - eye_image.height // 2))
        right = 216 - eye_image.width - 6
    draw_text(draw, image, fonts.meta_bold, int(right-fonts.meta_bold.width(name)), 70, name, theme.TEXT)
    draw.line((120,64,120,76),fill=theme.LINE)
    draw.line((14,83,225,83),fill=theme.LINE)
    cx, cy, radius = 120, 159, 35
    color = theme.DIM if busy else theme.GREEN
    draw.ellipse((cx-radius,cy-radius,cx+radius,cy+radius),outline=color,width=2 if recording else 1)
    ink = theme.MUTED if busy else theme.TEXT
    draw.rounded_rectangle((cx-5,cy-13,cx+5,cy+4),radius=5,outline=ink,width=2)
    draw.arc((cx-9,cy-5,cx+9,cy+12),0,180,fill=ink,width=2)
    draw.line((cx,cy+12,cx,cy+18),fill=ink,width=2)
    draw.line((cx-6,cy+18,cx+6,cy+18),fill=ink,width=2)
    instruction = ("[ Release to send ]" if recording else "[ Recognizing speech ]" if state == vs.TRANSCRIBE
                   else "[ Preparing response ]" if state == vs.THINK else "[ Hold to talk ]")
    if recording:
        # A button hold needs the release; the automatic and Capri captures end by themselves.
        if "audio" in tokens:
            instruction = "[ Audio detected ]"
        elif "answer" in tokens:
            instruction = "[ Answer now ]"
        elif "auto" in tokens:
            instruction = "[ Speak now ]"
        elif "capri" in tokens:
            instruction = "[ Speak your command ]"
    elif state == vs.THINK:
        said = getattr(info, "transcript", "")
        if said:
            instruction = '"' + said.replace("\n", " ") + '"'
    elif state == vs.IDLE:
        if tokens.get("pend") == "capri":
            instruction = "[ Say Capri to answer ]"
        elif "pend" in tokens:
            instruction = "[ Hold to answer ]"
        elif "capri" in tokens:
            instruction = "[ Say Capri or hold to talk ]"
    text = fit_text(fonts.meta_bold,instruction,204)
    draw_text(draw,image,fonts.meta_bold,int((theme.WIDTH-fonts.meta_bold.width(text))/2),212,text,theme.TEXT)
    if busy:
        for i in range(3):
            x = 113+i*6
            draw.rectangle((x,226,x+1,227),fill=theme.GREEN if i==int(t*2)%3 else theme.DIM)
    elif recording:
        limit = tokens.get("answer") or tokens.get("auto") or ""
        shown = min(int(t), int(limit)) if limit.isdigit() else int(t)   # the capture ends at its limit
        clock_text = "%02d:%02d" % (shown//60,shown%60)
        if limit.isdigit():
            clock_text += " / %02d:%02d" % (int(limit)//60,int(limit)%60)
        draw_text(draw,image,fonts.meta,int((theme.WIDTH-fonts.meta.width(clock_text))/2),230,clock_text,theme.MUTED)
    return image
