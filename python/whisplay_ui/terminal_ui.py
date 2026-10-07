"""Coordinator for the terminal UI.

TerminalUI.render(snapshot) is called by chatbot-ui.py's RenderThread with the
current display globals. It derives the visual state from the status string,
advances time-based animations, redraws only the regions whose content
changed, pushes those rectangles to the LCD and returns how long the render
thread may sleep before the next frame is needed (None = until new data).
"""
import re
import time

import numpy as np
from PIL import Image

from . import clock, theme
from . import visual_state as vs
from .body import TONE_ECHO, TONE_MUTED, TONE_TEXT, Body
from .draw_util import STATE_COLORS, ease_in_out
from .fonts import Fonts
from .panes import (
    STRIP_H,
    STRIP_RECEIVING,
    STRIP_RESPONSE,
    STRIP_SPEAKING,
    TERMINAL_H,
    render_approval,
    render_strip,
    render_terminal,
)
from .rgb565 import to_rgb565
from .stage import (
    ERROR_GLITCH,
    IDLE_RAIN_SECONDS,
    StageInfo,
    caption_parts,
    next_blink_edge,
    rain_active,
    render_caption,
    render_visual,
    visual_fps,
)
from .statusbar import StatusBar
from .typewriter import ECHO, INSTANT, STREAM

KIND_STAGE = "stage"
KIND_STRIP = "strip"
KIND_TERMINAL = "terminal"
PANE_HEIGHTS = {KIND_STAGE: theme.STAGE_H, KIND_STRIP: STRIP_H, KIND_TERMINAL: TERMINAL_H}
CLASSIC_MAX_SCROLL_SPEED = 0.5  # chatbot-ui.py MAX_SCROLL_SPEED (px per frame)
IM_TOOL_RE = re.compile(r"^\s*\[([^\]\n]{1,40})\]")

STATE_LABELS = {
    vs.BOOT: "BOOT",
    vs.IDLE: "IDLE",
    vs.CALIBRATE: "CALIBRATE",
    vs.LISTEN: "LISTEN",
    vs.TRANSCRIBE: "STT",
    vs.THINK: "THINK",
    vs.TOOL: "TOOL",
    vs.ANSWER: "REPLY",
    vs.ERROR: "ERROR",
    vs.APPROVAL: "CONFIRM",
    vs.MUSIC: "MUSIC",
    vs.CAMERA: "CAMERA",
}


def _snap(snapshot, key, default=None):
    value = snapshot.get(key, default)
    return default if value is None else value


