"""The optic's motion: continuity, settling, frame-rate independence and bounded caches. No display, no hardware."""
import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
from whisplay_ui import optic, visual_state as vs  # noqa: E402


def run(motion, state, tokens, seconds, fps, t0=0.0, now0=0.0):
    """Advance the motion for `seconds` at `fps`; returns the opening after each step."""
    out, steps = [], int(seconds * fps)
    for i in range(1, steps + 1):
        now = now0 + i / fps
        target, extra = motion.target(state, tokens, t0 + i / fps)
        motion.step(target, extra, now)
        out.append(motion.pose["opening"])
    return out


class OpticMotion(unittest.TestCase):
    def fresh(self):
        m = optic.Motion()
        t, e = m.target(vs.IDLE, {"capri": ""}, 0.0)
        m.step(t, e, 0.0)
        return m

    def test_wake_snaps_open_with_a_small_overshoot_and_settles(self):
        m = self.fresh()
        trace = run(m, vs.IDLE, {"capri": "", "heard": ""}, 1.0, 60)
        target = 28.0
        self.assertGreater(max(trace), target, "an underdamped snap overshoots")
        self.assertLess(max(trace), target * 1.15, "but only a little")
        self.assertGreater(trace[int(0.15 * 60)], 0.8 * target, "most of the way open within 150 ms")
        self.assertAlmostEqual(trace[-1], target, delta=0.5)

    def test_no_jump_between_consecutive_frames(self):
        m = self.fresh()
        trace = [m.pose["opening"]] + run(m, vs.IDLE, {"heard": ""}, 0.6, 20)
        self.assertLess(max(abs(b - a) for a, b in zip(trace, trace[1:])), 12.0, "at 20 fps the shutter never jumps")

    def test_motion_is_independent_of_the_frame_rate(self):
        a, b = self.fresh(), self.fresh()
        slow = run(a, vs.LISTEN, {"capri": ""}, 1.0, 15)[-1]
        fast = run(b, vs.LISTEN, {"capri": ""}, 1.0, 120)[-1]
        self.assertAlmostEqual(slow, fast, delta=1.0)

    def test_steady_animation_is_not_a_transition(self):
        m = self.fresh()
        run(m, vs.THINK, {}, 2.0, 20)
        flags = []
        for i in range(1, 61):
            now = 2.0 + i / 20.0
            t, e = m.target(vs.THINK, {}, now)
            m.step(t, e, now)
            flags.append(m.settling(now))
        self.assertFalse(any(flags), "orbit and iris pulse run at the steady rate, not at the transition rate")

    def test_idle_pose_is_a_fixed_point_between_glances(self):
        m = self.fresh()
        keys = set()
        for i in range(1, 100):
            now = 2.0 + i * 0.05
            t, e = m.target(vs.IDLE, {"capri": ""}, now, glance=0.0)
            m.step(t, e, now)
            keys.add(m.key())
        self.assertEqual(len(keys), 1, "a dormant optic renders one frame, then nothing")

    def test_glance_is_brief_and_rare(self):
        phases = [optic.idle_glance_phase(n / 10.0) for n in range(0, 260)]
        active = [p for p in phases if p > 0]
        self.assertLess(len(active) / len(phases), 0.08, "under a second out of every 13")
        self.assertGreater(optic.next_glance_in(5.0), 7.0)

    def test_caches_are_bounded(self):
        self.assertLessEqual(optic.hero.cache_info().maxsize, 96)
        self.assertLessEqual(optic.mini.cache_info().maxsize, 64)

    def test_hero_renders_the_requested_size_on_true_black(self):
        image = optic.hero(112, 20.0, 0, 0.0, 0.0, 8, 8, -1, -1, -1, 4, "", 0)
        self.assertEqual(image.size, (112, 112))
        self.assertEqual(image.getpixel((0, 0)), (0, 0, 0))


if __name__ == "__main__":
    unittest.main()
