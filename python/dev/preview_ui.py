#!/usr/bin/env python3
"""Deterministic preview + self-test for the Whisplay terminal UI.

This loads the real python/chatbot-ui.py (RenderThread, update_display_data,
fallback logic, camera/image branches) and swaps only the LCD for an
in-memory framebuffer. The clock is manual, so every frame is reproducible.
The render loop's scheduler is simulated: the next frame happens after the
delay the renderer asked for, exactly like RenderThread.run().

Usage (from the repo root or python/):
    python3 python/dev/preview_ui.py                 # screenshots + contact sheet
    python3 python/dev/preview_ui.py --out /tmp/ui   # choose output folder
    python3 python/dev/preview_ui.py --selftest      # run integration checks
"""
import argparse
import functools
import importlib
import importlib.util
import os
import shutil
import sys
import tempfile
import types

HERE = os.path.dirname(os.path.abspath(__file__))
PY_DIR = os.path.dirname(HERE)
os.chdir(PY_DIR)  # chatbot-ui.py resolves img/, emoji_svg/ and fonts from here
if PY_DIR not in sys.path:
    sys.path.insert(0, PY_DIR)

import numpy as np  # noqa: E402
from PIL import Image, ImageDraw, ImageFont  # noqa: E402

from whisplay_ui import clock  # noqa: E402
from whisplay_ui import theme  # noqa: E402

W, H = 240, 280
FALLBACK_BASE_FONTS = [
    "NotoSansSC-Bold.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
    "/usr/share/fonts/truetype/noto/NotoSans-Bold.ttf",
]


# --------------------------------------------------------------- fake LCD
class FakeLCD:
    """Stands in for WhisplayBoard / WhisplayDaemonProxy."""

    LCD_WIDTH = W
    LCD_HEIGHT = H
    CornerHeight = 20

    def __init__(self):
        self.fb = np.zeros((H, W, 3), dtype=np.uint8)
        self.pushes = []

    def draw_image(self, x, y, width, height, pixel_data):
        if x + width > W or y + height > H or x < 0 or y < 0:
            raise ValueError("Image dimensions exceed screen bounds")
        data = np.frombuffer(bytes(pixel_data), dtype=">u2").reshape(height, width)
        r = ((data >> 11) & 0x1F).astype(np.uint16)
        g = ((data >> 5) & 0x3F).astype(np.uint16)
        b = (data & 0x1F).astype(np.uint16)
        rgb = np.dstack(((r << 3) | (r >> 2), (g << 2) | (g >> 4), (b << 3) | (b >> 2))).astype(np.uint8)
        self.fb[y:y + height, x:x + width] = rgb
        self.pushes.append((x, y, width, height))

    def image(self):
        return Image.fromarray(self.fb.copy(), "RGB")

    # hardware calls the UI process may make; all no-ops here
    def set_backlight(self, *_):
        pass

    def set_rgb(self, *_):
        pass

    def set_rgb_fade(self, *_, **__):
        pass

    def on_button_press(self, *_):
        pass

    def on_button_release(self, *_):
        pass

    def cleanup(self):
        pass


def base_font():
    custom = os.environ.get("CUSTOM_FONT_PATH")
    for path in ([custom] if custom else []) + FALLBACK_BASE_FONTS:
        if path and os.path.exists(path):
            return path
    raise SystemExit("No base font found; set CUSTOM_FONT_PATH")


def load_chatbot_ui(lcd, block_whisplay_ui=False):
    """Import a fresh copy of chatbot-ui.py with the LCD stubbed out."""
    stub = types.ModuleType("whisplay_client")
    stub.create_whisplay_hardware = lambda *a, **k: lcd
    sys.modules["whisplay_client"] = stub
    for name in list(sys.modules):
        if name == "whisplay_ui" or name.startswith("whisplay_ui."):
            if name != "whisplay_ui.clock":
                del sys.modules[name]
    if block_whisplay_ui:
        sys.modules["whisplay_ui"] = None
    spec = importlib.util.spec_from_file_location("chatbot_ui_preview", os.path.join(PY_DIR, "chatbot-ui.py"))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    module.whisplay = lcd
    if block_whisplay_ui:
        del sys.modules["whisplay_ui"]
    return module


