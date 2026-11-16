"""The GLaDOS optic: the one identity element of the interface.

A lens behind a six-leaf shutter, set in a machined housing. The shutter is the personality: dormant it
is almost closed and the lens is a cold glint; it snaps open when Capri is heard, breathes and drifts
while listening (the lens looks very slightly off-axis, as if it were watching you), scans while it reads
speech, and turns slowly, with a marker orbiting the housing, while it thinks. Nothing is decoration:
every moving part reports a state.

Drawing is supersampled (4x) and reduced with a box filter. Frames are cached by their quantised pose, so
a held pose costs nothing after its first render. `Motion` keeps the pose continuous between states with
frame-rate independent smoothing (a damped spring for the shutter, exponential smoothing for the rest),
so a transition never jumps and costs frames only while something is actually moving.
"""
import math
from functools import lru_cache

from PIL import Image, ImageDraw

from . import theme
from . import visual_state as vs
from .draw_util import mix

SS = 4
LEAVES = 6
SHEAR = 16.0                      # degrees: how far each leaf's radial edge is swept (the pinwheel look)
LEAF = (22, 19, 16)
HOUSING = 54.0                    # housing ring radius, in 1/112 units
GROOVE = 49.0
LEAF_OUT = 44.0
LENS_R = 23.0


def _pol(cx, cy, r, deg):
    a = math.radians(deg)
    return cx + math.cos(a) * r, cy + math.sin(a) * r


