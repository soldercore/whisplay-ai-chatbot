"""Mechanical GLaDOS eye: the small status icon of the response strip and of the microphone row.

Design (20 px): dark housing, a ring of eight mechanical segments, a green iris whose aperture and brightness follow
the state, a few iris blades that read as machinery only when the iris is open. Nothing here talks to hardware; frames
are drawn at 4x and reduced once, then cached by their quantised parameters, so a frame costs a dictionary lookup
after the first few seconds.

Speaking follows a level envelope that Node measured from the sentence's own Piper WAV (one hex digit per 20 ms) and
sent with the sentence-play event, which fires when playback of that sentence starts. The controller below reads the
envelope at the elapsed playback time; it never touches the microphone and never invents movement.
"""
import math

from PIL import Image, ImageDraw

from . import theme

K = 4                     # supersampling factor
SEGMENTS = 8
HOP_MS = 20               # envelope resolution sent by Node
LAG_S = 0.04              # player start-up + sound card buffer between "playback started" and sound
ATTACK_S = 0.03          # smoothing of the displayed level: fast rise, slower fall
RELEASE_S = 0.11
LEVELS = 8                # quantisation of the level (cache key)

HOUSING = (12, 20, 14)
APERTURE = (3, 7, 4)
BASE = (14, 50, 28)
WARM_WHITE = (205, 255, 220)

IDLE, LISTEN, THINK, SPEAK, ERROR = "idle", "listen", "think", "speak", "error"


def _mix(a, b, f):
    f = max(0.0, min(1.0, f))
    return tuple(int(round(a[i] + (b[i] - a[i]) * f)) for i in range(3))


def _seg(draw, c, r_out, width, center_deg, span_deg, color):
    box = (c - r_out, c - r_out, c + r_out, c + r_out)
    draw.arc(box, center_deg - span_deg / 2.0, center_deg + span_deg / 2.0, fill=color, width=int(width))


def _draw(state, level, phase, size):
    s = size * K
    c = s / 2.0
    accent = theme.RED if state == ERROR else theme.GREEN
    mid = theme.RED_DIM if state == ERROR else theme.GREEN_MID
    deep = (60, 16, 16) if state == ERROR else BASE
    img = Image.new("RGB", (s, s), theme.VOID)
    d = ImageDraw.Draw(img)
    r = c - 0.5 * K
    d.ellipse((c - r, c - r, c + r, c + r), fill=HOUSING, outline=_mix(deep, mid, 0.7), width=K)

    # --- aperture and iris
    if state == SPEAK:
        openness, bright = 0.36 + 0.58 * level, 0.5 + 0.5 * level
    elif state == LISTEN:
        openness, bright = 0.74, 0.92
    elif state == THINK:
        openness, bright = 0.40 + 0.08 * math.sin(phase * math.pi), 0.66
    elif state == ERROR:
        openness, bright = 0.52, 0.95
    else:
        openness, bright = 0.30 + 0.09 * level, 0.52 + 0.14 * level   # idle breathing: `level` carries the breath
    ri_max = 0.30 * s
    ri = ri_max * (0.30 + 0.70 * openness)
    ra = ri_max + 0.9 * K
    d.ellipse((c - ra, c - ra, c + ra, c + ra), fill=APERTURE)
    d.ellipse((c - ri, c - ri, c + ri, c + ri), fill=_mix(deep, mid, bright))
    r2 = ri * 0.62
    d.ellipse((c - r2, c - r2, c + r2, c + r2), fill=_mix(mid, accent, bright))
    r3 = max(0.55 * K, ri * 0.22)
    d.ellipse((c - r3, c - r3, c + r3, c + r3), fill=_mix(accent, WARM_WHITE, bright * 0.85))
    if ri / K >= 3.0:
        rot = math.radians(15 + (phase * 24 if state == THINK else 0))
        for i in range(3):
            a = rot + i * math.pi / 3
            dx, dy = math.cos(a) * ri, math.sin(a) * ri
            d.line((c - dx, c - dy, c + dx, c + dy), fill=APERTURE, width=max(1, int(0.45 * K)))
        d.ellipse((c - r3, c - r3, c + r3, c + r3), fill=_mix(accent, WARM_WHITE, bright * 0.85))

    # --- segment ring
    ring_out = 0.5 * s - 2.3 * K
    ring_w = 1.5 * K
    span = 31
    lit = [deep] * SEGMENTS
    if state == SPEAK:
        order = [[4], [3, 5], [2, 6], [1, 7], [0]]       # a vertical meter, bottom up, symmetrical
        count = int(round(level * len(order)))
        for group in order[:count]:
            for i in group:
                lit[i] = _mix(mid, accent, 0.4 + 0.6 * level)
    elif state == LISTEN:
        pulse = 0.5 + 0.5 * math.sin(phase * 2 * math.pi)
        for i in (2, 6):
            lit[i] = mid
        for i in (1, 3, 5, 7):
            lit[i] = _mix(deep, mid, 0.35 + 0.65 * pulse)
    elif state == ERROR:
        for i in range(SEGMENTS):
            lit[i] = _mix(deep, accent, 0.65)
    for i in range(SEGMENTS):
        _seg(d, c, ring_out, ring_w, -90 + 45 * i, span, lit[i])
    if state == THINK:
        head = phase * 360.0 - 90.0           # sweeps the ring; the tail fades behind it
        for k, f in enumerate((1.0, 0.6, 0.3)):
            _seg(d, c, ring_out, ring_w + (0.5 * K if k == 0 else 0), head - k * 38, 36, _mix(deep, accent, f))
    return img.reduce(K)


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
        pos = (now - self.start - LAG_S) / (HOP_MS / 1000.0)
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
        return self.error_since is not None and now - self.error_since < 6.1

    def sound_over(self, now):
        return self.start is None or now > self.start + max(self.duration, len(self.env) * HOP_MS / 1000.0) + LAG_S + 0.4

    # ---------------------------------------------------------------- frames
    def frame(self, state, now, fixed_level=None):
        """state: idle/listen/think/speak/error. Speaking uses the playback envelope unless `fixed_level` is given."""
        phase, lv = 0.0, 0.0
        if state != ERROR:
            self.error_since = None
        if state == SPEAK:
            raw = fixed_level if fixed_level is not None else self.level(now)
            q = int(round(max(0.0, min(1.0, raw)) * LEVELS))
            key, lv = (SPEAK, q, 0), q / LEVELS
        elif state == THINK:
            steps = 24
            b = int(now * 10) % steps                   # one turn in 2.4 s
            key, phase = (THINK, 0, b), b / steps
        elif state == LISTEN:
            b = int(now * 4) % 8                        # slow side-wave pulse, 2 s per cycle
            key, phase = (LISTEN, 0, b), b / 8.0
        elif state == ERROR:
            if self.error_since is None:
                self.error_since = now
            age = now - self.error_since
            # three short flashes, steady red for a few seconds, then back to idle (the outcome stays in the text)
            shown = IDLE if age > 6.0 else ERROR if (age > 0.9 or int(age * 6) % 2 == 0) else IDLE
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
