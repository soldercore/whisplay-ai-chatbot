"""Scenes of the landscape layout (280 x 240 logical pixels, turned onto the 240 x 280 panel by land_ui).

One visual idea carries every state: the TRACE, a single line of 77 columns that changes form with what the
device is doing. It is flat at rest, a live signal while listening, is scanned and quantised while the speech is
recognised, carries one travelling pulse while the model works, runs out and back during a tool call, follows the
words as they are spoken and breaks at an error. The four stages of the pipeline (LISTEN, DECODE, THINK, SPEAK) are
a rail above it; one bar slides along the rail to the stage that is active.

Everything shown is real state: the stage, the elapsed time, the recognised words, the clock, the battery and the
radios. Nothing is decoration without a meaning, there is no glow and nothing moves while the device is idle.
"""
import math
import os

from PIL import Image, ImageDraw

from . import theme
from . import visual_state as vs
from .draw_util import cap_height, clamp01, draw_text, ease_in_out, fit_text, mix, smooth_noise
from .fonts import FONT_DIR, Face, FontStack, _truetype
from .status_icons import draw_home_wireless

W = 280
H = 240
HEADER_H = 24
LEFT = 24
RIGHT = 256
TRACE_W = RIGHT - LEFT            # 232 px
PITCH = 3
BAR = 2
STAGES = ("LISTEN", "DECODE", "THINK", "SPEAK")
STAGE_OF = {vs.CALIBRATE: 0, vs.LISTEN: 0, vs.TRANSCRIBE: 1, vs.THINK: 2, vs.TOOL: 2, vs.ANSWER: 3}
MONTHS = ("JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC")
DAYS = ("MON", "TUE", "WED", "THU", "FRI", "SAT", "SUN")


# ------------------------------------------------------------------ typography
def extra_fonts(fonts, font_dir=FONT_DIR):
    """Adds the landscape roles to a Fonts instance: 11 px capitals, the large clock, a 22 px figure."""
    mono = os.path.join(font_dir, "JetBrainsMono-Medium.ttf")
    bold = os.path.join(font_dir, "JetBrainsMono-SemiBold.ttf")
    fallback = fonts.small.faces[-1]

    def face(path, size):
        font = _truetype(path, size)
        return Face(font, path) if font is not None else None

    fonts.cap = FontStack([face(mono, 11), fallback])
    fonts.cap_bold = FontStack([face(bold, 11), fallback])
    fonts.clock = FontStack([face(bold, 56), fallback])
    fonts.figure = FontStack([face(bold, 22), fallback])
    return fonts


def tracked(draw, image, stack, x, mid, text, fill, track=1):
    """Letter-spaced text (capitals), vertically centred on `mid`. Returns the x after the last glyph."""
    base = int(round(mid + cap_height(stack) / 2.0))
    for ch in text:
        x = stack.draw(draw, image, x, base, ch, fill) + track
    return x - track


def tracked_width(stack, text, track=1):
    return sum(stack.advance(ch) + track for ch in text) - track


def wall_date():
    """(weekday index, day, month index) of the wall clock; fixed on the preview's manual clock."""
    import time as _time
    from . import clock
    if clock.is_manual():
        return 0, 16, 10          # Monday 16 November
    lt = _time.localtime()
    return lt.tm_wday, lt.tm_mday, lt.tm_mon - 1


