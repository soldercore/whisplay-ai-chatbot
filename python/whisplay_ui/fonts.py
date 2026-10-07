"""Font stacks with per-glyph fallback.

Each role (body, prompt, meta, pixel labels) is a FontStack: the design face
first, then the base font (NotoSansSC-Bold.ttf or CUSTOM_FONT_PATH), then
Pillow's built-in font. A missing optional font never stops the UI; glyphs the
primary face lacks (CJK, symbols) are drawn with the next face that has them,
on a shared baseline.
"""
import os
import unicodedata

from PIL import Image, ImageDraw, ImageFont

try:  # optional: exact coverage from the font's cmap
    from fontTools.ttLib import TTFont as _TTFont
except Exception:  # pragma: no cover - depends on the system
    _TTFont = None

FONT_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "fonts")
ZERO_WIDTH = frozenset("​‌‍⁠︎️")
_MISSING = object()
GLYPH_CACHE_MAX = 4096
_CMAP_CACHE = {}


def _truetype(path, size):
    if not path:
        return None
    try:
        return ImageFont.truetype(path, size)
    except Exception:
        return None


def _default_font(size):
    try:
        return ImageFont.load_default(size=size)
    except TypeError:  # Pillow < 10.1 has no size argument
        return ImageFont.load_default()
    except Exception:
        return ImageFont.load_default()


def _cmap_for(path):
    if _TTFont is None or not path:
        return None
    if path not in _CMAP_CACHE:
        try:
            _CMAP_CACHE[path] = frozenset(_TTFont(path, lazy=True).getBestCmap().keys())
        except Exception:
            _CMAP_CACHE[path] = None
    return _CMAP_CACHE[path]


def is_emoji_candidate(ch):
    code = ord(ch)
    if code >= 0x1F000:
        return True
    return code >= 0x2000 and unicodedata.category(ch) == "So"


class Face:
    """One loaded font plus a glyph-coverage cache."""

    def __init__(self, font, path=None, pixel=False, check_coverage=True):
        self.font = font
        self.path = path
        self.pixel = pixel
        self.freetype = isinstance(font, ImageFont.FreeTypeFont)
        self.ascent = font.getmetrics()[0] if self.freetype else 8
        self._check = check_coverage
        self._cover = {}
        self._notdef = None
        self._cmap = _cmap_for(path) if (check_coverage and self.freetype) else None
        self._glyphs = {}

    def glyph(self, ch):
        """Cached (mask, dx, dy) for one glyph, relative to (x, baseline).
        Pasting cached masks is far cheaper than FreeType rendering per frame."""
        cached = self._glyphs.get(ch, _MISSING)
        if cached is _MISSING:
            if len(self._glyphs) >= GLYPH_CACHE_MAX:  # bound memory for long CJK sessions
                self._glyphs.clear()
            cached = None
            try:
                bbox = self.font.getbbox(ch, anchor="ls")
                width, height = bbox[2] - bbox[0], bbox[3] - bbox[1]
                if width > 0 and height > 0:
                    mask = Image.new("L", (width, height), 0)
                    mask_draw = ImageDraw.Draw(mask)
                    if self.pixel:
                        mask_draw.fontmode = "1"
                    mask_draw.text((-bbox[0], -bbox[1]), ch, font=self.font, fill=255, anchor="ls")
                    cached = (mask, bbox[0], bbox[1])
            except Exception:
                cached = None
            self._glyphs[ch] = cached
        return cached

    def _signature(self, ch):
        bbox = self.font.getbbox(ch)
        width = max(1, bbox[2] - bbox[0])
        height = max(1, bbox[3] - bbox[1])
        img = Image.new("L", (width, height))
        ImageDraw.Draw(img).text((-bbox[0], -bbox[1]), ch, font=self.font, fill=255)
        return bbox, img.tobytes()

    def covers(self, ch):
        hit = self._cover.get(ch)
        if hit is not None:
            return hit
        if ch.isspace() or ch in ZERO_WIDTH or not self._check:
            ok = True
        elif not self.freetype:
            ok = ord(ch) < 128
        elif self._cmap is not None:
            ok = ord(ch) in self._cmap
        else:
            try:
                if self._notdef is None:
                    self._notdef = self._signature("\U0010ffff")
                ok = self._signature(ch) != self._notdef
            except Exception:
                ok = False
        self._cover[ch] = ok
        return ok

    def length(self, text):
        if self.freetype:
            return self.font.getlength(text)
        try:
            return self.font.getlength(text)
        except Exception:
            bbox = self.font.getbbox(text)
            return bbox[2] - bbox[0]