@lru_cache(maxsize=96)
def hero(size, opening, rot, dx, dy, act, bright, arc, orbit, scan, notches, mark, jam):
    """size px square, VOID background. All arguments are quantised by the caller (they form the cache key).

    opening: radius of the shutter opening (units of 1/112 size). rot: leaf rotation, degrees.
    dx, dy: lens offset behind the shutter. act: 0..8 (housing/edge colour, dormant to live).
    bright: 0..8 (lens colour, dim to bright). arc: remaining fraction of a time limit in 1/72 steps (-1: none).
    orbit: degrees of the orbiting marker (-1: none). scan: scan-line position 0..32 (-1: none).
    notches: 0..4 lit registration notches. mark: "", "!", "?", "ok", "x". jam: degrees one leaf is stuck open.
    """
    u = size * SS / 112.0
    big = size * SS
    image = Image.new("RGB", (big, big), theme.VOID)
    draw = ImageDraw.Draw(image)
    c = big / 2.0
    live = act / 8.0
    ring = mix(theme.INK3, theme.ACCENT, live)
    edge = mix(theme.INK3, theme.ACCENT_MID, live)
    lens_color = mix(theme.ACCENT_DIM, theme.ACCENT, min(1.0, bright / 8.0))
    if bright > 8.0:
        lens_color = mix(theme.ACCENT, theme.INK, min(1.0, (bright - 8.0) / 2.0) * 0.6)

    # --- lens, seen through the opening
    lx, ly, lr = c + dx * u, c + dy * u, LENS_R * u
    draw.ellipse([lx - lr, ly - lr, lx + lr, ly + lr], fill=lens_color)
    inner = lr * 0.58
    draw.ellipse([lx - inner, ly - inner, lx + inner, ly + inner], outline=mix(lens_color, theme.VOID, 0.45), width=max(1, int(0.9 * u)))
    core = lr * 0.2
    draw.ellipse([lx - core, ly - core, lx + core, ly + core], fill=mix(lens_color, theme.VOID, 0.55))
    glint = lr * 0.13
    gx, gy = lx - lr * 0.42, ly - lr * 0.42
    draw.ellipse([gx - glint, gy - glint, gx + glint, gy + glint], fill=mix(lens_color, theme.INK, 0.6))
    if scan >= 0:
        y = ly + (scan / 32.0 * 2.0 - 1.0) * lr
        half = math.sqrt(max(0.0, lr * lr - (y - ly) ** 2))
        if half > 1:
            draw.line([(lx - half, y), (lx + half, y)], fill=mix(theme.INK, lens_color, 0.25), width=max(1, int(1.6 * u)))
    if mark:
        _mark(draw, lx, ly, u, mark)

    # --- the six leaves of the shutter (a tiled pinwheel), drawn over the lens
    r = max(0.0, opening) * u
    ro = LEAF_OUT * u
    width = max(1, int(1.1 * u))
    for k in range(LEAVES):
        theta = rot + 60.0 * k
        stuck = float(jam) if (jam and k == 2) else 0.0
        poly = [_pol(c, c, ro, theta + SHEAR), _pol(c, c, ro, theta + 60.0 + SHEAR),
                _pol(c, c, r + stuck * 0.25 * u, theta + 60.0 + stuck), _pol(c, c, r + stuck * 0.25 * u, theta + stuck)]
        draw.polygon(poly, fill=LEAF)
        draw.line(poly + [poly[0]], fill=theme.TICK if live < 0.15 else mix(theme.TICK, edge, 0.6), width=width)
    if r > 2 * u:
        pts = [_pol(c, c, r, rot + 60.0 * k) for k in range(LEAVES)]
        draw.line(pts + [pts[0]], fill=edge, width=max(1, int(1.3 * u)))

    # --- housing: groove, orbit/timer, registration notches, ring
    gr = GROOVE * u
    draw.ellipse([c - gr, c - gr, c + gr, c + gr], outline=theme.HAIR, width=max(1, int(1.0 * u)))
    if arc >= 0:
        sweep = 360.0 * arc / 72.0
        if sweep > 0.5:
            draw.arc([c - gr, c - gr, c + gr, c + gr], -90, -90 + sweep, fill=theme.ACCENT, width=max(1, int(2.2 * u)))
    if orbit >= 0:
        segments = 6
        for i in range(segments):
            a0 = orbit - (i + 1) * 9.0
            a1 = orbit - i * 9.0
            shade = mix(theme.ACCENT, theme.ACCENT_DIM, i / float(segments))
            draw.arc([c - gr, c - gr, c + gr, c + gr], a0, a1, fill=shade, width=max(1, int((3.4 - i * 0.35) * u)))
        px, py = _pol(c, c, gr, orbit)
        dot = 3.0 * u
        draw.ellipse([px - dot, py - dot, px + dot, py + dot], fill=theme.ACCENT)
    for index in range(4):
        lit = index < notches
        tip = _pol(c, c, (GROOVE - 7.5) * u, -90 + 90 * index)
        left = _pol(c, c, (HOUSING - 2.5) * u, -90 + 90 * index - 3.2)
        right = _pol(c, c, (HOUSING - 2.5) * u, -90 + 90 * index + 3.2)
        draw.polygon([tip, left, right], fill=theme.ACCENT if lit else theme.TICK)
    hr = HOUSING * u
    draw.ellipse([c - hr, c - hr, c + hr, c + hr], outline=ring, width=max(1, int(2.0 * u)))
    return image.reduce(SS)


def _mark(draw, cx, cy, u, mark):
    color = theme.VOID
    w = max(2, int(round(4.6 * u)))
    if mark == "!":
        draw.line([(cx, cy - 13 * u), (cx, cy + 3 * u)], fill=color, width=w)
        draw.ellipse([cx - 2.8 * u, cy + 9 * u, cx + 2.8 * u, cy + 14.6 * u], fill=color)
    elif mark == "ok":
        draw.line([(cx - 12 * u, cy + 1 * u), (cx - 4 * u, cy + 9 * u), (cx + 13 * u, cy - 10 * u)], fill=color, width=w, joint="curve")
    elif mark == "x":
        draw.line([(cx - 10 * u, cy - 10 * u), (cx + 10 * u, cy + 10 * u)], fill=color, width=w)
        draw.line([(cx - 10 * u, cy + 10 * u), (cx + 10 * u, cy - 10 * u)], fill=color, width=w)
    elif mark == "?":
        draw.arc([cx - 9 * u, cy - 14 * u, cx + 9 * u, cy + 4 * u], 200, 90 + 360, fill=color, width=w)
        draw.line([(cx, cy + 3 * u), (cx, cy + 6 * u)], fill=color, width=w)
        draw.ellipse([cx - 2.8 * u, cy + 10 * u, cx + 2.8 * u, cy + 15.6 * u], fill=color)


