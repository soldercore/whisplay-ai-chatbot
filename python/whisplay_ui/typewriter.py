"""Typewriter reveal for streamed text (spec rules TW-2, TW-5, TW-6)."""
import bisect

from . import theme

STREAM = "stream"
ECHO = "echo"
INSTANT = "instant"


class Typewriter:
    def __init__(self):
        self.mode = INSTANT
        self.total = 0
        self.revealed = 0.0
        self.times = []           # reveal time per unit, non-decreasing
        self.last_growth = -1e9
        self.replaced_at = -1e9

    def reset(self, total, mode, now):
        self.mode = mode
        self.total = total
        self.revealed = 0.0 if mode in (STREAM, ECHO) else float(total)
        self.times = []
        self.last_growth = now
        self.replaced_at = now

    def grow(self, total, now):
        if total > self.total:
            self.last_growth = now
        self.set_total(total)

    def set_total(self, total):
        self.total = total
        if self.revealed > total:
            self.revealed = float(total)

    def shift(self, units):
        """Units dropped from the front when the 2200-char window slides."""
        if units <= 0:
            return
        self.revealed = max(0.0, self.revealed - units)
        del self.times[:units]

    def update(self, now, dt, limit):
        if self.mode == STREAM:
            backlog = limit - self.revealed
            if backlog > 0:
                rate = min(max(theme.TW_BASE_CPS, backlog / theme.TW_CATCHUP), theme.TW_MAX_CPS)
                self.revealed = min(float(limit), self.revealed + rate * dt)
        elif self.mode == ECHO:
            self.revealed = min(float(self.total), self.revealed + theme.ECHO_CPS * dt)
        else:
            self.revealed = float(self.total)
        shown = int(self.revealed)
        stamp = now if self.mode == STREAM else -1e9
        while len(self.times) < shown:
            self.times.append(stamp)
        if len(self.times) > shown:
            del self.times[shown:]

    @property
    def shown(self):
        return int(self.revealed)

    def busy(self):
        return self.mode != INSTANT and self.revealed < self.total - 1e-6

    def fresh_start(self, now):
        """First unit still inside the phosphor window."""
        return bisect.bisect_left(self.times, now - theme.PHOSPHOR)

    def cursor_state(self, now):
        if self.mode != STREAM:
            return "none"
        idle = now - self.last_growth
        if self.total - self.revealed > 0.5 or idle < theme.WRITING_WINDOW:
            return "writing"
        if idle < theme.WAITING_WINDOW:
            return "waiting"
        if idle < theme.WAITING_WINDOW + theme.DONE_OUTLINE:
            return "done"
        return "hidden"
