"""Shared radio glyphs, vendored identically in the chatbot. No system I/O."""


class RadioPalette:
    DIM, LINE = (90, 109, 90), (24, 40, 33)
    RED_DIM, RED = (82, 24, 24), (255, 89, 82)
    GREEN, CYAN, AMBER = (74, 235, 123), (90, 203, 222), (255, 178, 49)


def draw_wireless(draw, right, center, state, palette=RadioPalette):
    wifi = state.get('wifi', {})
    enabled, connected = wifi.get('enabled'), wifi.get('connected')
    signal = wifi.get('signal')
    level = (3 if signal >= 67 else 2 if signal >= 34 else 1) if type(signal) is int and 0 <= signal <= 100 else 0
    # Eleven-pixel curved Wi-Fi fan, then the existing eight-pixel Bluetooth rune.
    # The 21-pixel allocation is unchanged in Home, GLaDOS and classic fallback.
    x = right - 21
    active = enabled is True and connected is True
    for index, radius in enumerate((3, 5, 7)):
        color = palette.DIM if not active else palette.GREEN if index < level else palette.LINE
        draw.arc((x+5-radius, center+3-radius, x+5+radius, center+3+radius), 225, 315, fill=color)
    draw.rectangle((x+5, center+3, x+6, center+4), fill=palette.GREEN if active else palette.DIM)
    if enabled is True and connected is False:
        draw.line((x+1, center-4, x+9, center+4), fill=palette.RED)
    if enabled is None or enabled is True and (connected is None or connected and level == 0):
        draw.rectangle((x+8, center-5, x+10, center-3), outline=palette.AMBER)
    x = right - 8
    powered = state.get('bluetooth', {}).get('enabled')
    color = palette.CYAN if powered is True else palette.DIM
    draw.line((x + 3, center - 5, x + 3, center + 5, x + 7, center + 2, x, center - 3), fill=color)
    draw.line((x + 3, center - 5, x + 7, center - 2, x, center + 3), fill=color)
    if powered is None:
        draw.point((x + 8, center - 5), fill=palette.AMBER)
    return right - 21


class WirelessStatusIcon:
    def __init__(self, state, palette=RadioPalette):
        self.state, self.palette = state, palette

    def measure(self):
        return (21, 12)

    def render(self, draw, x, y):
        draw_wireless(draw, x + 21, y + 6, self.state, self.palette)