@lru_cache(maxsize=64)
def mini(size, opening, act, bright):
    """A 20-26 px optic for the response strip: housing, six leaves, shutter opening and lens."""
    u = size * SS / 28.0
    big = size * SS
    image = Image.new("RGB", (big, big), theme.VOID)
    draw = ImageDraw.Draw(image)
    c = big / 2.0
    live = act / 8.0
    ring = mix(theme.INK3, theme.ACCENT, live)
    lens = mix(theme.ACCENT_DIM, theme.ACCENT, min(1.0, bright / 8.0))
    lr = 6.2 * u
    draw.ellipse([c - lr, c - lr, c + lr, c + lr], fill=lens)
    r = max(0.0, opening) * u
    for k in range(LEAVES):
        theta = 60.0 * k
        poly = [_pol(c, c, 11.5 * u, theta + SHEAR), _pol(c, c, 11.5 * u, theta + 60.0 + SHEAR),
                _pol(c, c, r, theta + 60.0), _pol(c, c, r, theta)]
        draw.polygon(poly, fill=LEAF)
        draw.line(poly + [poly[0]], fill=theme.TICK if live < 0.15 else mix(theme.TICK, ring, 0.55), width=max(1, int(0.8 * u)))
    hr = 12.6 * u
    draw.ellipse([c - hr, c - hr, c + hr, c + hr], outline=ring, width=max(1, int(1.4 * u)))
    return image.reduce(SS)


# ------------------------------------------------------------------------------------------------- motion
def _wrap60(deg):
    return (deg + 30.0) % 60.0 - 30.0


