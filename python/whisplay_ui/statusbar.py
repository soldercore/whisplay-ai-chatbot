"""Home-matched essential header; optional badges stay in the content pane."""
from PIL import Image, ImageDraw
from . import theme
from .draw_util import draw_text, fit_text
from .status_icons import draw_home_wireless

CENTER_Y = theme.STATUS_CENTER_Y
GAP = 6


def battery_color(level):
    return theme.RED if level <= 10 else theme.AMBER if level <= 30 else theme.GREEN


class StatusBar:
    def __init__(self, fonts, icon_factories=None, icon_context=None):
        self.fonts = fonts
        self.icon_factories = icon_factories if icon_factories is not None else []
        self.icon_context = icon_context

    def key(self, model):
        return (model["label"], model["color"], model["clock"], model["battery_level"],
                model.get("wireless_status"), model["wifi_level"], model["network_connected"])

    def extras_key(self, model):
        return (bool(model["vpn"]), bool(model["rag"]), bool(model["image"]),
                len(self.icon_factories), self.key(model) if self.icon_factories else None)

    def render(self, model):
        image = Image.new("RGB", (theme.WIDTH, theme.STATUS_H), theme.VOID)
        draw = ImageDraw.Draw(image)
        fonts, color = self.fonts, model["color"]
        draw.line((0, theme.DIVIDER_Y, theme.WIDTH-1, theme.DIVIDER_Y), fill=theme.LINE)
        draw.rectangle((24, CENTER_Y-3, 29, CENTER_Y+2), fill=color)
        # Keep room for the clock for every state label. Unknown generic states fit.
        label = fit_text(fonts.pixel8, model["label"], 64)
        left = draw_text(draw, image, fonts.pixel8, 34, CENTER_Y, label, theme.TEXT)
        draw.line((24, theme.DIVIDER_Y, int(left), theme.DIVIDER_Y), fill=theme.GREEN_MID if color == theme.GREEN else color)
        level = model["battery_level"]
        valid = type(level) is int and 0 <= level <= 100
        text = "%d%%" % level if valid else "--%"
        right = int(theme.STATUS_SAFE_RIGHT-fonts.meta_bold.width(text))
        fg = battery_color(level) if valid and level <= 30 else theme.TEXT if valid else theme.MUTED
        draw_text(draw, image, fonts.meta_bold, right, CENTER_Y, text, fg)
        state = model.get("wireless_status")
        if state is None:
            wifi = model["wifi_level"]
            state = {'wifi': {'enabled': True if wifi else None,
                     'connected': False if model["network_connected"] is False else True if wifi else None,
                     'signal': {1:20, 2:50, 3:90}.get(wifi)}, 'bluetooth': {}}
        radio_right = int(theme.STATUS_SAFE_RIGHT-fonts.meta_bold.width("100%")-GAP)
        right = draw_home_wireless(image, radio_right, CENTER_Y, state)
        if model["clock"]:
            width = fonts.meta_bold.width(model["clock"])
            x = max(int((theme.WIDTH-width)/2), int(left+GAP))
            if x+width <= right-GAP:
                draw_text(draw, image, fonts.meta_bold, x, CENTER_Y, model["clock"], theme.TEXT)
        return image

    def render_extras(self, model):
        image = Image.new("RGBA", (theme.WIDTH, theme.STAGE_VISUAL_H))
        draw = ImageDraw.Draw(image)
        right = theme.CHROME_RIGHT
        for flag, text, fg, border in (
            ("vpn", "VPN", theme.CYAN, theme.CYAN_DIM),
            ("rag", "RAG", theme.AMBER, theme.AMBER_DIM),
            ("image", "IMG", theme.GREEN, theme.GREEN_DIM),
        ):
            if model[flag]:
                right = self._tag(draw, image, right-GAP, text, fg, border)
        self._plugin_icons(image, right, model)
        return image

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
                    if x0 < 140:  # Leave the title and activity dots unobscured.
                        return right
                    image.paste(tile, (x0, CENTER_Y - tile.height // 2), tile)
                    right = x0
                except Exception as exc:
                    print(f"[TerminalUI] status icon render failed: {exc}")
        return right