def safe_area_violations(fb):
    """Pixels that break the rounded-corner safe area (same check as the
    Whisplay launcher's cyber_ui/preview.py). fb is an (H, W, 3) frame.

    - nothing lit inside any corner curve of radius SAFE_CHECK_RADIUS, except
      the full-width status divider hairline;
    - status-bar content (rows above DIVIDER_Y) only between
      STATUS_SAFE_LEFT and STATUS_SAFE_RIGHT (both columns inclusive).
    """
    problems = []
    radius = theme.SAFE_CHECK_RADIUS
    ys, xs = np.mgrid[0:radius, 0:radius]
    curve = (radius - xs) ** 2 + (radius - ys) ** 2 > radius ** 2
    lit = fb.any(axis=2)
    corners = {
        "top-left": (slice(0, radius), slice(0, radius), False, False),
        "top-right": (slice(0, radius), slice(W - radius, W), False, True),
        "bottom-left": (slice(H - radius, H), slice(0, radius), True, False),
        "bottom-right": (slice(H - radius, H), slice(W - radius, W), True, True),
    }
    for name, (rows, cols, flip_y, flip_x) in corners.items():
        mask = curve[::-1] if flip_y else curve
        mask = mask[:, ::-1] if flip_x else mask
        for y, x in zip(*np.nonzero(lit[rows, cols] & mask)):
            ay, ax = y + rows.start, x + cols.start
            if ay == theme.DIVIDER_Y and tuple(fb[ay, ax]) == theme.LINE:
                continue
            problems.append(f"{name} corner pixel at ({ax},{ay})")
    status = lit[:theme.DIVIDER_Y]
    cols = np.flatnonzero(status.any(axis=0))
    if cols.size and (cols[0] < theme.STATUS_SAFE_LEFT or cols[-1] > theme.STATUS_SAFE_RIGHT):
        problems.append(f"status content spans x={cols[0]}..{cols[-1]}")
    return problems


# --------------------------------------------------------------- driver
class Session:
    """One chatbot-ui.py instance driven on the manual clock."""

    def __init__(self, env=None, block_whisplay_ui=False, patch=None):
        self.env_backup = dict(os.environ)
        os.environ.pop("WHISPLAY_UI", None)
        os.environ.update(env or {})
        clock.use_manual(0.0)
        self.lcd = FakeLCD()
        self.cb = load_chatbot_ui(self.lcd, block_whisplay_ui)
        if patch:
            patch(self.cb)
        self.rt = self.cb.RenderThread(self.lcd, base_font(), fps=30)
        self.now = 0.0
        self.next_frame = 0.0
        self.frames = 0
        self.shots = []

    def close(self):
        os.environ.clear()
        os.environ.update(self.env_backup)

    def send(self, **kwargs):
        """Same as one socket message: `image` maps to image_path like handle_client()."""
        if "image" in kwargs:
            kwargs["image_path"] = kwargs.pop("image")
        if "battery_color" in kwargs and isinstance(kwargs["battery_color"], str):
            kwargs["battery_color"] = self.cb.ColorUtils.get_rgb255_from_any(kwargs["battery_color"])
        self.cb.update_display_data(**kwargs)
        self.next_frame = self.now  # render_event.set() wakes the loop

    def frame(self):
        """One iteration of RenderThread.run() without the sleeping."""
        rt, cb = self.rt, self.cb
        if rt.terminal_ui is not None:
            rt.terminal_wait = None
            if cb.camera_mode or cb.current_image_path not in [None, ""]:
                rt.terminal_ui.invalidate()
        animation_active = rt.render_frame(cb.current_status, cb.current_emoji, cb.current_text,
                                           cb.current_scroll_top, cb.current_battery_level, cb.current_battery_color)
        self.frames += 1
        if animation_active:
            return 1.0 / rt.fps
        wait = None
        if rt.pending_auto_scroll_after_hold:
            wait = 0.05
        if rt.terminal_ui is not None and rt.terminal_wait is not None:
            wait = rt.terminal_wait if wait is None else min(wait, rt.terminal_wait)
        return wait

    def run_until(self, t_end):
        while True:
            t = max(self.now, self.next_frame)
            if t > t_end:
                break
            self.now = t
            clock.set_time(t)
            wait = self.frame()
            self.next_frame = float("inf") if wait is None else t + max(wait, 1e-3)
        self.now = t_end
        clock.set_time(t_end)

    def wait(self, seconds):
        self.run_until(self.now + seconds)

    def shot(self, name):
        self.shots.append((name, self.lcd.image()))