class Motion:
    """Continuous pose of the hero optic across states.

    target(...) gives what the current state asks for; step(...) moves the pose towards it. The shutter is a
    damped spring (a snap with a small overshoot), everything else eases exponentially. Both use the real
    elapsed time, so the motion is the same at any frame rate.
    """
    SPRING_K = 520.0           # 1/s^2: stiffness (about 3.6 Hz)
    SPRING_C = 30.0            # 1/s: damping (a little under critical)
    TAU = {"act": 0.10, "bright": 0.09, "rot": 0.16, "dx": 0.20, "dy": 0.20}

    def __init__(self):
        self.pose = {"opening": 5.0, "rot": 0.0, "dx": 0.0, "dy": 0.0, "act": 0.0, "bright": 1.5, "arc": -1.0}
        self.vel = 0.0
        self.last = None
        self.moving_until = 0.0
        self.quiet = {"scan": -1, "orbit": -1, "notches": 0, "mark": "", "jam": 0}

    # ---- what a state asks for
    def target(self, state, tokens, t, glance=0.0):
        sin, cos, pi = math.sin, math.cos, math.pi
        tgt = {"opening": 5.0, "rot": 0.0, "dx": 0.0, "dy": 0.0, "act": 0.0, "bright": 1.5, "arc": -1.0}
        extra = {"scan": -1, "orbit": -1, "notches": 0, "mark": "", "jam": 0}
        if state == vs.LISTEN:
            audio = "audio" in tokens
            tgt.update(opening=(28.5 if audio else 24.5) + 1.1 * sin(2 * pi * 0.7 * t), act=8.0, bright=9.0 if audio else 6.5,
                       rot=(7.0 if audio else 3.0) * t % 60.0,
                       dx=1.5 * sin(2 * pi * 0.23 * t), dy=1.1 * sin(2 * pi * 0.17 * t + 1.0))
            limit = 0
            for key in ("answer", "auto"):
                value = tokens.get(key, "")
                if value.isdigit() and int(value) > 0:
                    limit = int(value)
            if limit:
                tgt["arc"] = max(0.0, 1.0 - t / limit) * 72.0
            extra["notches"] = 4 if audio else 1
        elif state == vs.TRANSCRIBE:
            tgt.update(opening=18.0, act=6.0, bright=6.0)
            extra["scan"] = int(round((0.5 - 0.5 * cos(2 * pi * t / 1.0)) * 32.0))
            extra["notches"] = 2
        elif state == vs.THINK:
            tgt.update(opening=9.0 + 5.0 * (0.5 - 0.5 * cos(2 * pi * t / 3.2)), act=5.0, bright=3.5, rot=(-14.0 * t) % 60.0)
            extra["orbit"] = int(round(((360.0 * (t / 2.4)) % 360.0) / 2.0)) * 2
        elif state == vs.IDLE and "heard" in tokens:
            tgt.update(opening=28.0, act=8.0, bright=9.0, rot=20.0)
            extra["notches"] = 4
        elif state == vs.IDLE:
            capri = "capri" in tokens
            bell = (math.sin(pi * glance) ** 2) if 0.0 < glance < 1.0 else 0.0
            tgt.update(opening=5.0 + 7.0 * bell, act=1.0 * bell, bright=(2.5 if capri else 1.0) + 2.5 * bell,
                       dx=3.2 * bell, dy=-1.0 * bell)
        elif state == vs.ERROR:
            tgt.update(opening=11.0, act=8.0, bright=6.0)
            extra["mark"] = "!"
            extra["jam"] = 14
        return tgt, extra

    # ---- movement
    def step(self, tgt, extra, now):
        if self.last is None:
            self.last = now
            self.pose.update(tgt)
            self.quiet = extra
            return
        dt = min(0.05, max(0.0, now - self.last))
        self.last = now
        pose = self.pose
        steps = max(1, int(math.ceil(dt / 0.008)))
        h = dt / steps
        for _ in range(steps):
            accel = self.SPRING_K * (tgt["opening"] - pose["opening"]) - self.SPRING_C * self.vel
            self.vel += accel * h
            pose["opening"] += self.vel * h
        pose["opening"] = max(0.0, pose["opening"])
        moved = abs(self.vel) > 4.0 or abs(tgt["opening"] - pose["opening"]) > 0.35
        for key, tau in self.TAU.items():
            k = 1.0 - math.exp(-dt / tau)
            if key == "rot":
                delta = _wrap60(tgt[key] - pose[key])
                if abs(delta) > 0.6:
                    moved = True
                pose[key] = (pose[key] + delta * k) % 60.0
            else:
                if abs(tgt[key] - pose[key]) > (0.05 if key in ("act", "bright") else 0.15):
                    moved = True
                pose[key] += (tgt[key] - pose[key]) * k
        pose["arc"] = tgt["arc"]
        self.quiet = extra
        if moved:
            self.moving_until = now + 0.12

    def settling(self, now):
        return now < self.moving_until

    def key(self):
        p, q = self.pose, self.quiet
        return (int(round(p["opening"] * 4)) / 4.0, int(round(p["rot"])) % 60, int(round(p["dx"] * 4)) / 4.0, int(round(p["dy"] * 4)) / 4.0,
                int(round(p["act"])), int(round(p["bright"])), int(round(p["arc"])) if p["arc"] >= 0 else -1,
                q["orbit"], q["scan"], q["notches"], q["mark"], q["jam"])

    def render(self, size=112):
        return hero(size, *self.key())


GLANCE_PERIOD = 13.0
GLANCE_LENGTH = 0.9


def idle_glance_phase(now):
    """0 < phase < 1 while the dormant optic glances aside (every 13 s, for 0.9 s); 0 otherwise."""
    cycle = now % GLANCE_PERIOD
    return cycle / GLANCE_LENGTH if cycle < GLANCE_LENGTH else 0.0


def next_glance_in(now):
    return GLANCE_PERIOD - (now % GLANCE_PERIOD) + 0.002
