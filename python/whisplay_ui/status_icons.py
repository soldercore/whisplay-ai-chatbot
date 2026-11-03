"""Radio sprites vendored from Whisplay Home 2593eda, home_icons.py.

Keep pixel-identical; consumes the existing daemon snapshot, with no I/O.
"""
from functools import lru_cache
from PIL import Image, ImageDraw
from . import theme

# Symmetric one-pixel arcs on a 13x11 grid. The point shares the same x centre.
WIFI_ARCS = (
    ((5, 6), (6, 6), (7, 6), (4, 7), (8, 7)),
    ((5, 3), (6, 3), (7, 3), (3, 4), (4, 4), (8, 4), (9, 4), (2, 5), (10, 5)),
    ((4, 0), (5, 0), (6, 0), (7, 0), (8, 0), (2, 1), (3, 1), (9, 1), (10, 1),
     (1, 2), (11, 2), (0, 3), (12, 3)),
)


def _wifi(draw, x, y, colors, point):
    for pixels, color in zip(WIFI_ARCS, colors):
        draw.point([(x+px, y+py) for px, py in pixels], fill=color)
    draw.point((x+6, y+10), fill=point)


@lru_cache(maxsize=16)
def _wifi_sprite(mode, level):
    tile = Image.new('RGBA', (13,11))
    d = ImageDraw.Draw(tile)
    colors = tuple(theme.GREEN if mode == 'active' and i < level else theme.DIM for i in range(3))
    _wifi(d,0,0,colors,theme.GREEN if mode == 'active' else theme.DIM)
    if mode == 'disconnected':
        d.line((2,0,10,10),fill=theme.RED)
    elif mode == 'unknown' or mode == 'active' and level == 0:
        d.rectangle((10,0,12,2),outline=theme.AMBER)
    return tile


@lru_cache(maxsize=3)
def _bluetooth_sprite(mode):
    tile = Image.new('RGBA', (9,11))
    d = ImageDraw.Draw(tile)
    color = theme.TEXT if mode == 'active' else theme.DIM
    d.line(((3,0),(3,10),(7,7),(0,2)),fill=color)
    d.line(((3,0),(7,3),(0,8)),fill=color)
    if mode == 'unknown':
        d.point((8,0),fill=theme.AMBER)
    return tile


def draw_home_wireless(image, right, center, state):
    wifi, bt = state.get('wifi',{}), state.get('bluetooth',{})
    enabled, connected, signal = wifi.get('enabled'), wifi.get('connected'), wifi.get('signal')
    mode = ('disabled' if enabled is False else 'active' if enabled is True and connected is True
            else 'disconnected' if enabled is True and connected is False else 'unknown')
    level = (3 if signal >= 67 else 2 if signal >= 34 else 1) if type(signal) is int and 0 <= signal <= 100 else 0
    powered = bt.get('enabled')
    bt_mode = 'active' if powered is True else 'disabled' if powered is False else 'unknown'
    left = right-27
    for tile,x in ((_wifi_sprite(mode,level),left),(_bluetooth_sprite(bt_mode),right-9)):
        image.paste(tile,(x,center-5),tile)
    return left