class TerminalUI:
    def __init__(
        self,
        hardware,
        base_font_path,
        prepare_text,
        emoji_loader=None,
        status_icon_factories=None,
        icon_context=None,
        flags=None,
    ):
        width = int(getattr(hardware, "LCD_WIDTH", 0))
        height = int(getattr(hardware, "LCD_HEIGHT", 0))
        if (width, height) != (theme.WIDTH, theme.HEIGHT):
            raise RuntimeError(f"terminal UI needs a {theme.WIDTH}x{theme.HEIGHT} LCD, got {width}x{height}")
        self.hw = hardware
        self.flags = flags if flags is not None else theme.Flags()
        self.fonts = Fonts(base_font_path, emoji_loader)
        self.emoji_loader = emoji_loader
        self.prepare_text = prepare_text
        self.statusbar = StatusBar(self.fonts, status_icon_factories, icon_context)
        self.info = StageInfo(self.fonts, self.flags)
        self.body = Body(self.fonts, self.flags)
        self.tracker = vs.StateTracker()
        self.frame = Image.new("RGB", (theme.WIDTH, theme.HEIGHT), theme.VOID)
        self.on_lcd = None  # RGB888 copy of what the LCD currently shows
        self.full = True
        self.last_now = None
        self.last_keyframe = -1e9
        self._list_pixels = False
        # text / speech
        self.text = None
        self.text_offset = 0
        self.transaction = None
        self.speech_seq = None
        self.text_changed = False
        # region caches
        self.status_key = None
        self.pane_kind = None
        self.pane_h = 0
        self.visual_key = None
        self.visual_img = None
        self.caption_key = None
        self.caption_img = None
        self.side_key = None
        self._caption_changed = False
        self.pane_img = None
        self.geometry = None
        self.approval_drawn = False
        self._animating = False
        # transitions
        self.xfade_from = None
        self.xfade_at = -1e9
        self.morph_from = 0
        self.morph_at = -1e9
        # emoji
        self.emoji_cache = {}
        # adaptive quality
        self.quality = 0
        self.render_ema = 0.0
        self.debug_at = 0.0
        print(f"[TerminalUI] fonts loaded: {self.fonts.loaded}")

    # ----------------------------------------------------------------- api
    def invalidate(self):
        """Force a full redraw (e.g. after camera or image mode drew over us)."""
        self.full = True

    def render(self, snapshot):
        started = time.perf_counter()
        now = clock.now()
        dt = 0.0 if self.last_now is None else max(0.0, min(theme.MAX_FRAME_DT, now - self.last_now))
        self.last_now = now

        status = _snap(snapshot, "status", "")
        state_changed = self.tracker.update(status, now)
        state = self.tracker.state
        t = now - self.tracker.entered_at

        self.text_changed = False
        self._ingest_text(snapshot, state, now)
        self._ingest_speech(snapshot, now)
        self._update_info(snapshot, status)
        try:
            speed = float(_snap(snapshot, "scroll_speed", 0.25))
        except (TypeError, ValueError):
            speed = 0.25
        self.body.scroll_factor = max(0.0, speed) / CLASSIC_MAX_SCROLL_SPEED
        self.body.quality = self.quality
        self.info.quality = self.quality

        # ---- geometry and transitions
        kind = KIND_TERMINAL if _snap(snapshot, "terminal_text", "") else (
            KIND_STRIP if state in vs.CONSOLE_STATES else KIND_STAGE
        )
        target_h = PANE_HEIGHTS[kind]
        if kind != self.pane_kind:
            if self.pane_kind is not None and not self.full:
                self.morph_from = self.pane_h
                self.morph_at = now
            self.pane_kind = kind
            self.visual_key = self.caption_key = self.side_key = None
            self.xfade_from = None
        elif state_changed and kind == KIND_STAGE and self.pane_img is not None and not self.full:
            self.xfade_from = self.pane_img.copy()
            self.xfade_at = now
        morph_p = (now - self.morph_at) / theme.MORPH
        morphing = 0.0 <= morph_p < 1.0
        if morphing:
            self.pane_h = int(round(self.morph_from + (target_h - self.morph_from) * ease_in_out(morph_p)))
        else:
            self.pane_h = target_h
        xfade_p = (now - self.xfade_at) / theme.CROSSFADE
        xfading = self.xfade_from is not None and 0.0 <= xfade_p < 1.0
        if self.xfade_from is not None and not xfading:
            self.xfade_from = None
            self.visual_key = self.caption_key = None

        approval = bool(_snap(snapshot, "approval_mode", False))
        body_top = theme.PANE_Y + self.pane_h
        body_bottom = theme.HEIGHT - (theme.APPROVAL_H if approval else 0)
        body_h = max(0, body_bottom - body_top)
        self.body.update(now, dt, body_h)

        if not self.full and self._keyframe_due(now):
            self.full = True
        full = self.full
        if full:
            self.frame.paste(theme.VOID, (0, 0, theme.WIDTH, theme.HEIGHT))
            self.status_key = self.visual_key = self.caption_key = self.side_key = None
            self.geometry = None
            self.approval_drawn = False
            self.last_keyframe = now
        dirty = []

        # ---- status bar
        model = self._status_model(snapshot, state)
        key = self.statusbar.key(model)
        if key != self.status_key:
            self.status_key = key
            self.frame.paste(self.statusbar.render(model), (0, 0))
            dirty.append((0, 0, theme.WIDTH, theme.STATUS_H))

        # ---- pane
        geometry = (self.pane_h, body_top, body_bottom)
        geometry_changed = geometry != self.geometry
        self.geometry = geometry
        dirty.extend(self._render_pane(kind, state, t, now, snapshot, morphing or geometry_changed, xfading, xfade_p))

        # ---- body
        if self.body.changed(now, body_h) or geometry_changed:
            if body_h > 0:
                self.frame.paste(self.body.render(now, body_h), (0, body_top))
                dirty.append((0, body_top, theme.WIDTH, body_bottom))

        # ---- approval bar
        if approval and (not self.approval_drawn or geometry_changed):
            self.frame.paste(render_approval(self.fonts), (0, theme.HEIGHT - theme.APPROVAL_H))
            dirty.append((0, theme.HEIGHT - theme.APPROVAL_H, theme.WIDTH, theme.HEIGHT))
        self.approval_drawn = approval

        self.full = False
        self._push(dirty, full)

        elapsed_ms = (time.perf_counter() - started) * 1000.0
        if dirty and not (full or geometry_changed or self.text_changed):
            # Only steady animation frames count; full redraws and relayouts
            # are one-off costs and must not degrade the effects.
            self._adapt_quality(elapsed_ms)
        if self.flags.debug and now - self.debug_at > 5.0:
            self.debug_at = now
            print(f"[TerminalUI] state={state} kind={kind} render={elapsed_ms:.1f}ms ema={self.render_ema:.1f}ms q={self.quality}")
        return self._next_delay(state, t, now, kind, morphing, xfading)

    # ------------------------------------------------------------- inputs
    def _ingest_text(self, snapshot, state, now):
        text = _snap(snapshot, "text", "")
        text = text if isinstance(text, str) else str(text)
        transaction = snapshot.get("transaction_id")
        tx_changed = (
            transaction is not None
            and self.transaction is not None
            and transaction != self.transaction
        )
        if transaction is not None:
            self.transaction = transaction
        if text == self.text:
            return
        items, offset = self.prepare_text(text)
        old = self.text
        if old is None:
            self.body.tone = TONE_TEXT
            self.body.replace(items, offset, INSTANT, now, fade=False)
        elif not tx_changed and old and text.startswith(old):
            if offset != self.text_offset:
                self.body.slide(items, offset, now)
            else:
                self.body.extend(items, now)
        else:
            mode, tone = self._mode_for(state)
            edited = False
            if not tx_changed and old and mode == STREAM and self.body.tw.mode == STREAM:
                layout, prefix = self.body.common_prefix(items)
                shorter = min(self.body.layout.total_units, layout.total_units)
                if prefix >= max(8, shorter // 2):
                    self.body.edit(layout, items, offset, prefix, now)
                    edited = True
            if not edited:
                self.body.tone = tone
                self.body.replace(items, offset, mode, now)
        self.text = text
        self.text_offset = offset
        self.text_changed = True

    @staticmethod
    def _mode_for(state):
        if state == vs.ANSWER:
            return STREAM, TONE_TEXT
        if state in (vs.THINK, vs.TOOL):
            return STREAM, TONE_MUTED
        if state == vs.TRANSCRIBE:
            return ECHO, TONE_ECHO
        return INSTANT, TONE_TEXT

    def _ingest_speech(self, snapshot, now):
        sync = snapshot.get("speech_sync")
        if not sync:
            return
        seq, char_end, duration_ms = sync
        if seq == self.speech_seq:
            return
        self.speech_seq = seq
        self.body.speech(char_end, duration_ms, now)

    def _update_info(self, snapshot, status):
        info = self.info
        info.raw_status = status or ""
        info.music_progress = snapshot.get("music_progress")
        info.music_duration_ms = snapshot.get("music_duration_ms")
        label = ""
        for line in reversed(self.body.layout.lines):
            if line.kind == "tag" and line.tag:
                label = str(line.tag.get("label", ""))
                break
        if not label and self.text:
            match = IM_TOOL_RE.match(self.text)
            if match:
                label = match.group(1).strip()
        info.tool_label = label

    def _status_model(self, snapshot, state):
        hour, minute, _ = clock.wall_hms()
        speaking = state == vs.ANSWER and self.body.speaking(self.last_now)
        label = "SPEAK" if speaking else STATE_LABELS.get(state)
        if label is None:
            if state == vs.RESULT:
                label = (self.info.raw_status or "").strip().upper()
            else:
                label = (self.info.raw_status or "").strip().upper()[:10] or "STATUS"
        color = STATE_COLORS.get(state, theme.MUTED)
        if state == vs.RESULT and (self.info.raw_status or "").strip().lower() == "denied":
            color = theme.RED
        return {
            "label": label,
            "color": color,
            "clock": "%02d:%02d" % (hour, minute),
            "battery_level": snapshot.get("battery_level"),
            "battery_color": snapshot.get("battery_color"),
            "wifi_level": snapshot.get("wifi_signal_level") or 0,
            "network_connected": snapshot.get("network_connected"),
            "vpn": snapshot.get("vpn_connected"),
            "rag": snapshot.get("rag_icon_visible"),
            "image": snapshot.get("image_icon_visible"),
        }

    # -------------------------------------------------------------- panes
    def _render_pane(self, kind, state, t, now, snapshot, force, xfading, xfade_p):
        y0 = theme.PANE_Y
        full_h = PANE_HEIGHTS[kind]
        rects = []
        if kind == KIND_STAGE:
            changed = self._update_stage(state, t, now)
            pane = self.pane_img
            if xfading:
                pane = Image.blend(self.xfade_from, pane, ease_in_out(xfade_p))
                force = True
            if force:
                self._paste_pane(pane, full_h)
                return [(0, y0, theme.WIDTH, y0 + self.pane_h)]
            if changed:
                self._paste_pane(pane, full_h)
                rects.append((0, y0, theme.WIDTH, y0 + theme.STAGE_VISUAL_H))
            if self._caption_changed:
                self._paste_pane(pane, full_h)
                rects.append((0, y0 + theme.STAGE_VISUAL_H, theme.WIDTH, y0 + theme.STAGE_H))
            return rects

        if kind == KIND_STRIP:
            mode = self._strip_mode(now)
            emoji = self._emoji_image(_snap(snapshot, "emoji", ""))
            progress = snapshot.get("music_progress")
            animated = mode in (STRIP_SPEAKING, STRIP_RECEIVING)
            bucket = int(t * (theme.SPEAKING_FPS if mode == STRIP_SPEAKING else 6)) if animated else -1
            key = (mode, bucket, id(emoji) if emoji is not None else None, progress)
            if key != self.side_key or force:
                self.side_key = key
                self.pane_img = render_strip(self.fonts, mode, t, emoji, progress)
                self._paste_pane(self.pane_img, full_h)
                rects.append((0, y0, theme.WIDTH, y0 + self.pane_h))
            return rects

        text = _snap(snapshot, "terminal_text", "")
        key = (text,)
        if key != self.side_key or force:
            self.side_key = key
            self.pane_img = render_terminal(self.fonts, text)
            self._paste_pane(self.pane_img, full_h)
            rects.append((0, y0, theme.WIDTH, y0 + self.pane_h))
        return rects

    def _paste_pane(self, pane, full_h):
        h = self.pane_h
        y0 = theme.PANE_Y
        if h >= full_h:
            self.frame.paste(pane, (0, y0))
            if h > full_h:
                self.frame.paste(theme.VOID, (0, y0 + full_h, theme.WIDTH, y0 + h))
        elif h > 0:
            self.frame.paste(pane.crop((0, 0, theme.WIDTH, h)), (0, y0))

    def _update_stage(self, state, t, now):
        """Re-render the stage visual/caption if needed. Returns True when the
        visual changed and sets self._caption_changed."""
        info = self.info
        fps = visual_fps(state, t, info)
        if fps > 0:
            fps = min(fps, self._fps_cap())
        bucket = int(t * fps) if fps > 0 else -1
        cursor = None
        if state == vs.IDLE:
            cursor = (t % theme.BLINK_PERIOD) < theme.BLINK_ON
        static_key = (state, info.quality, info.raw_status if state in (vs.GENERIC, vs.RESULT) else "", info.tool_label if state == vs.TOOL else "")
        key = (static_key, bucket, cursor)
        changed = False
        if self.visual_key is None or key != self.visual_key:
            self.visual_img, _ = render_visual(state, t, info)
            self.visual_key = key
            changed = True
        parts = caption_parts(state, t, info)
        pulse = int(t * 10) if state == vs.LISTEN else -1
        caption_key = (state, parts, pulse)
        self._caption_changed = caption_key != self.caption_key
        if self._caption_changed:
            self.caption_key = caption_key
            self.caption_img = render_caption(parts, t, info, state)
        if changed or self._caption_changed or self.pane_img is None or self.pane_img.height != theme.STAGE_H:
            pane = Image.new("RGB", (theme.WIDTH, theme.STAGE_H), theme.VOID)
            pane.paste(self.visual_img, (0, 0))
            pane.paste(self.caption_img, (0, theme.STAGE_VISUAL_H))
            self.pane_img = pane
        return changed

    def _strip_mode(self, now):
        if self.body.speaking(now):
            return STRIP_SPEAKING
        if self.body.tw.busy() or (self.body.tw.mode == STREAM and now - self.body.tw.last_growth < theme.WRITING_WINDOW):
            return STRIP_RECEIVING
        return STRIP_RESPONSE

    def _emoji_image(self, emoji):
        if self.flags.emoji == "off" or not emoji or self.emoji_loader is None:
            return None
        if emoji in self.emoji_cache:
            return self.emoji_cache[emoji]
        image = None
        candidates = [emoji, emoji.replace("️", ""), emoji[0]]
        for candidate in candidates:
            if not candidate:
                continue
            try:
                image = self.emoji_loader(candidate, 16)
            except Exception:
                image = None
            if image is not None:
                image = image.convert("RGBA")
                if image.height > 18:
                    image = image.resize((18, 18), Image.LANCZOS)
                break
        self.emoji_cache[emoji] = image
        return image

    # ------------------------------------------------------------ output
    def _push(self, rects, full=False):
        """Send changed pixels to the LCD. Each candidate rect is shrunk to
        the bounding box of pixels that differ from what the LCD shows."""
        frame = np.asarray(self.frame)
        if full or self.on_lcd is None:
            rects = [(0, 0, theme.WIDTH, theme.HEIGHT)]
            self.on_lcd = None
        for x0, y0, x1, y1 in _merge(rects):
            x0, y0 = max(0, int(x0)), max(0, int(y0))
            x1, y1 = min(theme.WIDTH, int(x1)), min(theme.HEIGHT, int(y1))
            if x1 <= x0 or y1 <= y0:
                continue
            if self.on_lcd is not None:
                diff = np.any(frame[y0:y1, x0:x1] != self.on_lcd[y0:y1, x0:x1], axis=2)
                rows = np.flatnonzero(diff.any(axis=1))
                if rows.size == 0:
                    continue
                cols = np.flatnonzero(diff.any(axis=0))
                x0, x1 = x0 + int(cols[0]), x0 + int(cols[-1]) + 1
                y0, y1 = y0 + int(rows[0]), y0 + int(rows[-1]) + 1
            self._send(frame, x0, y0, x1, y1)
        self.on_lcd = frame.copy()

    def _send(self, frame, x0, y0, x1, y1):
        data = to_rgb565(frame[y0:y1, x0:x1])
        if self._list_pixels:
            data = list(data)
        try:
            self.hw.draw_image(x0, y0, x1 - x0, y1 - y0, data)
        except TypeError:
            # Hardware adapters that only accept a list of ints.
            self._list_pixels = True
            self.hw.draw_image(x0, y0, x1 - x0, y1 - y0, list(data))

    def _keyframe_due(self, now):
        return now - self.last_keyframe > theme.KEYFRAME_INTERVAL and self._animating

    def _fps_cap(self):
        cap = self.flags.fps_cap
        if self.quality >= 2:
            cap = max(5, cap // 2)
        return cap

    def _adapt_quality(self, ms):
        self.render_ema = ms if self.render_ema == 0 else self.render_ema * 0.9 + ms * 0.1
        if self.render_ema > theme.DEGRADE_2_MS:
            self.quality = 2
        elif self.render_ema > theme.DEGRADE_1_MS and self.quality < 1:
            self.quality = 1
        elif self.render_ema < theme.RECOVER_MS and self.quality > 0:
            self.quality -= 1
            self.render_ema = (theme.RECOVER_MS + theme.DEGRADE_1_MS) / 2.0

    def _next_delay(self, state, t, now, kind, morphing, xfading):
        fps = 0
        if morphing or xfading:
            fps = 30
        if kind == KIND_STAGE:
            fps = max(fps, visual_fps(state, t, self.info))
            if state == vs.LISTEN:
                fps = max(fps, 10)
        elif kind == KIND_STRIP:
            mode = self._strip_mode(now)
            if mode == STRIP_SPEAKING:
                fps = max(fps, theme.SPEAKING_FPS)
            elif mode == STRIP_RECEIVING:
                fps = max(fps, 6)
        fps = max(fps, self.body.fps_needed(now))
        self._animating = fps > 0
        if fps > 0:
            return 1.0 / min(fps, self._fps_cap())
        waits = [clock.seconds_to_next_minute() + 0.05]
        if kind == KIND_STAGE and state == vs.IDLE:
            waits.append(next_blink_edge(t))
            if rain_active(state, t, self.info):
                waits.append(IDLE_RAIN_SECONDS - t)
        if kind == KIND_STAGE and state == vs.ERROR and t < ERROR_GLITCH:
            waits.append(ERROR_GLITCH - t)
        if self.tracker.latch_until > now:
            waits.append(self.tracker.latch_until - now)
        body_wait = self.body.next_event(now)
        if body_wait is not None:
            waits.append(body_wait)
        if self.body.speech_until > now:
            waits.append(self.body.speech_until - now)
        waits = [w for w in waits if w > 0]
        # Land just past the edge so the frame sees the new state.
        return max(0.005, min(waits) + 0.002) if waits else None


def _merge(rects):
    """Merge full-width bands that touch; drop small rects inside a band."""
    bands = sorted((r for r in rects if r[0] == 0 and r[2] >= theme.WIDTH), key=lambda r: r[1])
    merged = []
    for rect in bands:
        if merged and rect[1] <= merged[-1][3]:
            last = merged[-1]
            merged[-1] = (0, last[1], theme.WIDTH, max(last[3], rect[3]))
        else:
            merged.append(tuple(rect))
    out = list(merged)
    for rect in rects:
        if rect[0] == 0 and rect[2] >= theme.WIDTH:
            continue
        if any(b[1] <= rect[1] and rect[3] <= b[3] for b in merged):
            continue
        out.append(tuple(rect))
    return out
