"""Wraps display items into body lines and maps typewriter units to positions.

Input items come from RenderThread.build_main_text_lines (unwrapped): strings
are paragraphs ("" is a blank line) and dicts are tool tags. Every character
and every tool tag is one typewriter "unit".
"""
from .fonts import ZERO_WIDTH

TAG_UNIT_CHAR = "\x00"


def is_cjk(ch):
    code = ord(ch)
    return (
        0x2E80 <= code <= 0x9FFF
        or 0xAC00 <= code <= 0xD7AF
        or 0xF900 <= code <= 0xFAFF
        or 0xFF00 <= code <= 0xFFEF
        or 0x3000 <= code <= 0x303F
    )


def is_break(ch):
    """A position the typewriter may stop at without splitting a word."""
    return ch == TAG_UNIT_CHAR or ch.isspace() or is_cjk(ch)


class Line:
    __slots__ = ("kind", "glyphs", "tag", "unit_start", "unit_end", "text_len", "key")

    def __init__(self, kind, unit_start, tag=None):
        self.kind = kind          # "text", "blank" or "tag"
        self.glyphs = []          # (char, unit, x, width)
        self.tag = tag
        self.unit_start = unit_start
        self.unit_end = unit_start
        self.text_len = 0
        self.key = None


class Layout:
    __slots__ = ("lines", "total_units", "unit_line", "unit_xend", "unit_chars")

    def __init__(self):
        self.lines = []
        self.total_units = 0
        self.unit_line = []
        self.unit_xend = []       # None for a tag: the cursor goes to the next line
        self.unit_chars = []

    def first_text_line(self):
        for index, line in enumerate(self.lines):
            if line.kind != "tag":
                return index
        return 0

    def cursor_for(self, revealed):
        """(line index, x) of the cursor after `revealed` units."""
        if revealed <= 0 or not self.unit_line:
            return self.first_text_line(), 0.0
        unit = min(revealed, len(self.unit_line)) - 1
        x_end = self.unit_xend[unit]
        if x_end is None:
            return self.unit_line[unit] + 1, 0.0
        return self.unit_line[unit], x_end

    def line_for_char(self, char_end):
        """(line index, unit) after `char_end` characters of the text.

        Units are the text's own characters (wrapping keeps the spaces), so each
        unit counts 1; tool-tag units count 0, like Node's speech positions.
        Counting one extra character per line break (the classic renderer's
        rule) placed the speech focus up to a word per line too early: the end
        of a long answer stayed dimmed and the scroll fell behind."""
        if not self.lines:
            return 0, 0
        count = 0
        for unit, ch in enumerate(self.unit_chars):
            if count >= char_end:
                return self.unit_line[unit], unit
            if ch != TAG_UNIT_CHAR:
                count += 1
        last = self.lines[-1]
        return len(self.lines) - 1, last.unit_end


def build_layout(items, stack, max_width):
    layout = Layout()
    unit = 0

    def finish(line):
        line.unit_end = unit
        chars = "".join(glyph[0] for glyph in line.glyphs)
        line.text_len = len(chars)
        tag = line.tag
        tag_key = (tag.get("label", ""), tag.get("count", 1), tag.get("elapsed", "")) if tag else None
        line.key = (line.kind, line.unit_start, chars, tag_key)
        layout.lines.append(line)

    def add_glyph(line, ch, x, width):
        nonlocal unit
        line.glyphs.append((ch, unit, x, width))
        layout.unit_line.append(len(layout.lines))
        layout.unit_xend.append(x + width)
        layout.unit_chars.append(ch)
        unit += 1

    for item in items:
        if isinstance(item, dict):
            line = Line("tag", unit, tag=item)
            layout.unit_line.append(len(layout.lines))
            layout.unit_xend.append(None)
            layout.unit_chars.append(TAG_UNIT_CHAR)
            unit += 1
            finish(line)
            continue
        text = str(item)
        if not text:
            finish(Line("blank", unit))
            continue

        line = Line("text", unit)
        width = 0.0
        visible = False
        index = 0
        length = len(text)
        while index < length:
            ch = text[index]
            if ch.isspace() or ch in ZERO_WIDTH:
                advance = stack.advance(ch) if ch not in ZERO_WIDTH else 0.0
                # Spaces stay on the current line even past the edge; they are invisible.
                add_glyph(line, ch, width, advance)
                width += advance
                index += 1
                continue
            if is_cjk(ch):
                advance = stack.advance(ch)
                if visible and width + advance > max_width:
                    finish(line)
                    line, width, visible = Line("text", unit), 0.0, False
                add_glyph(line, ch, width, advance)
                width += advance
                visible = True
                index += 1
                continue
            end = index
            word_width = 0.0
            while end < length and not (text[end].isspace() or text[end] in ZERO_WIDTH or is_cjk(text[end])):
                word_width += stack.advance(text[end])
                end += 1
            if visible and width + word_width > max_width and word_width <= max_width:
                finish(line)
                line, width, visible = Line("text", unit), 0.0, False
            for k in range(index, end):
                advance = stack.advance(text[k])
                if visible and width + advance > max_width:
                    finish(line)
                    line, width, visible = Line("text", unit), 0.0, False
                add_glyph(line, text[k], width, advance)
                width += advance
                visible = True
            index = end
        finish(line)

    if not layout.lines:
        finish(Line("blank", 0))
    layout.total_units = unit
    return layout
