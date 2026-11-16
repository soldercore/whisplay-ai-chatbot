"""Coordinator of the landscape layout: TerminalUI's text, speech and state handling, drawn on a 280 x 240 canvas.

WHISPLAY_UI_LAYOUT=landscape selects it (create_terminal_ui). The canvas is turned 90 degrees onto the 240 x 280 panel in
_send, the only place that talks to the hardware, so the pixel-difference pushes keep working in landscape coordinates.
"""
import numpy as np
from PIL import Image

from . import clock, land, theme
from . import visual_state as vs
from .body import Body
from .draw_util import ease_in_out
from .rgb565 import to_rgb565
from .stage import StageInfo, caption_parts
from .terminal_ui import TerminalUI, _merge

KIND_HOME = "home"
KIND_LIVE = "live"
KIND_COMPACT = "compact"
KIND_STRIP = "strip"
KIND_TERMINAL = "terminal"
KIND_BOOT = "boot"
PANE_Y = land.HEADER_H
PANE_HEIGHTS = {KIND_BOOT: 200, KIND_HOME: 200, KIND_LIVE: 200, KIND_COMPACT: 76, KIND_STRIP: land.STRIP_H, KIND_TERMINAL: land.TERMINAL_H}
BODY_BOTTOM = 224
LIVE_STATES = (vs.LISTEN, vs.TRANSCRIBE, vs.THINK, vs.CALIBRATE)
LIVE_MODES = {vs.LISTEN: "listen", vs.TRANSCRIBE: "decode", vs.THINK: "think", vs.CALIBRATE: "calibrate"}
COMPACT_MODES = {vs.TOOL: "tool", vs.ERROR: "error", vs.MUSIC: "music"}
# absolute y of the elements
Y_PIPE_LIVE, Y_TRACE_LIVE, Y_TEXT_LIVE = 30, 52, 130
Y_PIPE_COMPACT, Y_TRACE_COMPACT, Y_CAPTION_COMPACT = 28, 48, 78
Y_TRACE_HOME, Y_PIPE_HOME = 104, 190
MINI_X, MINI_W, MINI_H = 118, 54, 16
FADE = 0.16


