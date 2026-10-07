"""Status bar: state badge, clock, and battery / Wi-Fi / VPN / RAG / image
indicators, plus any plugin status icons registered with chatbot-ui.py."""
from PIL import Image, ImageDraw

from . import theme
from .draw_util import draw_text, fit_text

CENTER_Y = theme.STATUS_CENTER_Y
GAP = 6


def battery_color(level):
    # Same thresholds Node uses for battery_color (src/status/battery-status.ts).
    if level <= 10:
        return theme.RED
    if level <= 30:
        return theme.AMBER
    return theme.GREEN


class StatusBar:
    def __init__(self, fonts, icon_factories=None, icon_context=None):
        self.fonts = fonts
        self.icon_factories = icon_factories if icon_factories is not None else []
        self.icon_context = icon_context  # callable(model) -> classic icon context

    def key(self, model):
        return (
            model["label"],
            model["color"],
            model["clock"],
            model["battery_level"],
            model["wifi_level"],
            model["network_connected"],
            bool(model["vpn"]),
            bool(model["rag"]),
            bool(model["image"]),
            len(self.icon_factories),
        )

    def render(self, model):
        image = Image.new("RGB", (theme.WIDTH, theme.STATUS_H), theme.VOID)
        draw = ImageDraw.Draw(image)
        fonts = self.fonts
        color = model["color"]

        # Divider with a state-coloured accent under the badge.
        draw.line([(0, theme.DIVIDER_Y), (theme.WIDTH - 1, theme.DIVIDER_Y)], fill=theme.LINE)

        # ---- right cluster, laid out right to left
        right = theme.STATUS_SAFE_RIGHT
        level = model["battery_level"]
        if level is not None:
            right = self._battery(draw, image, right, level)
        wifi = model["wifi_level"]
        if wifi:
            right = self._wifi(draw, right - GAP, wifi, model["network_connected"])
        for flag, text, fg, border in (
            ("vpn", "VPN", theme.CYAN, theme.CYAN_DIM),
            ("rag", "RAG", theme.AMBER, theme.AMBER_DIM),
            ("image", "IMG", theme.GREEN, theme.GREEN_DIM),
        ):
            if model[flag]:
                right = self._tag(draw, image, right - GAP, text, fg, border)
        right = self._plugin_icons(image, right, model)

        # ---- left: state badge, fitted to the room the indicators leave
        x = theme.STATUS_SAFE_LEFT
        draw.rectangle([x, CENTER_Y - 3, x + 5, CENTER_Y + 2], fill=color)
        label_x = x + 10
        label = fit_text(fonts.pixel8, model["label"], max(0, min(86, right - GAP - label_x)))
        left_end = draw_text(draw, image, fonts.pixel8, label_x, CENTER_Y, label, color)
        draw.line([(x, theme.DIVIDER_Y), (int(left_end), theme.DIVIDER_Y)], fill=color)

        # ---- centre: clock, only if it fits between badge and indicators
        clock = model["clock"]
        if clock:
            stack = fonts.meta_bold
            width = stack.width(clock)
            cx = int((theme.WIDTH - width) / 2)
            if cx < left_end + GAP:
                cx = int(left_end + GAP)
            if cx + width <= right - GAP:
                draw_text(draw, image, stack, cx, CENTER_Y, clock, theme.MUTED)
        return image

    # -- pieces -------------------------------------------------------------
    def _battery(self, draw, image, right, level):
        try:
            level = max(0, min(100, int(level)))
        except (TypeError, ValueError):
            level = 0
        fill = battery_color(level)
        nub_w, body_w, body_h = 2, 20, 10
        x1 = right - nub_w
        x0 = x1 - body_w
        y0 = CENTER_Y - body_h // 2
        y1 = y0 + body_h - 1
        draw.rectangle([x1 + 1, CENTER_Y - 2, x1 + nub_w, CENTER_Y + 1], fill=theme.MUTED)
        draw.rectangle([x0, y0, x1, y1], outline=theme.MUTED)
        inner = body_w - 4
        filled = int(round(inner * level / 100.0))
        if filled > 0:
            draw.rectangle([x0 + 2, y0 + 2, x0 + 1 + filled, y1 - 2], fill=fill)
        text = "%d" % level
        stack = self.fonts.pixel8
        tx = x0 - 3 - stack.width(text)
        draw_text(draw, image, stack, tx, CENTER_Y, text, fill if level <= 30 else theme.MUTED)
        return int(tx)

    def _wifi(self, draw, right, level, connected):
        try:
            level = max(0, min(3, int(level)))
        except (TypeError, ValueError):
            level = 0
        offline = connected is False
        bar_w, gap = 2, 1
        width = 3 * bar_w + 2 * gap
        x = right - width
        base = CENTER_Y + 4
        for index in range(3):
            height = 3 + index * 3
            bx = x + index * (bar_w + gap)
            if offline:
                fill = theme.RED_DIM
            else:
                fill = theme.GREEN if index < level else theme.LINE
            draw.rectangle([bx, base - height + 1, bx + bar_w - 1, base], fill=fill)
        if offline:
            draw.line([(x, base - 7), (x + width - 1, base)], fill=theme.RED)
        return x

    def _tag(self, draw, image, right, text, fg, border):
        stack = self.fonts.pixel8
        width = int(stack.width(text)) + 5
        x0 = right - width
        draw.rectangle([x0, CENTER_Y - 5, right - 1, CENTER_Y + 4], outline=border)
        draw_text(draw, image, stack, x0 + 3, CENTER_Y, text, fg)
        return x0

    def _plugin_icons(self, image, right, model):
        if not self.icon_factories or self.icon_context is None:
            return right
        try:
            context = self.icon_context(model)
        except Exception:
            return right
        for item in sorted(self.icon_factories, key=lambda entry: entry.get("priority", 100)):
            try:
                icons = item["factory"](context) or []
            except Exception as exc:
                print(f"[TerminalUI] status icon factory failed: {exc}")
                continue
            for icon in icons:
                try:
                    width, height = icon.measure()
                    width, height = max(1, int(width)), max(1, int(height))
                    tile = Image.new("RGBA", (width + 2, height + 2), (0, 0, 0, 0))
                    icon.render(ImageDraw.Draw(tile), 0, 0)
                    if tile.height > 14:
                        scale = 14.0 / tile.height
                        tile = tile.resize((max(1, int(tile.width * scale)), 14), Image.LANCZOS)
                    x0 = right - GAP - tile.width
                    if x0 < theme.WIDTH // 2:
                        return right
                    image.paste(tile, (x0, CENTER_Y - tile.height // 2), tile)
                    right = x0
                except Exception as exc:
                    print(f"[TerminalUI] status icon render failed: {exc}")
        return right

