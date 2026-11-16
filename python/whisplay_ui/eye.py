"""Mechanical GLaDOS eye: the small status icon of the response strip and of the microphone row.

Design (20 px): dark housing, a ring of eight mechanical segments, a green iris whose aperture and brightness follow
the state, a few iris blades that read as machinery only when the iris is open. Nothing here talks to hardware; frames
are drawn pixel by pixel at their real size (hard edges, no blur) and cached by their quantised parameters, so a frame costs a dictionary lookup
after the first few seconds.

Speaking follows a level envelope that Node measured from the sentence's own Piper WAV (one hex digit per 20 ms) and
sent with the sentence-play event, which fires when playback of that sentence starts. The controller below reads the
envelope at the elapsed playback time; it never touches the microphone and never invents movement.
"""
import math

from PIL import Image, ImageDraw

from . import theme

SEGMENTS = 8
HOP_MS = 20               # envelope resolution sent by Node
SEGMENTS = 8
LAG_S = 0.04              # assumed player start-up + sound card delay between "playback started" and sound (calibrate on the device)
LEAD_S = 0.03             # the envelope is known in advance: read this far ahead to cancel the smoothing delay
ATTACK_S = 0.025          # smoothing of the displayed level: fast rise, slower fall
RELEASE_S = 0.09
LEVELS = 10               # quantisation of the level (cache key)
ERROR_SHOWN_S = 6.0

HOUSING = (10, 18, 12)
APERTURE = (2, 6, 3)
WARM_WHITE = (214, 255, 226)

IDLE, LISTEN, THINK, SPEAK, ERROR, UNSURE = "idle", "listen", "think", "speak", "error", "unsure"

# bright / mid / dim / deep tones per accent. Hard edges, no glow: the icon is drawn at its real size.
GREEN_SET = (theme.GREEN, theme.GREEN_MID, (24, 96, 50), (12, 46, 26))
RED_SET = (theme.RED, (206, 62, 58), (116, 36, 36), (62, 20, 20))
AMBER_SET = (theme.AMBER, theme.AMBER_MID, (112, 78, 20), (58, 40, 12))


def _mix(a, b, f):
    f = max(0.0, min(1.0, f))
    return tuple(int(round(a[i] + (b[i] - a[i]) * f)) for i in range(3))


def _ring(img, c, radius, center_deg, half_span, color):
    """One mechanical segment: pixels along a circle (1 px thick), exactly where they land at the real size."""
    step = 2.0
    deg = center_deg - half_span
    while deg <= center_deg + half_span:
        x = int(round(c + radius * math.cos(math.radians(deg))))
        y = int(round(c + radius * math.sin(math.radians(deg))))
        img.putpixel((x, y), color)
        deg += step


def _disc(d, c, r, color):
    d.ellipse((c - r, c - r, c + r, c + r), fill=color)


def _draw(state, level, phase, size):
    n = size
    c = (n - 1) / 2.0
    bright, mid, dim, deep = RED_SET if state == ERROR else AMBER_SET if state == UNSURE else GREEN_SET
    img = Image.new("RGB", (n, n), theme.VOID)
    d = ImageDraw.Draw(img)
    d.ellipse((0, 0, n - 1, n - 1), fill=HOUSING, outline=_mix(dim, mid, 0.55))

    # ---- iris: aperture (dark well), three tones, blades, hot centre
    if state == SPEAK:
        openness, glow = 0.12 + 0.88 * level, 0.35 + 0.65 * level
    elif state == LISTEN:
        openness, glow = 0.78, 0.9
    elif state == THINK:
        openness, glow = 0.42 + 0.06 * math.sin(phase * 2 * math.pi), 0.7
    elif state == ERROR:
        openness, glow = 0.55, 1.0
    elif state == UNSURE:
        openness, glow = 0.45, 0.75
    else:
        openness, glow = 0.22 + 0.16 * level, 0.5 + 0.2 * level      # idle: `level` carries the breath
    _disc(d, c, 5.6, APERTURE)
    ri = 1.4 + 4.0 * openness
    _disc(d, c, ri, _mix(deep, mid, glow))
    if ri >= 2.6:
        _disc(d, c, ri * 0.70, _mix(mid, bright, glow))
    if ri >= 4.4:
        rot = math.radians(15 + (phase * 90 if state == THINK else 0))
        for i in range(3):
            a = rot + i * math.pi / 3
            dx, dy = math.cos(a) * (ri - 0.2), math.sin(a) * (ri - 0.2)
            d.line((c - dx, c - dy, c + dx, c + dy), fill=_mix(APERTURE, deep, 0.5))
    _disc(d, c, max(0.6, ri * 0.30), _mix(bright, WARM_WHITE, glow * 0.8))

    # ---- segment ring (eight segments, clear gaps)
    ring = 7.4
    lit = [deep] * SEGMENTS
    if state == SPEAK:
        order = [[4], [3, 5], [2, 6], [1, 7], [0]]                  # a vertical meter, bottom up, symmetrical
        count = int(round(level * len(order)))
        for group in order[:count]:
            for i in group:
                lit[i] = bright
        for group in order[count:]:
            for i in group:
                lit[i] = dim
    elif state == LISTEN:
        pulse = 0.5 + 0.5 * math.sin(phase * 2 * math.pi)
        for i in (2, 6):
            lit[i] = mid
        for i in (1, 3, 5, 7):
            lit[i] = _mix(dim, bright, pulse)
    elif state == ERROR:
        lit = [bright if i % 2 == 0 else mid for i in range(SEGMENTS)]
    elif state == UNSURE:
        for i in (1, 3, 5, 7):
            lit[i] = mid
        for i in (0, 2, 4, 6):
            lit[i] = dim
    elif state == IDLE:
        lit = [dim if i % 2 == 0 else deep for i in range(SEGMENTS)]
    else:
        lit = [dim] * SEGMENTS
    for i in range(SEGMENTS):
        _ring(img, c, ring, -90 + 45 * i, 14, lit[i])
    if state == THINK:
        head = phase * 360.0 - 90.0                                   # a bright run sweeps the ring, tail fades
        for k, (span, color) in enumerate(((16, bright), (16, mid), (16, dim))):
            _ring(img, c, ring, head - k * 30, span / 2.0, color)
    return img