class LandscapeUI(TerminalUI):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        land.extra_fonts(self.fonts)
        self.pipe = land.Pipeline(self.fonts)
        self.trace_live = land.Trace(land.TRACE_W, 68)
        self.trace_compact = land.Trace(land.TRACE_W, 28)
        self.trace_home = land.Trace(land.TRACE_W, 24)
        self.trace_mini = land.Trace(MINI_W, MINI_H)
        self.keys = {}
        self.trace_keys = {}
        self.fade_from = None
        self.fade_at = -1e9
        self.fade_through = False
        self.cur_kind = None
        self.cur_state = None
        self.settled = True
        self.mini_at = None
        self.last_state_for_fade = None

    # ---------------------------------------------------------------- output
    def _send(self, frame, x0, y0, x1, y1):
        """Logical rectangle (landscape) to the panel: the canvas is rotated 90 degrees (WHISPLAY_UI_ROTATE=cw|ccw)."""
        block = frame[y0:y1, x0:x1]
        if theme.ROTATE == "ccw":
            block = np.rot90(block, 1)
            px0, py0, px1, py1 = y0, theme.PHYS_HEIGHT - x1, y1, theme.PHYS_HEIGHT - x0
        else:
            block = np.rot90(block, -1)
            px0, py0, px1, py1 = theme.PHYS_WIDTH - y1, x0, theme.PHYS_WIDTH - y0, x1
        data = to_rgb565(np.ascontiguousarray(block))
        if self._list_pixels:
            data = list(data)
        try:
            self.hw.draw_image(px0, py0, px1 - px0, py1 - py0, data)
        except TypeError:
            self._list_pixels = True
            self.hw.draw_image(px0, py0, px1 - px0, py1 - py0, list(data))

    # ---------------------------------------------------------------- frame
    def render(self, snapshot):
        started = __import__("time").perf_counter()
        now = clock.now()
        dt = 0.0 if self.last_now is None else max(0.0, min(theme.MAX_FRAME_DT, now - self.last_now))
        self.last_now = now
        status = snapshot.get("status") or ""
        state_changed = self.tracker.update(status, now)
        state = self.tracker.state
        t = now - self.tracker.entered_at
        self.text_changed = False
        self._ingest_text(snapshot, state, now)
        self._ingest_speech(snapshot, now)
        self._update_info(snapshot, status)
        try:
            speed = float(snapshot.get("scroll_speed") or 0.25)
        except (TypeError, ValueError):
            speed = 0.25
        self.body.scroll_factor = max(0.0, speed) / 0.5
        self.body.quality = self.quality
        tokens = self.info.tokens

        retained = state == vs.IDLE and self.response_text is not None
        terminal = bool(snapshot.get("terminal_text"))
        if terminal:
            kind = KIND_TERMINAL
        elif state == vs.BOOT:
            kind = KIND_BOOT
        elif retained or state == vs.ANSWER:
            kind = KIND_STRIP
        elif state == vs.IDLE:
            kind = KIND_HOME
        elif state in LIVE_STATES:
            kind = KIND_LIVE
        else:
            kind = KIND_COMPACT
        strip_mode = self._strip_mode(now) if kind == KIND_STRIP else None
        pane_h = PANE_HEIGHTS[kind]
        approval = bool(snapshot.get("approval_mode"))
        body_top = PANE_Y + pane_h
        body_bottom = theme.HEIGHT - land.APPROVAL_H if approval else BODY_BOTTOM
        heard_h = land.heard_height(self.fonts, self.said_text) if (kind == KIND_STRIP and self.said_text and not approval) else 0
        body_bottom -= heard_h
        body_h = max(0, body_bottom - body_top)
        self.body.update(now, dt, body_h)

        # a change of screen or state cross-fades the pane for a moment
        changed = (kind != self.cur_kind) or (state != self.cur_state and kind in (KIND_LIVE, KIND_COMPACT, KIND_HOME))
        if changed and self.cur_kind is not None and not self.full:
            self.fade_from = self.frame.crop((0, PANE_Y, theme.WIDTH, BODY_BOTTOM)).copy()
            self.fade_through = kind != self.cur_kind       # a different layout dips through black; the same layout cross-fades
            self.fade_at = now
        self.cur_kind, self.cur_state = kind, state
        fade_p = (now - self.fade_at) / FADE
        fading = self.fade_from is not None and 0.0 <= fade_p < 1.0
        force = changed or fading or (self.fade_from is not None and not fading)
        if self.fade_from is not None and not fading:
            pending_clear = True
        else:
            pending_clear = False

        if not self.full and self._keyframe_due(now):
            self.full = True
        full = self.full
        if full:
            self.frame.paste(theme.VOID, (0, 0, theme.WIDTH, theme.HEIGHT))
            self.keys = {}
            self.trace_keys = {}
            self.last_keyframe = now
        dirty = []

        model = self._status_model(snapshot, state)
        hkey = (model["color"], model["clock"] if kind != KIND_HOME else None, model["battery_level"], model.get("wireless_status"),
                model["wifi_level"], model["network_connected"], kind == KIND_HOME)
        if self.keys.get("header") != hkey:
            self.keys["header"] = hkey
            self.frame.paste(land.render_header(self.fonts, model, kind != KIND_HOME), (0, 0))
            dirty.append((0, 0, theme.WIDTH, land.HEADER_H))

        pane_dirty = self._pane(kind, state, t, now, snapshot, tokens, strip_mode, force or full)
        dirty.extend(pane_dirty)
        if fading:
            new = self.frame.crop((0, PANE_Y, theme.WIDTH, BODY_BOTTOM))
            if self.fade_through:
                black = Image.new("RGB", new.size, theme.VOID)
                blended = Image.blend(self.fade_from, black, min(1.0, 2.0 * fade_p)) if fade_p < 0.5 else Image.blend(black, new, 2.0 * fade_p - 1.0)
            else:
                blended = Image.blend(self.fade_from, new, ease_in_out(fade_p))
            self.frame.paste(blended, (0, PANE_Y))
            dirty.append((0, PANE_Y, theme.WIDTH, BODY_BOTTOM))
        elif pending_clear:
            self.fade_from = None
            dirty.append((0, PANE_Y, theme.WIDTH, BODY_BOTTOM))

        # body text
        if body_h > 0 and (self.body.changed(now, body_h) or force or full or self.keys.get("body_geo") != (body_top, body_bottom)):
            self.keys["body_geo"] = (body_top, body_bottom)
            body_image = self.body.render(now, body_h)
            top_cut = self.body.scroll > 1.0
            bottom_cut = self.body.scroll < self.body.max_scroll() - 1.0
            if top_cut or bottom_cut:
                body_image = land.fade_body(body_image, top_cut, bottom_cut)
            self.frame.paste(body_image, (0, body_top))
            dirty.append((0, body_top, theme.WIDTH, body_bottom))
        elif body_h <= 0:
            self.keys.pop("body_geo", None)
        if approval:
            if self.keys.get("approval") is None or force or full:
                self.keys["approval"] = True
                self.frame.paste(land.render_approval(self.fonts), (0, theme.HEIGHT - land.APPROVAL_H))
                dirty.append((0, theme.HEIGHT - land.APPROVAL_H, theme.WIDTH, theme.HEIGHT))
        elif self.keys.pop("approval", None) is not None:
            self.frame.paste(theme.VOID, (0, body_bottom, theme.WIDTH, theme.HEIGHT))
            dirty.append((0, body_bottom, theme.WIDTH, theme.HEIGHT))
        hkey2 = (self.said_text, heard_h)
        if heard_h and (self.keys.get("heard") != hkey2 or force or full):
            self.keys["heard"] = hkey2
            self.frame.paste(land.render_heard(self.fonts, self.said_text), (0, body_bottom))
            dirty.append((0, body_bottom, theme.WIDTH, body_bottom + heard_h))
        elif not heard_h and self.keys.pop("heard", None) is not None:
            self.frame.paste(theme.VOID, (0, body_bottom, theme.WIDTH, BODY_BOTTOM + 8))
            dirty.append((0, body_bottom, theme.WIDTH, BODY_BOTTOM + 8))

        self.full = False
        self._push(dirty, full)
        elapsed_ms = (__import__("time").perf_counter() - started) * 1000.0
        if dirty and not (full or changed or self.text_changed):
            self._adapt_quality(elapsed_ms)
        return self._delay(kind, state, strip_mode, fading, now)

    # ---------------------------------------------------------------- panes
    def _pane(self, kind, state, t, now, snapshot, tokens, strip_mode, force):
        rects = []
        fonts = self.fonts
        if force:
            self.frame.paste(theme.VOID, (0, PANE_Y, theme.WIDTH, PANE_Y + PANE_HEIGHTS[kind]))
            for name in ("pane", "pipe", "trace"):
                self.keys.pop(name, None)
            rects.append((0, PANE_Y, theme.WIDTH, PANE_Y + PANE_HEIGHTS[kind]))
        model = self._status_model(snapshot, state)
        info = self.info
        if kind == KIND_BOOT:
            self.frame.paste(land.render_boot(fonts, t), (0, PANE_Y))
            rects.append((0, PANE_Y, theme.WIDTH, BODY_BOTTOM))
        elif kind == KIND_HOME:
            key = (model["clock"], tuple(sorted(tokens.items())))
            if self.keys.get("pane") != key:
                self.keys["pane"] = key
                self.frame.paste(land.render_home(fonts, model, tokens), (0, PANE_Y))
                rects.append((0, PANE_Y, theme.WIDTH, PANE_Y + PANE_HEIGHTS[kind]))
                self.keys.pop("trace", None)
                self.keys.pop("pipe", None)
            self._trace(self.trace_home, "rest", t, now, (land.LEFT, Y_TRACE_HOME), rects, cursor=True)
            self._pipe(None, now, Y_PIPE_HOME, rects)
        elif kind == KIND_LIVE:
            transcript = info.transcript if state in (vs.TRANSCRIBE, vs.THINK) else ""
            key = (state, tuple(sorted(tokens.items())), transcript, int(t) if (state == vs.LISTEN and not tokens) else None)
            if self.keys.get("pane") != key:
                self.keys["pane"] = key
                text = land.render_live_text(fonts, state, t, tokens, transcript, 200 - (Y_TEXT_LIVE - PANE_Y))
                self.frame.paste(text, (0, Y_TEXT_LIVE))
                rects.append((0, Y_TEXT_LIVE, theme.WIDTH, BODY_BOTTOM))
            level = 0.88 if "audio" in tokens else 0.36 if ("auto" in tokens or "answer" in tokens) else 0.3
            self._trace(self.trace_live, LIVE_MODES.get(state, "rest"), t, now, (land.LEFT, Y_TRACE_LIVE), rects, level=level)
            self._pipe(land.STAGE_OF.get(state), now, Y_PIPE_LIVE, rects)
        elif kind == KIND_COMPACT:
            parts = caption_parts(state, t, info)
            ckey = (state, parts[0], parts[2], parts[4] if parts[4] is None else round(parts[4], 2), int(t * 10) if state == vs.TOOL else None)
            if self.keys.get("pane") != ckey:
                self.keys["pane"] = ckey
                label, color, right, right_color, progress = parts
                self.frame.paste(land.render_compact_caption(fonts, label, color, right, right_color, progress), (0, Y_CAPTION_COMPACT))
                rects.append((0, Y_CAPTION_COMPACT, theme.WIDTH, Y_CAPTION_COMPACT + 22))
            self._trace(self.trace_compact, COMPACT_MODES.get(state, "rest"), t, now, (land.LEFT, Y_TRACE_COMPACT), rects)
            self._pipe(land.STAGE_OF.get(state), now, Y_PIPE_COMPACT, rects)
        elif kind == KIND_STRIP:
            key = (strip_mode, tuple(sorted(tokens.items())))
            if self.keys.get("pane") != key:
                self.keys["pane"] = key
                image, end, hint_x = land.render_strip(fonts, strip_mode, tokens)
                self.frame.paste(image, (0, PANE_Y))
                rects.append((0, PANE_Y, theme.WIDTH, PANE_Y + land.STRIP_H))
                self.keys.pop("trace", None)
                self.mini_at = end + 14 if hint_x - 8 - (end + 14) >= MINI_W else None      # no room next to a long hint: no mini trace
            if self.mini_at is not None:
                mode = "speak" if strip_mode == land.STRIP_SPEAKING else "think" if strip_mode == land.STRIP_RECEIVING else "rest"
                self._trace(self.trace_mini, mode, t, now, (self.mini_at, PANE_Y + 3), rects, pulse=self._word_pulse(now), ticks=False)
        else:
            key = snapshot.get("terminal_text") or ""
            if self.keys.get("pane") != key:
                self.keys["pane"] = key
                self.frame.paste(land.render_terminal(fonts, key), (0, PANE_Y))
                rects.append((0, PANE_Y, theme.WIDTH, PANE_Y + land.TERMINAL_H))
        return rects

    def _trace(self, trace, mode, t, now, at, rects, level=0.5, pulse=0.0, cursor=False, ticks=True):
        trace.step(mode, t, now, level, pulse)
        key = (id(trace), trace.key(), cursor)
        if self.keys.get("trace") != key:
            self.keys["trace"] = key
            self.frame.paste(trace.render(cursor=cursor, ticks=ticks), at)
            rects.append((at[0], at[1], at[0] + trace.w, at[1] + trace.h))
        self._active_trace = trace

    def _pipe(self, stage, now, y, rects):
        self.pipe.step(stage, now)
        key = (self.pipe.key(), y)
        if self.keys.get("pipe") != key:
            self.keys["pipe"] = key
            self.frame.paste(self.pipe.render(), (0, y))
            rects.append((0, y, theme.WIDTH, y + 16))

    # ---------------------------------------------------------------- timing
    def _delay(self, kind, state, strip_mode, fading, now):
        fps = 0
        trace = getattr(self, "_active_trace", None)
        moving = trace is not None and trace.delta > 0.3
        live = (kind == KIND_LIVE) or (kind == KIND_COMPACT and state in COMPACT_MODES and state != vs.ERROR) \
            or (kind == KIND_STRIP and strip_mode in (land.STRIP_SPEAKING, land.STRIP_RECEIVING))
        if live or moving or kind == KIND_BOOT:
            fps = theme.OPTIC_FPS
        if fading or self.pipe.moving():
            fps = max(fps, 30)
        if kind in (KIND_COMPACT, KIND_STRIP, KIND_TERMINAL):
            fps = max(fps, self.body.fps_needed(now))
        self._animating = fps > 0
        if fps > 0:
            return 1.0 / min(fps, self._fps_cap())
        waits = []
        if kind == KIND_HOME or kind == KIND_STRIP:
            waits.append(clock.seconds_to_next_minute() + 0.05)
        if self.tracker.latch_until > now:
            waits.append(self.tracker.latch_until - now)
        body_wait = self.body.next_event(now)
        if body_wait is not None:
            waits.append(body_wait)
        if self.body.speech_until > now:
            waits.append(self.body.speech_until - now)
        waits = [w for w in waits if w > 0]
        return max(0.005, min(waits) + 0.002) if waits else None