# --------------------------------------------------------------- scenario
# Node inserts tool calls as {tool:id} placeholders and updates their text
# (elapsed seconds) through tool_placeholders while the answer streams.
ANSWER = (
    "{tool:t1}\n"
    "Tomorrow in Tokyo: light rain in the morning, clearing by the afternoon. "
    "High 21°C, low 15°C, with a 60% chance of showers before noon.\n\n"
    "Yes, take a compact umbrella. 東京は明日、午前中に小雨の予報です。"
)


def scenario(session):
    """Feed the same display() payloads Node sends, with realistic timing."""
    s = session
    wait = s.wait
    s.send(battery_level=87, battery_color="#34d351", wifi_signal_level=3, network_connected=True)
    wait(0.6)
    s.shot("boot")

    s.send(status="idle", emoji="😴", rag_icon_visible=False,
           text="Long Press the button to say something,\ndouble click to launch camera.")
    wait(2.4)
    s.shot("idle")
    wait(33.0)
    s.shot("idle_settled")

    s.send(status="listening", emoji="😊", text="Listening...", rag_icon_visible=False)
    wait(1.3)
    s.shot("listening")

    s.send(status="recognizing")
    wait(0.6)
    s.shot("transcribing")
    s.send(status="recognizing", text="What's the weather like in Tokyo tomorrow? Should I bring an umbrella?")
    wait(0.3)
    s.shot("transcribed")

    s.send(status="answering...")
    wait(0.8)
    s.send(status="Thinking", emoji="🤔", scroll_speed=6,
           text="The user wants tomorrow's forecast for Tokyo. I should search the web first.")
    wait(0.8)
    s.shot("thinking")

    s.send(status="Tool calling", emoji="🔧", scroll_speed=4, text="[webSearch] Tokyo weather tomorrow")
    wait(0.8)
    s.shot("tool")

    # Streamed answer: Node re-sends the whole text every ~80 ms.
    s.send(status="answering", emoji="🌧", scroll_speed=3, transaction_id=2,
           tool_placeholders={"t1": "% webSearch..."})
    wait(0.3)
    shown = len("{tool:t1}")
    shot_mid = False
    placeholder_updated = False
    while shown < len(ANSWER):
        shown = min(len(ANSWER), shown + 7)
        s.send(status="answering", text=ANSWER[:shown], scroll_speed=3, transaction_id=2)
        wait(0.08)
        if not placeholder_updated and shown > 150:
            s.revealed_before_edit = s.rt.terminal_ui.body.tw.revealed if s.rt.terminal_ui else None
            s.send(tool_placeholders={"t1": "% webSearch 12s..."})
            wait(0.04)
            s.revealed_after_edit = s.rt.terminal_ui.body.tw.revealed if s.rt.terminal_ui else None
            placeholder_updated = True
        if not shot_mid and shown > 95:
            wait(0.03)
            s.shot("answering_stream")
            shot_mid = True
    wait(0.5)
    s.shot("answering_done")

    s.send(scroll_sync={"char_end": 90, "duration_ms": 3600})
    wait(1.1)
    s.shot("speaking")
    wait(2.7)
    s.send(scroll_sync={"char_end": 150, "duration_ms": 2800})
    wait(6.0)
    s.shot("spoken")

    s.send(status="error", emoji="⚠️", text="OpenClaw send failed")
    wait(0.12)
    s.shot("error_glitch")
    wait(0.7)
    s.shot("error")
    # IM mode sends "idle" right after "error"; the error stays latched.
    s.send(status="idle", emoji="😊")
    wait(1.0)
    s.shot("error_latched")
    wait(3.5)
    s.shot("error_released")

    s.send(status="Confirm", emoji="🔐", approval_mode=True, scroll_speed=2, image="",
           text="[shell] Run command\n\nrm -rf ~/.cache/whisplay/tmp")
    wait(0.6)
    s.shot("approval")
    s.send(status="Allowed", emoji="✅", text="Operation allowed.", approval_mode=False, scroll_speed=0)
    wait(0.6)
    s.shot("allowed")

    s.send(status="answering", text="Listing your home folder:", transaction_id=3,
           terminal_text="$ ls -la ~\ntotal 24\ndrwxr-xr-x 5 pi pi 4096 .\n-rw-r--r-- 1 pi pi  220 .bashrc\ndrwxr-xr-x 2 pi pi 4096 whisplay-ai-chatbot")
    wait(1.0)
    s.shot("terminal_output")
    s.send(terminal_text="")

    s.send(status="music", emoji="🎵", text="Now playing: Lo-fi beats to code to", music_progress=0.35, music_duration_ms=215000)
    wait(1.0)
    s.shot("music")
    s.send(music_progress=-1, music_duration_ms=0, status="idle", emoji="😴", text="")
    wait(1.0)

    # Every status indicator at once, low battery and a long custom status.
    s.send(status="Downloading model weights", emoji="📦", text="Fetching whisper-small...",
           battery_level=9, battery_color="#ff0000", vpn_connected=True,
           rag_icon_visible=True, image_icon_visible=True, wifi_signal_level=1)
    wait(0.6)
    s.shot("status_all_indicators")
    s.send(status="idle", emoji="😴", text="", battery_level=87, battery_color="#34d351",
           vpn_connected=False, rag_icon_visible=False, image_icon_visible=False, wifi_signal_level=3)
    wait(1.0)


