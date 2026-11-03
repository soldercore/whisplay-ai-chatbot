"""Compact state pane. No invented audio levels, progress or decorative effects."""
from PIL import Image, ImageDraw
from . import theme
from . import visual_state as vs
from .draw_util import STATE_COLORS, clamp01, draw_text, fit_text, fmt_mmss

VISUAL_H = theme.STAGE_VISUAL_H
CAPTION_H = theme.STAGE_H - VISUAL_H


class StageInfo:
    def __init__(self, fonts, flags):
        self.fonts, self.flags = fonts, flags
        self.quality = 0
        self.raw_status = ""
        self.tool_label = ""
        self.music_progress = None
        self.music_duration_ms = None


def visual_fps(state, t, info):
    # Slow activity dots mean work, never amplitude or estimated completion.
    return 2 if state in (vs.BOOT, vs.CALIBRATE, vs.TRANSCRIBE, vs.THINK, vs.TOOL) else 0


def is_denied(raw_status):
    return (raw_status or "").strip().lower() == "denied"


def render_visual(state, t, info):
    image = Image.new("RGB", (theme.WIDTH, VISUAL_H), theme.VOID)
    draw = ImageDraw.Draw(image)
    color = STATE_COLORS.get(state, theme.MUTED)
    titles = {vs.BOOT:"Starting", vs.IDLE:"GLaDOS", vs.CALIBRATE:"Microphone",
              vs.LISTEN:"Recording", vs.TRANSCRIBE:"Recognizing", vs.THINK:"Thinking",
              vs.TOOL:"Using a tool", vs.ERROR:"Try again", vs.APPROVAL:"Action needed",
              vs.RESULT:"Cancelled" if is_denied(info.raw_status) else "Confirmed",
              vs.MUSIC:"Playing", vs.CAMERA:"Camera"}
    title = titles.get(state, "GLaDOS")
    # Optional application badges occupy the right half of this row.
    x = theme.CHROME_LEFT
    if state == vs.LISTEN:
        draw.ellipse((x, 11, x+4, 15), fill=theme.GREEN)
        x += 12
    end = draw_text(draw, image, info.fonts.prompt, x, theme.STAGE_MID_Y, title, theme.TEXT)
    if visual_fps(state, t, info):
        for index in range(3):
            cx = int(end)+8+index*5
            draw.rectangle((cx,14,cx+1,15), fill=color if index == int(t*2)%3 else theme.LINE)
    return image, None


def caption_parts(state, t, info):
    color = STATE_COLORS.get(state, theme.MUTED)
    labels = {vs.BOOT:"Please wait", vs.IDLE:"Hold to talk", vs.CALIBRATE:"Preparing microphone",
              vs.LISTEN:"Release to send", vs.TRANSCRIBE:"Processing speech",
              vs.THINK:"Preparing a response", vs.TOOL:"Checking the result",
              vs.ERROR:"Hold to try again", vs.APPROVAL:"Choose with the button",
              vs.RESULT:"Hold to talk", vs.MUSIC:"Audio playback", vs.CAMERA:"Camera ready"}
    label = labels.get(state, fit_text(info.fonts.meta, info.raw_status or "", 200))
    right = fmt_mmss(t) if state == vs.LISTEN else ""
    progress = None
    if info.music_progress is not None:
        try:
            progress = clamp01(float(info.music_progress))
        except (TypeError, ValueError):
            pass
    return label, color, right, theme.MUTED, progress


def render_caption(parts, t, info, state):
    label, color, right, right_color, progress = parts
    image = Image.new("RGB", (theme.WIDTH, CAPTION_H), theme.VOID)
    draw = ImageDraw.Draw(image)
    mid = 8
    draw_text(draw, image, info.fonts.meta, theme.CHROME_LEFT, mid, label, theme.MUTED)
    if right:
        width = info.fonts.meta.width(right)
        draw_text(draw, image, info.fonts.meta, int(theme.CHROME_RIGHT-width), mid, right, right_color)
    if progress is not None:
        y = CAPTION_H-2
        draw.line((theme.CHROME_LEFT,y,theme.CHROME_RIGHT-1,y), fill=theme.LINE)
        end = theme.CHROME_LEFT+int((theme.CHROME_RIGHT-theme.CHROME_LEFT-1)*progress)
        if end > theme.CHROME_LEFT:
            draw.line((theme.CHROME_LEFT,y,end,y), fill=theme.GREEN)
    return image
