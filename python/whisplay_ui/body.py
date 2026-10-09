"""Body text area: streamed typewriter reveal, phosphor/decode on fresh
glyphs, block cursor, tool-call chips, scrolling and speech focus."""
import math

from PIL import Image, ImageDraw

from . import theme
from .draw_util import draw_text, fit_text, hash01, mix
from .text_layout import build_layout, is_break
from .typewriter import ECHO, INSTANT, STREAM, Typewriter

SENTENCE_END = frozenset(".!?…。！？")

SCRAMBLE = "#$%&*+<>?@=/\\01"
AUTO_HOLD = 1.5
DECODE_TAIL = 3          # only the newest few glyphs get the decode scramble
LINE_CACHE_MAX = 256
FOCUS_TIMEOUT = 3.0
FOLLOW_EPS = 0.4

TONE_TEXT = "text"
TONE_ECHO = "echo"
TONE_MUTED = "muted"
TONE_COLORS = {
    TONE_TEXT: theme.TEXT,
    TONE_ECHO: theme.GREEN,
    TONE_MUTED: theme.MUTED,
}


class Body:
    def __init__(self, fonts, flags):
        self.fonts = fonts
        self.flags = flags
        self.stack = fonts.body
        self.tw = Typewriter()
        self.layout = build_layout([], self.stack, theme.TEXT_WIDTH)
        self.items = []
        self.char_offset = 0
        self.tone = TONE_TEXT
        self.scroll = 0.0
        self.target = 0.0
        self.height = 0
        self.content_at = -1e9
        self.fade_at = -1e9
        self.focus_char = None
        self.speech_until = -1e9
        self.speech_seen = False
        self.scroll_factor = 1.0
        self.quality = 0
        self.last_key = None
        self.line_cache = {}

    # ------------------------------------------------------------ content
    def _relayout(self, items):
        self.items = items
        self.layout = build_layout(items, self.stack, theme.TEXT_WIDTH)

    def replace(self, items, char_offset, mode, now, fade=True):
        self._relayout(items)
        self.char_offset = char_offset
        self.tw.reset(self.layout.total_units, mode, now)
        self.scroll = 0.0
        self.target = 0.0
        self.content_at = now
        self.fade_at = now if fade else -1e9
        self.focus_char = None
        self.speech_until = -1e9
        self.speech_seen = False
        self.last_key = None
        self.line_cache = {}

    def extend(self, items, now):
        self._relayout(items)
        self.tw.grow(self.layout.total_units, now)
        self.last_key = None

    def common_prefix(self, items):
        """Units shared at the start of the current layout and `items`."""
        new = build_layout(items, self.stack, theme.TEXT_WIDTH)
        old_chars, new_chars = self.layout.unit_chars, new.unit_chars
        limit = min(len(old_chars), len(new_chars))
        p = 0
        while p < limit and old_chars[p] == new_chars[p]:
            p += 1
        return new, p

    def edit(self, layout, items, char_offset, prefix, now):
        """Text changed in place (tool tag inserted, elapsed time updated):
        keep what was already typed instead of retyping from the start."""
        backlog = max(0.0, self.tw.total - self.tw.revealed)
        revealed = self.tw.revealed
        self.items = items
        self.layout = layout
        self.char_offset = char_offset
        total = layout.total_units
        if prefix < revealed:
            revealed = max(float(prefix), total - backlog)
            del self.tw.times[prefix:]
        self.tw.total = total
        self.tw.revealed = max(0.0, min(float(total), revealed))
        shown = int(self.tw.revealed)
        while len(self.tw.times) < shown:
            self.tw.times.append(-1e9)  # already-read text: no phosphor flash
        self.tw.last_growth = now
        self.last_key = None

    def slide(self, items, char_offset, now):
        """The 2200-char window moved: keep the same unrevealed backlog."""
        backlog = max(0.0, self.tw.total - self.tw.revealed)
        old_shown = self.tw.shown
        self._relayout(items)
        if self.focus_char is not None:
            self.focus_char = max(0, self.focus_char - (char_offset - self.char_offset))
        self.char_offset = char_offset
        total = self.layout.total_units
        revealed = max(0.0, total - backlog)
        drop = old_shown - int(revealed)
        if drop > 0:
            del self.tw.times[:drop]
        self.tw.total = total
        self.tw.revealed = revealed
        self.tw.last_growth = now
        self.last_key = None

    def speech(self, char_end, duration_ms, now):
        # char_end counts from the start of the full text, like the classic UI.
        self.focus_char = max(0, int(char_end) - self.char_offset)
        self.speech_until = now + max(0.0, duration_ms) / 1000.0 + 0.2
        self.speech_seen = True

    def speaking(self, now):
        return now < self.speech_until

    def focus_active(self, now):
        return (
            self.flags.speech_focus
            and self.focus_char is not None
            and now < self.speech_until + FOCUS_TIMEOUT
        )

    # ------------------------------------------------------------- timing
    def reveal_limit(self, now):
        layout = self.layout
        total = layout.total_units
        if self.tw.mode != STREAM or now - self.tw.last_growth >= theme.TW_HOLD:
            return total
        chars = layout.unit_chars
        # A word that ends in sentence punctuation is complete: no need to wait
        # for more text (the last word of a spoken sentence would lag 0.3 s).
        if total > 0 and chars[total - 1] in SENTENCE_END:
            return total
        i = total
        while i > 0 and total - i < theme.TW_HOLD_CHARS and not is_break(chars[i - 1]):
            i -= 1
        if total - i >= theme.TW_HOLD_CHARS:
            return total
        return i

    def content_height(self):
        return theme.BODY_PAD * 2 + len(self.layout.lines) * theme.LINE_H

    def max_scroll(self):
        return max(0, self.content_height() - self.height)

    def update(self, now, dt, height):
        self.height = height
        self.tw.update(now, dt, self.reveal_limit(now))
        max_scroll = self.max_scroll()
        lh = theme.LINE_H
        speech_target = None
        if self.focus_char is not None and self.speech_seen:
            line, _ = self.layout.line_for_char(self.focus_char)
            speech_target = theme.BODY_PAD + line * lh - height * 0.4
        if self.tw.mode in (STREAM, ECHO):
            line, _ = self.layout.cursor_for(self.tw.shown)
            stream_target = theme.BODY_PAD * 2 + (line + 1) * lh - height
            if speech_target is not None and self.flags.speech_focus:
                target = speech_target
            else:
                target = max(self.target, stream_target, speech_target if speech_target is not None else 0)
        else:
            target = self.target
            if speech_target is not None:
                target = max(target, speech_target)
            elif self.scroll_factor > 0 and now - self.content_at >= AUTO_HOLD and target < max_scroll:
                target += theme.AUTO_SCROLL_PX * self.scroll_factor * dt
        self.target = max(0.0, min(float(max_scroll), target))
        diff = self.target - self.scroll
        if abs(diff) <= FOLLOW_EPS:
            self.scroll = self.target
        else:
            self.scroll += diff * (1.0 - math.exp(-dt / theme.FOLLOW_TAU))

    def fps_needed(self, now):
        """Frame rate the body needs right now (0 = static)."""
        if self.tw.busy():
            return 30
        if self.tw.times and now - self.tw.times[-1] < theme.PHOSPHOR:
            return 30
        if abs(self.target - self.scroll) > FOLLOW_EPS:
            return 30
        if now - self.fade_at < theme.TEXT_FADE:
            return 30
        if (
            self.tw.mode == INSTANT
            and self.scroll_factor > 0
            and self.target < self.max_scroll()
        ):
            if now - self.content_at < AUTO_HOLD:
                return 0
            return 20
        return 0

    def next_event(self, now):
        """Seconds until the body changes without new input (None = never)."""
        waits = []
        if self.tw.mode == INSTANT and self.scroll_factor > 0 and self.target < self.max_scroll():
            if now - self.content_at < AUTO_HOLD:
                waits.append(AUTO_HOLD - (now - self.content_at))
        if self.tw.mode == STREAM:
            idle = now - self.tw.last_growth
            if self.reveal_limit(now) < self.layout.total_units:
                waits.append(theme.TW_HOLD - idle)
            for edge in (theme.WRITING_WINDOW, theme.WAITING_WINDOW, theme.WAITING_WINDOW + theme.DONE_OUTLINE):
                if idle < edge:
                    waits.append(edge - idle)
            if self.tw.cursor_state(now) == "waiting":
                waits.append(_blink_edge(idle))
        if self.focus_char is not None:
            end = self.speech_until + FOCUS_TIMEOUT
            if now < end:
                waits.append(end - now)
        waits = [w for w in waits if w > 0]
        return min(waits) if waits else None

    # ------------------------------------------------------------- render
    def cursor(self, now):
        state = self.tw.cursor_state(now)
        if state in ("none", "hidden"):
            return None
        if state == "waiting":
            idle = now - self.tw.last_growth
            if (idle % theme.BLINK_PERIOD) >= theme.BLINK_ON:
                return None
        line, x = self.layout.cursor_for(self.tw.shown)
        if theme.TEXT_LEFT + x + theme.CURSOR_W > theme.CURSOR_RIGHT_LIMIT:
            line, x = line + 1, 0.0
        return state, line, int(round(x))

    def render_key(self, now, height):
        fresh = self.tw.fresh_start(now) < self.tw.shown if self.tw.mode == STREAM else False
        return (
            id(self.layout),
            self.tw.shown,
            int(round(self.scroll)),
            self.cursor(now),
            self.focus_unit(now),
            self.tone,
            height,
            self.quality,
            fresh,
            now - self.fade_at < theme.TEXT_FADE,
        )

    def focus_unit(self, now):
        if not self.focus_active(now):
            return None
        _, unit = self.layout.line_for_char(self.focus_char)
        # Node's char_end is approximate; never split a word at the boundary.
        chars = self.layout.unit_chars
        while 0 < unit < len(chars) and not is_break(chars[unit - 1]):
            unit += 1
        return unit

    def changed(self, now, height):
        key = self.render_key(now, height)
        if key[-2] or key[-1] or key != self.last_key:
            self.last_key = key
            return True
        return False

    def render(self, now, height):
        image = Image.new("RGB", (theme.WIDTH, max(1, height)), theme.VOID)
        draw = ImageDraw.Draw(image)
        layout = self.layout
        shown = self.tw.shown
        base = TONE_COLORS.get(self.tone, theme.TEXT)
        focus = self.focus_unit(now)
        fresh_from = self.tw.fresh_start(now) if self.tw.mode == STREAM else shown
        decode = self.flags.decode and self.quality == 0
        scroll = int(round(self.scroll))
        lh = theme.LINE_H
        for index, line in enumerate(layout.lines):
            top = theme.BODY_PAD + index * lh - scroll
            if top + lh <= 0:
                continue
            if top >= height:
                break
            if line.unit_start >= shown and not (line.kind == "blank"):
                break
            if line.kind == "tag":
                fresh = line.unit_start >= fresh_from
                self._draw_tag(draw, image, line.tag, top, fresh)
            elif line.kind == "text":
                if line.unit_end <= shown and line.unit_end <= fresh_from:
                    image.paste(self._line_image(line, base, focus), (0, top))
                else:
                    self._draw_line(draw, image, line, top, shown, base, focus, fresh_from, decode, now)
        cur = self.cursor(now)
        if cur is not None:
            state, line_index, x = cur
            top = theme.BODY_PAD + line_index * lh - scroll + theme.CURSOR_DY
            x0 = theme.TEXT_LEFT + x
            box = [x0, top, x0 + theme.CURSOR_W - 1, top + theme.CURSOR_H - 1]
            if state == "done":
                draw.rectangle(box, outline=theme.GREEN_DIM)
            else:
                draw.rectangle(box, fill=theme.GREEN)
        self._draw_scrollbar(draw, height)
        fade = (now - self.fade_at) / theme.TEXT_FADE
        if 0 <= fade < 1:
            image = Image.blend(Image.new("RGB", image.size, theme.VOID), image, max(0.0, fade))
        return image

    def _line_image(self, line, base, focus):
        """Cached image of a fully revealed, settled text line."""
        split = None
        if focus is not None and base == theme.TEXT:
            split = max(0, min(line.unit_end, focus) - line.unit_start)
        key = (line.key, base, split)
        image = self.line_cache.get(key)
        if image is None:
            if len(self.line_cache) >= LINE_CACHE_MAX:
                self.line_cache.clear()
            image = Image.new("RGB", (theme.WIDTH, theme.LINE_H), theme.VOID)
            self._draw_line(ImageDraw.Draw(image), image, line, 0, line.unit_end, base, focus, line.unit_end, False, 0.0)
            self.line_cache[key] = image
        return image

    def _draw_line(self, draw, image, line, top, shown, base, focus, fresh_from, decode, now):
        stack = self.stack
        baseline = top + theme.BASELINE
        run = []
        run_x = 0.0
        run_color = None

        def flush():
            if run:
                stack.draw(draw, image, theme.TEXT_LEFT + run_x, baseline, "".join(run), run_color)

        for ch, unit, x, _w in line.glyphs:
            if unit >= shown:
                break
            if unit >= fresh_from:
                flush()
                run = []
                run_color = None
                stamp = self.tw.times[unit] if unit < len(self.tw.times) else now
                age = max(0.0, now - stamp)
                window = theme.DECODE_BASE + (unit % 4) * theme.DECODE_STAGGER
                if decode and age < window and unit >= shown - DECODE_TAIL and not ch.isspace():
                    glyph = SCRAMBLE[int(hash01(unit, int(now / 0.03)) * len(SCRAMBLE))]
                    stack.draw(draw, image, theme.TEXT_LEFT + x, baseline, glyph, theme.GREEN)
                else:
                    color = mix(theme.BRIGHT, base, age / theme.PHOSPHOR)
                    stack.draw(draw, image, theme.TEXT_LEFT + x, baseline, ch, color)
                continue
            color = theme.DIM if (focus is not None and unit >= focus and base == theme.TEXT) else base
            if color != run_color:
                flush()
                run = []
                run_color = color
                run_x = x
            run.append(ch)
        flush()

    def _draw_tag(self, draw, image, tag, top, fresh):
        fonts = self.fonts
        label = str(tag.get("label", "") or "tool")
        suffix = []
        count = int(tag.get("count", 1) or 1)
        if count > 1:
            suffix.append("x%d" % count)
        if tag.get("elapsed"):
            suffix.append(str(tag.get("elapsed")))
        suffix = " ".join(suffix)
        stack = fonts.meta_bold
        pad = 6
        suffix_w = stack.width(suffix) + 6 if suffix else 0
        label = fit_text(stack, "% " + label, theme.TEXT_WIDTH - 2 * pad - suffix_w)
        width = int(stack.width(label) + suffix_w + 2 * pad)
        x0 = theme.TEXT_LEFT
        y0, y1 = top + 2, top + theme.LINE_H - 3
        mid = (y0 + y1) / 2.0
        draw.rectangle([x0, y0, x0 + width, y1], fill=theme.RAISED, outline=theme.CYAN if fresh else theme.CYAN_DIM)
        end = draw_text(draw, image, stack, x0 + pad, mid, label, theme.CYAN)
        if suffix:
            draw_text(draw, image, stack, end + 6, mid, suffix, theme.DIM)

    def _draw_scrollbar(self, draw, height):
        content = self.content_height()
        if content <= height or height <= 20:
            return
        track_top, track_bottom = 4, height - 12
        span = track_bottom - track_top
        thumb = max(8, int(span * height / float(content)))
        pos = track_top + int((span - thumb) * (self.scroll / float(max(1, content - height))))
        x = theme.WIDTH - 6
        draw.line([(x, pos), (x, pos + thumb)], fill=theme.GREEN_DIM)


def _blink_edge(idle):
    phase = idle % theme.BLINK_PERIOD
    if phase < theme.BLINK_ON:
        return theme.BLINK_ON - phase
    return theme.BLINK_PERIOD - phase
