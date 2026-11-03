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
    x, base = right - 8, center + 4
    for index in range(3):
        color = palette.DIM if enabled is False else palette.RED_DIM if connected is False else palette.GREEN if index < level else palette.LINE
        draw.rectangle((x + index * 3, base - (3 + index * 3) + 1, x + index * 3 + 1, base), fill=color)
    if enabled is True and connected is False:
        draw.line((x, base - 7, x + 7, base), fill=palette.RED)
    if enabled is None or enabled is True and (connected is None or connected and level == 0):
        draw.point((x + 7, center - 5), fill=palette.AMBER)
    x -= 13
    powered = state.get('bluetooth', {}).get('enabled')
    color = palette.CYAN if powered is True else palette.DIM
    draw.line((x + 3, center - 5, x + 3, center + 5, x + 7, center + 2, x, center - 3), fill=color)
    draw.line((x + 3, center - 5, x + 7, center - 2, x, center + 3), fill=color)
    if powered is None:
        draw.point((x + 8, center - 5), fill=palette.AMBER)
    return x


class WirelessStatusIcon:
    def __init__(self, state, palette=RadioPalette):
        self.state, self.palette = state, palette

    def measure(self):
        return (21, 12)

    def render(self, draw, x, y):
        draw_wireless(draw, x + 21, y + 6, self.state, self.palette)
