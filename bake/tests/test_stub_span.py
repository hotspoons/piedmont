"""The stub-span rule: a road that ENDS at ours is not stubbed across the junction.

Rich's "crofton-triangle on both sides of highway" is a way ending on one carriageway that the bake
then drew 60 m on the far side of — which, across a divided highway, is the other carriageway.
"""
import unittest

from piedmont_bake.export import _hold_grade, _stub_span

STUB = 60.0


class StubSpan(unittest.TestCase):
    def test_a_through_way_is_stubbed_either_side(self):
        self.assertEqual(_stub_span(200.0, 500.0, STUB), (140.0, 260.0))

    def test_a_way_ending_at_ours_is_drawn_only_its_own_side(self):
        # meet near the start: draw from the start up to the junction plus one stub
        self.assertEqual(_stub_span(10.0, 500.0, STUB), (0.0, 70.0))
        # meet near the end: draw from the junction minus one stub to the end
        self.assertEqual(_stub_span(490.0, 500.0, STUB), (430.0, 500.0))

    def test_a_way_shorter_than_the_stub_is_drawn_whole(self):
        self.assertEqual(_stub_span(10.0, 40.0, STUB), (0.0, 40.0))
        self.assertEqual(_stub_span(0.0, 5.0, STUB), (0.0, 5.0))

    def test_a_through_way_near_the_end_still_reaches_the_end(self):
        lo, hi = _stub_span(80.0, 120.0, STUB)
        self.assertEqual((lo, hi), (20.0, 120.0))


class HoldGrade(unittest.TestCase):
    """A stub crossing one of ours on a bridge rides its deck, not the ditch under it.

    Ernstville Road over i70 (2026-10-12): the bare-earth DEM under the deck is ~6.7 m lower, so the
    stub was drawn diving into the ditch the bridge spans.
    """

    def test_a_bridge_dip_is_bridged_to_the_grade(self):
        zs = [143.0] * 8 + [136.0] * 7 + [141.0] * 8
        out = _hold_grade(zs, 4.0)
        self.assertGreater(float(min(out[8:15])), 139.0)  # no dive into the 136 m hole
        self.assertEqual(out[0], 143.0)  # the approaches keep their own height
        self.assertEqual(out[-1], 141.0)

    def test_a_monotonic_descent_is_not_a_dip(self):
        zs = [100.0 - 0.4 * i for i in range(30)]
        self.assertEqual(list(_hold_grade(zs, 4.0)), zs)

    def test_a_dip_at_the_stub_own_end_has_no_grade_to_hold_to(self):
        zs = [100.0] * 25 + [80.0]
        out = _hold_grade(zs, 4.0)
        self.assertEqual(out[-1], 80.0)

    def test_a_flat_stub_is_untouched(self):
        zs = [120.0] * 20
        self.assertEqual(list(_hold_grade(zs, 4.0)), zs)


if __name__ == "__main__":
    unittest.main()