def contact_sheet(shots, columns=4, scale=1, bezel=True):
    pad, label_h = 12, 18
    cell_w, cell_h = W * scale, H * scale
    rows = (len(shots) + columns - 1) // columns
    sheet = Image.new("RGB", (pad + columns * (cell_w + pad), pad + rows * (cell_h + label_h + pad)), (24, 24, 24))
    draw = ImageDraw.Draw(sheet)
    try:
        font = ImageFont.truetype(os.path.join(PY_DIR, "fonts", "JetBrainsMono-Medium.ttf"), 12)
    except Exception:
        font = ImageFont.load_default()
    for index, (name, image) in enumerate(shots):
        col, row = index % columns, index // columns
        x = pad + col * (cell_w + pad)
        y = pad + row * (cell_h + label_h + pad)
        draw.text((x, y), name, font=font, fill=(200, 200, 200))
        sheet.paste(lcd_view(image, scale, bezel), (x, y + label_h))
    return sheet


def lcd_view(image, scale=1, bezel=True):
    image = image.resize((W * scale, H * scale), Image.NEAREST) if scale != 1 else image.copy()
    if bezel:
        mask = Image.new("L", image.size, 0)
        ImageDraw.Draw(mask).rounded_rectangle([0, 0, image.width - 1, image.height - 1], radius=20 * scale, fill=255)
        back = Image.new("RGB", image.size, (24, 24, 24))
        image = Image.composite(image, back, mask)
    return image


def run_preview(out_dir, scale, bezel):
    os.makedirs(out_dir, exist_ok=True)
    session = Session()
    try:
        if session.rt.terminal_ui is None:
            raise SystemExit("terminal UI did not start (WHISPLAY_UI=classic set or init failed)")
        scenario(session)
        if session.rt.terminal_ui is None:
            raise SystemExit("terminal UI fell back to classic during the preview")
        for name, image in session.shots:
            lcd_view(image, scale, bezel).save(os.path.join(out_dir, f"{name}.png"))
        sheet = contact_sheet(session.shots, scale=1, bezel=bezel)
        sheet.save(os.path.join(out_dir, "contact_sheet.png"))
        print(f"[preview] {len(session.shots)} states, {session.frames} frames -> {out_dir}")
    finally:
        session.close()


# --------------------------------------------------------------- selftest
class Check:
    def __init__(self):
        self.failed = 0

    def __call__(self, ok, label):
        print(("  PASS " if ok else "  FAIL ") + label)
        if not ok:
            self.failed += 1


