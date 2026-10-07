"""Injectable clock. Production uses time.monotonic(); the preview harness
switches to a manual clock so every frame is reproducible."""
import time

_manual_now = None
_manual_wall = 14 * 3600 + 32 * 60 + 7  # 14:32:07, seconds since midnight


def now():
    return time.monotonic() if _manual_now is None else _manual_now


def is_manual():
    return _manual_now is not None


def use_manual(start=0.0, wall_seconds=None):
    global _manual_now, _manual_wall
    _manual_now = float(start)
    if wall_seconds is not None:
        _manual_wall = int(wall_seconds)


def set_time(t):
    global _manual_now
    _manual_now = float(t)


def use_real():
    global _manual_now
    _manual_now = None


def wall_hms():
    """Wall-clock (hour, minute, second)."""
    if _manual_now is None:
        lt = time.localtime()
        return lt.tm_hour, lt.tm_min, lt.tm_sec
    s = int(_manual_wall + _manual_now)
    return (s // 3600) % 24, (s // 60) % 60, s % 60


def seconds_to_next_minute():
    if _manual_now is None:
        return 60.0 - (time.time() % 60.0)
    return 60.0 - ((_manual_wall + _manual_now) % 60.0)