class FontStack:
    """Ordered faces for one typographic role."""

    def __init__(self, faces, emoji_loader=None, emoji_size=None):
        self.faces = [face for face in faces if face is not None]
        self.primary = self.faces[0]
        self.ascent = self.primary.ascent
        self.emoji_loader = emoji_loader
        self.emoji_size = emoji_size
        self._face_for = {}
        self._advance = {}
        self._emoji = {}

    def face_for(self, ch):
        face = self._face_for.get(ch)
        if face is None:
            face = self.faces[-1]
            for candidate in self.faces:
                if candidate.covers(ch):
                    face = candidate
                    break
            self._face_for[ch] = face
        return face

    def emoji(self, ch):
        if self.emoji_loader is None or not ch or not is_emoji_candidate(ch[0]):
            return None
        cached = self._emoji.get(ch, _MISSING)
        if cached is _MISSING:
            cached = None
            try:
                cached = self.emoji_loader(ch, self.emoji_size)
            except Exception:
                cached = None
            self._emoji[ch] = cached
        return cached

    def advance(self, ch):
        width = self._advance.get(ch)
        if width is None:
            if ch in ZERO_WIDTH:
                width = 0.0
            else:
                image = self.emoji(ch)
                width = float(image.width) if image is not None else float(self.face_for(ch).length(ch))
            self._advance[ch] = width
        return width

    def width(self, text):
        return sum(self.advance(ch) for ch in text)

    def draw(self, draw, image, x, baseline, text, fill):
        """Draw text with its left edge at x and baseline at `baseline`.
        Glyphs are placed one by one with the same advances the layout uses.
        Returns the x after the last glyph."""
        cursor = x
        base_y = int(round(baseline))
        for ch in text:
            if ch in ZERO_WIDTH:
                continue
            emoji = self.emoji(ch)
            if emoji is not None:
                top = int(round(baseline - emoji.height + 2))
                image.paste(emoji, (int(round(cursor)), top), emoji)
                cursor += emoji.width
                continue
            if not ch.isspace():
                face = self.face_for(ch)
                if face.freetype:
                    glyph = face.glyph(ch)
                    if glyph is not None:
                        mask, dx, dy = glyph
                        px = int(round(cursor)) + dx
                        py = base_y + dy
                        image.paste(fill, (px, py, px + mask.width, py + mask.height), mask)
                else:
                    _draw_run(draw, face, cursor, baseline, ch, fill)
            cursor += self.advance(ch)
        return cursor


def _draw_run(draw, face, x, baseline, text, fill):
    if not text.strip():
        return
    old_mode = getattr(draw, "fontmode", "L")
    if face.pixel:
        draw.fontmode = "1"
    try:
        if face.freetype:
            draw.text((int(round(x)), int(round(baseline))), text, font=face.font, fill=fill, anchor="ls")
        else:
            draw.text((int(round(x)), int(round(baseline)) - 9), text, font=face.font, fill=fill)
    finally:
        draw.fontmode = old_mode


class Fonts:
    """All font roles used by the terminal UI."""

    def __init__(self, base_font_path, emoji_loader=None, font_dir=FONT_DIR):
        def path(name):
            return os.path.join(font_dir, name)

        mono = path("JetBrainsMono-Medium.ttf")
        mono_bold = path("JetBrainsMono-SemiBold.ttf")
        pixel = path("Silkscreen-Regular.ttf")

        def face(file_path, size, is_pixel=False):
            font = _truetype(file_path, size)
            return Face(font, file_path, is_pixel) if font is not None else None

        def base(size):
            font = _truetype(base_font_path, size)
            if font is not None:
                return Face(font, base_font_path, check_coverage=False)
            return Face(_default_font(size), None, check_coverage=False)

        self.body = FontStack([face(mono, 15), base(14)], emoji_loader, 15)
        self.prompt = FontStack([face(mono_bold, 15), base(15)])
        self.meta = FontStack([face(mono, 10), base(10)])
        self.meta_bold = FontStack([face(mono_bold, 10), base(10)])
        self.pixel8 = FontStack([face(pixel, 8, True), face(mono_bold, 8), base(8)])
        self.pixel16 = FontStack([face(pixel, 16, True), face(mono_bold, 14), base(14)])
        self.emoji_loader = emoji_loader
        self.loaded = {
            "mono": self.body.primary.path == mono,
            "pixel": self.pixel8.primary.path == pixel,
            "cjk": bool(base_font_path) and self.body.faces[-1].path == base_font_path,
        }