def selftest():
    check = Check()

    print("[selftest] terminal UI is the default and survives every state")
    s = Session()
    try:
        check(s.rt.terminal_ui is not None, "terminal UI created when WHISPLAY_UI is unset")
        scenario(s)
        check(s.rt.terminal_ui is not None, "no fallback during the full scenario")
        before, after = s.revealed_before_edit, s.revealed_after_edit
        check(before is not None and after is not None and after >= before,
              f"tool placeholder update keeps typed text ({before:.0f} -> {after:.0f} units)")
        check(s.lcd.fb.any(), "frames reached the LCD")
        for name, image in s.shots:
            problems = safe_area_violations(np.asarray(image))
            if name != "approval" and np.asarray(image)[theme.CONTENT_SAFE_BOTTOM:].any():
                problems.append("content below CONTENT_SAFE_BOTTOM")
            check(not problems, f"safe area respected: {name}" + (f" {problems[:3]}" if problems else ""))
    finally:
        s.close()

    print("[selftest] idle stays lightweight and updates are partial")
    s = Session()
    try:
        s.send(status="idle", emoji="😴", text="Long Press the button to say something.")
        s.run_until(40.0)  # rain finished
        s.lcd.pushes.clear()
        frames = s.frames
        s.run_until(70.0)
        pixels = sum(w * h for _, _, w, h in s.lcd.pushes)
        renders = s.frames - frames
        print(f"         30 s settled idle: {renders} renders, {len(s.lcd.pushes)} pushes, {pixels * 2 / 30.0:.0f} B/s")
        check(renders <= 70, "settled idle renders only on blink/clock edges")
        check(pixels * 2 / 30.0 < 4096, "settled idle pushes < 4 KB/s")
        s.send(status="listening", text="Listening...")
        s.run_until(70.5)
        s.lcd.pushes.clear()
        s.run_until(71.5)
        top = min(y for _, y, _, _ in s.lcd.pushes)
        bottom = max(y + h for _, y, _, h in s.lcd.pushes)
        check(top >= theme.PANE_Y and bottom <= theme.BODY_TOP_STAGE, "listening animates only the stage region")
    finally:
        s.close()

    print("[selftest] WHISPLAY_UI=classic forces the original UI")
    s = Session(env={"WHISPLAY_UI": "classic"})
    try:
        check(s.rt.terminal_ui is None, "terminal UI not created")
        s.send(status="idle", emoji="😴", text="hello")
        s.run_until(0.5)
        check((0, 0, W, 98) in s.lcd.pushes, "classic header (0,0,240,98) drawn")
    finally:
        s.close()

    print("[selftest] runtime failure falls back to classic")
    s = Session()
    try:
        s.send(status="idle", text="hello")
        s.run_until(0.5)

        def boom(_snapshot):
            raise RuntimeError("injected render failure")

        s.rt.terminal_ui.render = boom
        s.lcd.pushes.clear()
        s.send(status="listening", text="Listening...")
        s.run_until(1.0)
        check(s.rt.terminal_ui is None, "terminal UI disabled after the failure")
        check((0, 0, W, 98) in s.lcd.pushes, "classic UI drew in the same frame")
    finally:
        s.close()

    print("[selftest] init failure falls back to classic")

    def break_init(cb):
        import whisplay_ui.terminal_ui as tui

        def fail(*_a, **_k):
            raise RuntimeError("injected init failure")

        tui.TerminalUI = fail

    s = Session(patch=break_init)
    try:
        check(s.rt.terminal_ui is None, "terminal UI disabled when construction fails")
        s.send(status="idle", text="hello")
        s.run_until(0.5)
        check((0, 0, W, 98) in s.lcd.pushes, "classic UI drew")
    finally:
        s.close()

    print("[selftest] missing whisplay_ui package -> classic")
    s = Session(block_whisplay_ui=True)
    try:
        check(s.rt.terminal_ui is None, "chatbot-ui.py still starts, classic UI")
    finally:
        s.close()

    print("[selftest] missing optional fonts")
    empty = tempfile.mkdtemp(prefix="whisplay-nofonts-")

    def no_fonts(cb):
        import whisplay_ui.terminal_ui as tui
        tui.Fonts = functools.partial(tui.Fonts, font_dir=empty)

    s = Session(patch=no_fonts)
    try:
        ui = s.rt.terminal_ui
        check(ui is not None, "terminal UI starts without bundled fonts")
        check(ui is not None and not ui.fonts.loaded["mono"] and not ui.fonts.loaded["pixel"], "falls back to the base font")
        scenario(s)
        check(s.rt.terminal_ui is not None, "all states render without bundled fonts")
    finally:
        s.close()

    def no_base_font(cb):
        import whisplay_ui.terminal_ui as tui
        original = tui.Fonts
        tui.Fonts = lambda _path, emoji_loader=None: original("/nonexistent/font.ttf", emoji_loader, font_dir=empty)

    s = Session(patch=no_base_font)
    try:
        check(s.rt.terminal_ui is not None, "terminal UI starts with no usable font file at all")
        scenario(s)
        check(s.rt.terminal_ui is not None, "all states render with Pillow's built-in font")
    finally:
        s.close()
        shutil.rmtree(empty, ignore_errors=True)

    print("[selftest] camera mode is untouched")
    s = Session()
    try:
        s.send(status="idle", text="hello")
        s.run_until(1.0)
        s.cb.camera_mode = True
        s.lcd.pushes.clear()
        s.send(status="camera")
        s.run_until(3.0)
        check(not s.lcd.pushes, "nothing drawn while camera_mode is on")
        s.cb.camera_mode = False
        s.send(status="idle")
        s.run_until(3.1)
        check((0, 0, W, H) in s.lcd.pushes, "full redraw after leaving camera mode")
    finally:
        s.close()

    print("[selftest] image mode is identical to classic")
    image_path = os.path.join(PY_DIR, "img", "logo.png")
    results = {}
    for mode in ("terminal", "classic"):
        s = Session(env={"WHISPLAY_UI": mode})
        try:
            s.send(status="idle", text="hello")
            s.run_until(1.0)
            s.lcd.pushes.clear()
            s.send(image=image_path)
            s.run_until(1.5)
            results[mode] = (s.lcd.fb.copy(), list(s.lcd.pushes))
            if mode == "terminal":
                s.send(image="")
                s.lcd.pushes.clear()
                s.run_until(2.0)
                check((0, 0, W, H) in s.lcd.pushes, "full terminal redraw after image mode ends")
        finally:
            s.close()
    check(np.array_equal(results["terminal"][0], results["classic"][0]), "image-mode pixels identical to classic")
    check(all(p == (0, 0, W, H) for p in results["terminal"][1]), "image mode drawn by the classic full-screen path")

    print("[selftest] real RenderThread.run() loop on the wall clock (WHISPLAY_UI_RAIN=false)")
    s = Session(env={"WHISPLAY_UI_RAIN": "false"})
    try:
        import time as _time
        clock.use_real()
        s.rt.start()
        s.cb.update_display_data(status="listening", text="Listening...")
        _time.sleep(1.0)
        listen_pushes = len(s.lcd.pushes)
        s.cb.update_display_data(status="idle", text="Long Press the button to say something.")
        _time.sleep(1.5)
        s.lcd.pushes.clear()
        _time.sleep(2.0)
        idle_pushes = len(s.lcd.pushes)
        s.rt.stop()
        s.rt.join(timeout=2.0)
        print(f"         listening: {listen_pushes} pushes in 1 s, idle: {idle_pushes} pushes in 2 s")
        check(listen_pushes >= 15, "listening animates in the threaded loop")
        check(idle_pushes <= 8, "idle loop sleeps between blink edges")
        check(not s.rt.is_alive(), "render thread stops cleanly")
        check(s.rt.terminal_ui is not None, "no fallback in the threaded loop")
    finally:
        clock.use_manual(0.0)
        s.close()

    print(f"[selftest] {'OK' if not check.failed else str(check.failed) + ' FAILED'}")
    return 1 if check.failed else 0


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--out", default=os.path.join(HERE, "preview_out"), help="output folder")
    parser.add_argument("--scale", type=int, default=2, help="pixel scale for single-state PNGs")
    parser.add_argument("--no-bezel", action="store_true", help="do not mask the rounded LCD corners")
    parser.add_argument("--selftest", action="store_true", help="run integration checks instead")
    args = parser.parse_args()
    if args.selftest:
        sys.exit(selftest())
    run_preview(os.path.abspath(args.out), args.scale, not args.no_bezel)


if __name__ == "__main__":
    main()