class Eye:
    """Frame source with a cache. `frame(state, level, now)` returns (RGB image, cache key)."""

    def __init__(self, size=20, idle_fps=2):
        self.size = int(size)
        self.idle_fps = max(0, int(idle_fps))
        self.cache = {}
        self.rendered = 0
        # speech envelope (set by `speech`)
        self.env = ""
        self.duration = 0.0
        self.has_env = False
        self.start = None
        self.level_now = 0.0
        self.last_t = None
        self.error_since = None

    # ---------------------------------------------------------------- speech envelope
    def speech(self, env, duration_ms, now):
        """A sentence's playback started at `now`. `env` is a hex string (one digit per 20 ms) or empty."""
        self.env = env if isinstance(env, str) else ""
        self.duration = max(0.0, float(duration_ms or 0)) / 1000.0
        self.start = now
        self.has_env = bool(self.env)

    def clear(self):
        self.env, self.start, self.has_env = "", None, False
        self.level_now, self.last_t = 0.0, None

    def target(self, now):
        """Level (0..1) in the audio being played right now, interpolated between 20 ms steps; 0 outside the sentence."""
        if self.start is None or not self.env:
            return 0.0
        pos = (now - self.start - LAG_S + LEAD_S) / (HOP_MS / 1000.0)
        if pos < 0 or pos > len(self.env):
            return 0.0
        i = int(pos)
        frac = pos - i

        def at(k):
            if k < 0 or k >= len(self.env):
                return 0
            try:
                return int(self.env[k], 16) / 15.0
            except ValueError:
                return 0
        return at(i) * (1 - frac) + at(i + 1) * frac

    def level(self, now):
        """Smoothed speaking level at `now` (fast attack, slower release)."""
        goal = self.target(now)
        if self.last_t is None:
            self.level_now = goal
        else:
            dt = max(0.0, min(0.25, now - self.last_t))
            tau = ATTACK_S if goal > self.level_now else RELEASE_S
            self.level_now += (goal - self.level_now) * (1.0 - math.exp(-dt / tau))
        self.last_t = now
        return self.level_now

    def error_active(self, now):
        """The red eye is still flashing or steady (it returns to idle after 6 s); needs frames until then."""
        return self.error_since is not None and now - self.error_since < ERROR_SHOWN_S + 0.1

    def sound_over(self, now):
        return self.start is None or now > self.start + max(self.duration, len(self.env) * HOP_MS / 1000.0) + LAG_S + 0.4

    # ---------------------------------------------------------------- frames
    def frame(self, state, now, fixed_level=None):
        """state: idle/listen/think/speak/error. Speaking uses the playback envelope unless `fixed_level` is given."""
        phase, lv = 0.0, 0.0
        if state not in (ERROR, UNSURE):
            self.error_since = None
        if state == SPEAK:
            raw = fixed_level if fixed_level is not None else self.level(now)
            q = int(round(max(0.0, min(1.0, raw)) * LEVELS))
            key, lv = (SPEAK, q, 0), q / LEVELS
        elif state == THINK:
            steps = 16
            b = int(now * 8) % steps                    # one turn in 2 s
            key, phase = (THINK, 0, b), b / steps
        elif state == LISTEN:
            b = int(now * 4) % 8                        # slow side-wave pulse, 2 s per cycle
            key, phase = (LISTEN, 0, b), b / 8.0
        elif state == UNSURE:
            # an unconfirmed outcome: steady amber for a few seconds, no flashing (never shown as a confirmed failure)
            if self.error_since is None:
                self.error_since = now
            shown = IDLE if now - self.error_since > ERROR_SHOWN_S else UNSURE
            key, state = (shown, 0, 0), shown
            if shown == IDLE:
                key, lv = (IDLE, 0, 0), 0.0
        elif state == ERROR:
            if self.error_since is None:
                self.error_since = now
            age = now - self.error_since
            # three short flashes, steady red for a few seconds, then back to idle (the outcome stays in the text)
            shown = IDLE if age > ERROR_SHOWN_S else ERROR if (age > 0.9 or int(age * 6) % 2 == 0) else IDLE
            key, state = (shown, 0, 0), shown
        else:
            breath = 0.5 + 0.5 * math.sin(now * 2 * math.pi / 6.0)
            q = int(breath * 5.999)
            key, lv, state = (IDLE, q, 0), q / 5.0, IDLE
        img = self.cache.get(key)
        if img is None:
            img = _draw(state, lv, phase, self.size)
            self.cache[key] = img
            self.rendered += 1
        return img, key