# ------------------------------------------------------------------ the trace
class Trace:
    """77 columns that glide between the forms of the states. Heights ease toward their targets, so a change of state is a
    morph of the same object, never a cut. All motion is a pure function of time and the target mode."""

    def __init__(self, width=TRACE_W, height=68):
        self.w = width
        self.h = height
        self.n = (width + 1) // PITCH
        self.cy = height // 2
        self.hmax = (height - 3) // 2
        self.cur = [0.0] * self.n
        self.bri = [0.0] * self.n
        self.alert = [False] * self.n
        self.mode = "rest"
        self.last = None
        self.delta = 0.0

    # one step toward the targets of `mode`
    def step(self, mode, t, now, level=0.5, pulse=0.0):
        dt = 0.05 if self.last is None else max(0.0, min(0.1, now - self.last))
        self.last = now
        self.mode = mode
        n, hm = self.n, float(self.hmax)
        tau = 0.055 if mode in ("decode", "speak") else 0.09
        a = 1.0 - math.exp(-dt / tau) if dt > 0 else 1.0
        sn = smooth_noise
        delta = 0.0
        for i in range(n):
            env = math.sin(math.pi * (i + 0.5) / n) ** 0.3
            tg, tb, al = 0.0, 0.0, False
            if mode == "calibrate":
                tg = hm * 0.14 * (0.6 + 0.8 * sn(i * 0.3 + t * 2.5, 3))
                tb = 0.5
            elif mode == "listen":
                ph = i * 0.23 + t * 7.5
                v = sn(ph, 5) * 0.65 + sn(ph * 2.3 + 7.0, 9) * 0.35
                tg = hm * level * v * env
                tb = 0.3 + 0.7 * (i / (n - 1.0)) ** 1.4
            elif mode == "decode":
                head = ((t % 1.4) / 1.4) * (n + 6) - 3
                v = sn(i * 0.23 + 3.1, 5) * 0.65 + sn(i * 0.53 + 10.0, 9) * 0.35
                if i < head - 2:
                    tg = hm * 0.5 * (round(v * 3) / 3.0) * env      # resolved: quantised, uniform steps
                    tb = 0.55
                elif abs(i - head) <= 2:
                    tg = hm * 0.95 * (1.0 - abs(i - head) / 3.0)
                    tb = 1.0
                else:
                    tg = hm * 0.62 * v * env                          # still raw signal
                    tb = 0.3
            elif mode == "think":
                p = (t * 38.0) % (n + 24) - 12
                g = math.exp(-(((i - p) / 4.5) ** 2))
                tg = hm * (0.07 + 0.42 * g) + 0.6 * sn(i * 0.9 + t * 1.4, 4)
                tb = 0.22 + 0.78 * g
            elif mode == "tool":
                s = (t % 3.0) / 3.0
                out = s < 0.5
                p = (s / 0.5 if out else 1.0 - (s - 0.5) / 0.5) * (n + 12) - 6
                g = math.exp(-(((i - p) / 4.0) ** 2))
                tg = hm * (0.07 + (0.42 if out else 0.3) * g)
                tb = 0.22 + (0.78 if out else 0.55) * g
            elif mode == "speak":
                amp = 0.34 + 0.66 * clamp01(pulse)
                v = sn(i * 0.45 - t * 9.0, 11)
                tg = hm * amp * (0.25 + 0.75 * v) * env
                tb = 0.35 + 0.65 * amp
            elif mode == "error":
                mid = abs(i - n // 2)
                if mid <= 1:
                    tg, tb, al = hm * 0.5, 1.0, True
            elif mode == "music":
                v = sn(i * 0.37 + t * 3.2, 13) * (0.55 + 0.45 * sn(i * 0.11 - t * 1.3, 17))
                tg = hm * (0.1 + 0.8 * v) * env
                tb = 0.4 + 0.6 * v
            delta = max(delta, abs(tg - self.cur[i]))
            self.cur[i] += (tg - self.cur[i]) * a
            self.bri[i] += (tb - self.bri[i]) * a
            self.alert[i] = al
        self.delta = delta

    def key(self):
        return (self.mode, tuple(int(round(c)) for c in self.cur), tuple(int(round(b * 5)) for b in self.bri))

    def render(self, cursor=False, ticks=True):
        image = Image.new("RGB", (self.w, self.h), theme.VOID)
        d = ImageDraw.Draw(image)
        cy = self.cy
        d.line([(0, cy), (self.w - 1, cy)], fill=theme.HAIR)
        if ticks:
            for i in range(0, self.n, 8):
                x = i * PITCH
                d.line([(x, cy - 2), (x, cy + 2)], fill=theme.TICK if i % 16 == 0 else theme.HAIR)
        deep, bright = theme.ACCENT_DEEP, theme.ACCENT
        for i in range(self.n):
            hh = int(round(self.cur[i]))
            if hh <= 0:
                continue
            x = i * PITCH
            color = theme.ALERT if self.alert[i] else mix(deep, bright, self.bri[i])
            d.rectangle([x, cy - hh, x + BAR - 1, cy + hh], fill=color)
        if cursor:
            d.rectangle([0, cy - 5, 1, cy + 5], fill=theme.ACCENT)
        return image

    def animated(self):
        return any(abs(c) > 0.05 for c in self.cur) or self.mode not in ("rest",)


# ------------------------------------------------------------------ pipeline rail
class Pipeline:
    """Four stage labels on one rule; a 2 px bar slides to the active stage. `pos` is the bar's stage index (float)."""

    def __init__(self, fonts):
        self.fonts = fonts
        stack = fonts.cap_bold
        self.widths = [tracked_width(stack, s) for s in STAGES]
        total = sum(self.widths)
        gap = (TRACE_W - total) / 3.0
        x = float(LEFT)
        self.x0 = []
        for w in self.widths:
            self.x0.append(x)
            x += w + gap
        self.pos = None
        self.lit = 0.0
        self.target = None
        self.last = None

    def step(self, stage, now):
        dt = 0.05 if self.last is None else max(0.0, min(0.1, now - self.last))
        self.last = now
        a = 1.0 - math.exp(-dt / 0.085)
        if stage is None:
            self.lit += (0.0 - self.lit) * a
            if self.lit < 0.02:
                self.lit = 0.0
        else:
            if self.pos is None or self.lit < 0.05:
                self.pos = float(stage)
            else:
                self.pos += (stage - self.pos) * a
                if abs(self.pos - stage) < 0.01:
                    self.pos = float(stage)
            self.lit += (1.0 - self.lit) * a
            if self.lit > 0.98:
                self.lit = 1.0
        self.target = stage

    def moving(self):
        if self.target is None:
            return self.lit > 0.0
        return self.pos is None or abs(self.pos - self.target) > 0.01 or self.lit < 1.0

    def key(self):
        return (None if self.pos is None else round(self.pos * 24), round(self.lit * 24), self.target)

    def render(self):
        image = Image.new("RGB", (W, 16), theme.VOID)
        d = ImageDraw.Draw(image)
        rule_y = 14
        d.line([(LEFT, rule_y), (RIGHT - 1, rule_y)], fill=theme.HAIR)
        pos = self.pos if (self.pos is not None and self.lit > 0) else None
        for i, name in enumerate(STAGES):
            near = 0.0 if pos is None else clamp01(1.0 - abs(i - pos))
            if pos is None:
                color = theme.INK3
            else:
                base = theme.INK2 if i < pos - 0.5 else theme.INK3
                color = mix(base, theme.ACCENT, near * self.lit)
            tracked(d, image, self.fonts.cap_bold, int(round(self.x0[i])), 6, name, color)
        if pos is not None:
            lo = int(math.floor(pos))
            hi = min(len(STAGES) - 1, lo + 1)
            f = pos - lo
            x0 = self.x0[lo] + (self.x0[hi] - self.x0[lo]) * f
            x1 = (self.x0[lo] + self.widths[lo]) + ((self.x0[hi] + self.widths[hi]) - (self.x0[lo] + self.widths[lo])) * f
            color = mix(theme.HAIR, theme.ACCENT, self.lit)
            d.rectangle([int(round(x0)), rule_y - 1, int(round(x1)) - 1, rule_y], fill=color)
        return image


# ------------------------------------------------------------------ header
def lamp_color(color):
    return theme.INK3 if color in (theme.INK2, theme.INK3, theme.MUTED) else color


def render_header(fonts, model, show_clock):
    image = Image.new("RGB", (W, HEADER_H), theme.VOID)
    d = ImageDraw.Draw(image)
    cy = theme.STATUS_CENTER_Y
    d.rectangle([LEFT, cy - 2, LEFT + 4, cy + 2], fill=lamp_color(model["color"]))
    left = tracked(d, image, fonts.cap_bold, LEFT + 12, cy, "GLaDOS", theme.INK)
    level = model["battery_level"]
    valid = type(level) is int and 0 <= level <= 100
    text = "%d%%" % level if valid else "--%"
    tw = int(round(fonts.cap.width(text)))
    tx = RIGHT - tw
    low = valid and level <= 30
    draw_text(d, image, fonts.cap, tx, cy, text, theme.ALERT if valid and level <= 10 else theme.INK2)
    # battery: a 15 x 6 outline filled in proportion; amber-free: the accent when healthy, alert when low
    bx = tx - 22
    d.rectangle([bx, cy - 3, bx + 15, cy + 3], outline=theme.INK3)
    d.rectangle([bx + 16, cy - 1, bx + 17, cy + 1], fill=theme.INK3)
    if valid:
        fill_w = max(1 if level > 0 else 0, int(round(13 * level / 100.0)))
        if fill_w:
            d.rectangle([bx + 1, cy - 2, bx + fill_w, cy + 2], fill=theme.ALERT if low else theme.INK2)
    state = model.get("wireless_status")
    if state is None:
        wifi = model["wifi_level"]
        state = {'wifi': {'enabled': True if wifi else None,
                          'connected': False if model["network_connected"] is False else True if wifi else None,
                          'signal': {1: 20, 2: 50, 3: 90}.get(wifi)}, 'bluetooth': {}}
    radios = draw_home_wireless(image, bx - 10, cy, state)
    if show_clock and model["clock"]:
        cw = int(round(fonts.cap.width(model["clock"])))
        x = max(int((W - cw) / 2), int(left + 14))
        if x + cw <= radios - 10:
            draw_text(d, image, fonts.cap, x, cy, model["clock"], theme.INK)
    return image


# ------------------------------------------------------------------ home
def home_hint(tokens):
    if "heard" in tokens:
        return "Capri heard", True
    if tokens.get("pend") == "capri":
        return "Say Capri to answer", False
    if "pend" in tokens:
        return "Hold to answer", False
    if "capri" in tokens:
        return "Say Capri or hold to talk", False
    return "Hold to talk", False


def render_home(fonts, model, tokens, height=200):
    """The idle screen: time as the one large element, the date beside it, the resting trace, the next action."""
    image = Image.new("RGB", (W, height), theme.VOID)
    d = ImageDraw.Draw(image)
    stack = fonts.clock
    hh, mm = model["clock"].split(":") if model["clock"] else ("--", "--")
    base = 64
    x = LEFT - 2
    x = stack.draw(d, image, x, base, hh, theme.INK)
    colon_w = stack.advance(":")
    stack.draw(d, image, x, base - 2, ":", theme.INK3)
    x += colon_w
    stack.draw(d, image, x, base, mm, theme.INK)
    wd, day, mon = wall_date()
    cap = fonts.cap_bold
    tracked(d, image, cap, RIGHT - int(tracked_width(cap, DAYS[wd])), 28, DAYS[wd], theme.INK2)
    label = "%d %s" % (day, MONTHS[mon])
    tracked(d, image, cap, RIGHT - int(tracked_width(cap, label)), 44, label, theme.INK3)
    # the hint
    text, accent = home_hint(tokens)
    mid = 134
    end = tracked(d, image, fonts.cap_bold, LEFT, mid, "READY" if not accent else "HEARD", theme.ACCENT)
    draw_text(d, image, fonts.small, int(end + 12), mid, fit_text(fonts.small, text, RIGHT - end - 14), theme.INK if accent else theme.INK2)
    return image


# ------------------------------------------------------------------ live pane
def render_live_text(fonts, state, t, tokens, transcript, height=200):
    """Caption and the recognised words under the trace of the listening / recognising / thinking panes (pane coords)."""
    image = Image.new("RGB", (W, height), theme.VOID)
    d = ImageDraw.Draw(image)
    third = ""
    if state == vs.LISTEN:
        title = "Listening"
        if "audio" in tokens:
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
        title, sub = "Recognizing speech", ""
    elif state == vs.THINK:
        title, sub = "Thinking", "" if transcript else "Preparing response"
    elif state == vs.CALIBRATE:
        title, sub = "Calibrating", "Mic level"
    else:
        title, sub = "", ""
    y = 0
    draw_text(d, image, fonts.title, LEFT, y + 8, title, theme.INK)
    if third:
        draw_text(d, image, fonts.small, RIGHT - int(fonts.small.width(third)), y + 8, third, theme.INK3)
    quote = wrap_quote(fonts.small, transcript, TRACE_W - 10, 3) if state in (vs.TRANSCRIBE, vs.THINK) else []
    if quote:
        top = 30
        d.line([(LEFT, top - 5), (LEFT, top - 5 + QUOTE_LINE * len(quote) - 3)], fill=theme.INK3, width=2)
        for index, line in enumerate(quote):
            draw_text(d, image, fonts.small, LEFT + 10, top + 3 + index * QUOTE_LINE, line, theme.INK2)
    elif sub:
        draw_text(d, image, fonts.small, LEFT, y + 28, sub, theme.INK2)
    return image


QUOTE_LINE = 16
HEARD_PAD = 6


def wrap_quote(stack, text, width, max_lines=2):
    """Greedy word wrap of what the user said, in typographic quotes; never alters the words (only an overlong tail is cut)."""
    text = " ".join((text or "").split())
    if not text:
        return []
    text = "“" + text + "”"
    words, lines, current, i = text.split(" "), [], "", 0
    while i < len(words):
        trial = (current + " " + words[i]).strip()
        if stack.width(trial) <= width or not current:
            current = trial
            i += 1
        else:
            lines.append(current)
            current = ""
            if len(lines) == max_lines:
                break
    if len(lines) < max_lines and current:
        lines.append(current)
        current = ""
    elif len(lines) == max_lines and i < len(words) or (current and len(lines) == max_lines):
        rest = " ".join([lines[-1]] + ([current] if current else []) + words[i:])
        lines[-1] = fit_text(stack, rest, width)
    return [fit_text(stack, line, width) for line in lines]


def heard_height(fonts, text, max_lines=2):
    lines = wrap_quote(fonts.small, text, TRACE_W - 10, max_lines)
    return HEARD_PAD * 2 + QUOTE_LINE * len(lines) - 4 if lines else 0


def render_heard(fonts, text, max_lines=2):
    """What recognition returned, quoted in the secondary voice with a rule on its left, under the answer."""
    lines = wrap_quote(fonts.small, text, TRACE_W - 10, max_lines)
    height = heard_height(fonts, text, max_lines)
    image = Image.new("RGB", (W, max(1, height)), theme.VOID)
    d = ImageDraw.Draw(image)
    d.line([(LEFT, HEARD_PAD - 1), (LEFT, height - HEARD_PAD + 1)], fill=theme.INK3, width=2)
    for index, line in enumerate(lines):
        draw_text(d, image, fonts.small, LEFT + 10, HEARD_PAD + 6 + index * QUOTE_LINE, line, theme.INK2)
    return image


# ------------------------------------------------------------------ compact pane (tool, error, confirm, music ...)
def render_compact_caption(fonts, label, color, right, right_color, progress, height=22):
    image = Image.new("RGB", (W, height), theme.VOID)
    d = ImageDraw.Draw(image)
    mid = height // 2
    lamp = lamp_color(color)
    d.rectangle([LEFT, mid - 2, LEFT + 4, mid + 2], fill=lamp)
    end = draw_text(d, image, fonts.small_bold, LEFT + 12, mid, fit_text(fonts.small_bold, label, 130), theme.INK)
    if right:
        stack = fonts.small
        text = fit_text(stack, right, RIGHT - end - 12)
        draw_text(d, image, stack, int(RIGHT - stack.width(text)), mid, text, right_color if right_color != theme.MUTED else theme.INK3)
    if progress is not None:
        y = height - 2
        d.line([(LEFT, y), (RIGHT - 1, y)], fill=theme.HAIR)
        fill_x = LEFT + int((RIGHT - 1 - LEFT) * clamp01(progress))
        if fill_x > LEFT:
            d.line([(LEFT, y), (fill_x, y)], fill=theme.ACCENT)
    return image


# ------------------------------------------------------------------ strip (answer / speaking)
STRIP_H = 24
STRIP_SPEAKING = "SPEAKING"
STRIP_RECEIVING = "WRITING"
STRIP_RESPONSE = "RESPONSE"


def _seconds(value):
    try:
        return "%.1fs" % max(0.0, float(value))
    except (TypeError, ValueError):
        return ""


def render_strip(fonts, mode, tokens):
    """The line above the answer: what the device is doing, then (at x=100..) the mini trace is pasted by the caller."""
    image = Image.new("RGB", (W, STRIP_H), theme.VOID)
    d = ImageDraw.Draw(image)
    mid = 11
    live = mode != STRIP_RESPONSE
    d.rectangle([LEFT, mid - 2, LEFT + 4, mid + 2], fill=theme.ACCENT if live else theme.INK3)
    end = tracked(d, image, fonts.cap_bold, LEFT + 12, mid, mode, theme.INK if live else theme.INK2)
    hint = ""
    if mode == STRIP_RESPONSE:
        measured = _seconds(tokens.get("act")) if "act" in tokens else _seconds(tokens.get("resp")) if "resp" in tokens else ""
        if "heard" in tokens:
            hint = "Capri heard"
        elif tokens.get("pend") == "capri":
            hint = "Capri to answer"
        elif "pend" in tokens:
            hint = "Hold to answer"
        elif "capri" in tokens:
            hint = "Say Capri"
        if measured and not hint:
            hint = ("action " if "act" in tokens else "") + measured
    if hint:
        text = fit_text(fonts.cap, hint, 96)
        draw_text(d, image, fonts.cap, RIGHT - int(fonts.cap.width(text)), mid, text, theme.ACCENT if "heard" in tokens else theme.INK3)
    d.line([(LEFT, STRIP_H - 1), (RIGHT - 1, STRIP_H - 1)], fill=theme.HAIR)
    return image, int(end)


# ------------------------------------------------------------------ terminal output + confirmation
TERMINAL_H = 64
TERMINAL_LINE_H = 10
TERMINAL_MAX_LINES = 4
APPROVAL_H = 34


def terminal_lines(text):
    lines = [line for line in (text or "").replace("\r\n", "\n").replace("\r", "\n").split("\n") if line]
    return lines[-TERMINAL_MAX_LINES:]


def render_terminal(fonts, text):
    image = Image.new("RGB", (W, TERMINAL_H), theme.VOID)
    d = ImageDraw.Draw(image)
    end = tracked(d, image, fonts.cap_bold, LEFT, 8, "OUTPUT", theme.INK2)
    d.line([(int(end) + 8, 8), (RIGHT - 1, 8)], fill=theme.HAIR)
    stack = fonts.meta
    for index, line in enumerate(terminal_lines(text)):
        stack.draw(d, image, LEFT, 26 + index * TERMINAL_LINE_H + 2, fit_text(stack, line.expandtabs(2), TRACE_W), theme.INK2)
    d.line([(LEFT, TERMINAL_H - 1), (RIGHT - 1, TERMINAL_H - 1)], fill=theme.HAIR)
    return image


def render_approval(fonts):
    image = Image.new("RGB", (W, APPROVAL_H), theme.VOID)
    d = ImageDraw.Draw(image)
    d.line([(LEFT, 0), (RIGHT - 1, 0)], fill=theme.HAIR)
    mid = APPROVAL_H // 2 - 1
    for x, key, label, key_color in ((LEFT + 2, "HOLD", "Cancel", theme.INK3), (W // 2 + 10, "TAP", "Allow", theme.ACCENT)):
        end = tracked(d, image, fonts.cap_bold, x, mid, key, key_color)
        draw_text(d, image, fonts.small_bold, int(end + 8), mid, label, theme.INK)
    return image


# ------------------------------------------------------------------ body edges
def fade_body(image, top, bottom, depth=16):
    """Text that continues past the pane's edge fades out over `depth` rows instead of being cut through a glyph."""
    import numpy as np
    arr = np.asarray(image).astype(np.float32)
    h = arr.shape[0]
    if top and h > depth * 2:
        ramp = ((np.arange(depth, dtype=np.float32) + 1.0) / (depth + 1.0)) ** 1.6
        arr[:depth] *= ramp[:, None, None]
    if bottom and h > depth * 2:
        ramp = ((np.arange(depth, dtype=np.float32) + 1.0) / (depth + 1.0)) ** 1.6
        arr[h - depth:] *= ramp[::-1][:, None, None]
    return Image.fromarray(arr.astype(np.uint8), "RGB")


# ------------------------------------------------------------------ boot
def render_boot(fonts, t):
    image = Image.new("RGB", (W, 200), theme.VOID)
    d = ImageDraw.Draw(image)
    title = "WHISPLAY"
    width = tracked_width(fonts.figure, title, 3)
    tracked(d, image, fonts.figure, int((W - width) / 2), 70, title, theme.INK, 3)
    x0, x1, y = 96, 184, 96
    d.line([(x0, y), (x1, y)], fill=theme.HAIR)
    p = ease_in_out((t % 2.4) / 2.4)
    seg = 24
    sx = int(x0 + (x1 - x0 - seg) * p)
    d.line([(sx, y), (sx + seg, y)], fill=theme.ACCENT)
    return image
