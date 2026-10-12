"""routes: a route site resolves several long `refs` bounded by a `clip` to one network world.

The geometry here is pure — the Overpass fetch is the only part that needs a network — so the
selector itself is tested without one.

    bake/.venv/bin/python -m unittest discover -s tests
"""
from __future__ import annotations

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from shapely.geometry import LineString, Polygon  # noqa: E402

from piedmont_bake import routes  # noqa: E402
from piedmont_bake.geo import Frame  # noqa: E402


def seg(x0, y0, x1, y1):  # noqa: D103
    return LineString([(x0, y0), (x1, y1)])


class LongestLineTest(unittest.TestCase):
    def test_picks_the_longest_run_of_a_geometry(self):
        from shapely.geometry import MultiLineString

        g = MultiLineString([[(0, 0), (10, 0)], [(0, 0), (30, 0)]])
        self.assertEqual(routes.longest_line(g).length, 30)

    def test_none_for_a_point_or_empty(self):
        from shapely.geometry import Point

        self.assertIsNone(routes.longest_line(Point(0, 0)))
        self.assertIsNone(routes.longest_line(None))
        self.assertIsNone(routes.longest_line(LineString()))


class ClipTest(unittest.TestCase):
    def test_clip_keeps_the_part_inside(self):
        poly = Polygon([(0, 0), (10, 0), (10, 10), (0, 10)])
        out = routes.clip_line(seg(-5, 5, 15, 5), poly)
        self.assertAlmostEqual(out.length, 10)

    def test_clip_is_none_when_the_line_never_reaches_in(self):
        poly = Polygon([(0, 0), (10, 0), (10, 10), (0, 10)])
        self.assertIsNone(routes.clip_line(seg(20, 20, 30, 30), poly))

    def test_no_polygon_passes_the_line_through(self):
        self.assertEqual(routes.clip_line(seg(0, 0, 3, 0), None).length, 3)


class JoinTest(unittest.TestCase):
    def test_joins_in_order_and_connects_the_near_ends(self):
        # US-15's line is stored west-to-east; the join flips it so its near end meets I-70's end
        lines = {"I 70": seg(0, 0, 100, 0), "US 15": seg(140, 0, 100, 0)}
        out = routes.join_refs(["I 70", "US 15"], lines)
        self.assertEqual(len(out.coords), 3)
        self.assertEqual(out.coords[0], (0, 0))
        self.assertEqual(out.coords[-1], (140, 0))

    def test_a_missing_ref_is_skipped(self):
        out = routes.join_refs(["I 70", "US 15"], {"I 70": seg(0, 0, 10, 0)})
        self.assertEqual(out.length, 10)

    def test_no_lines_is_none(self):
        self.assertIsNone(routes.join_refs(["I 70"], {}))


class BoundaryTest(unittest.TestCase):
    def test_buffer_unions_the_lines_into_one_polygon(self):
        from shapely.geometry import Point

        b = routes.boundary_of([seg(0, 0, 100, 0), seg(100, 0, 100, 100)], 10)
        self.assertEqual(b.geom_type, "Polygon")
        self.assertTrue(b.contains(Point(50, 0)))     # on the first line
        self.assertTrue(b.contains(Point(100, 50)))   # on the second

    def test_no_lines_is_none(self):
        self.assertIsNone(routes.boundary_of([], 10))


class TrimTest(unittest.TestCase):
    """`trim_line` cuts a ref's chain to the stretch between two clicked WGS84 anchors.

    The anchors arrive as points (what the editor stored) and are projected onto the bake's own
    chain, which is the whole point: the bake's chain need not be the one on screen.
    """

    def setUp(self):
        self.frame = Frame.at(-77.52, 39.47)
        self.line = seg(0, 0, 1000, 0)

    def _wgs(self, x, y):
        lon, lat = self.frame.to_wgs([x], [y])
        return [float(lon[0]), float(lat[0])]

    def test_keeps_only_the_stretch_between_the_anchors(self):
        cut = [self._wgs(250, 0), self._wgs(750, 0)]
        out = routes.trim_line(self.line, cut, self.frame)
        self.assertAlmostEqual(out.length, 500, delta=2)
        self.assertAlmostEqual(out.coords[0][0], 250, delta=2)

    def test_order_does_not_matter(self):
        cut = [self._wgs(750, 0), self._wgs(250, 0)]
        out = routes.trim_line(self.line, cut, self.frame)
        self.assertAlmostEqual(out.length, 500, delta=2)

    def test_anchors_project_onto_the_line(self):
        # both anchors sit well off the line; the projection is what makes the cut land on it
        cut = [self._wgs(250, 900), self._wgs(750, -900)]
        out = routes.trim_line(self.line, cut, self.frame)
        self.assertAlmostEqual(out.length, 500, delta=3)

    def test_no_cut_leaves_the_whole_line(self):
        self.assertEqual(routes.trim_line(self.line, None, self.frame).length, 1000)
        self.assertEqual(routes.trim_line(self.line, [], self.frame).length, 1000)

    def test_a_sliver_cut_leaves_the_whole_line(self):
        cut = [self._wgs(500, 0), self._wgs(500.1, 0)]
        self.assertEqual(routes.trim_line(self.line, cut, self.frame).length, 1000)

    def test_unreadable_cut_leaves_the_whole_line(self):
        self.assertEqual(routes.trim_line(self.line, ["nope", "also-nope"], self.frame).length, 1000)


class MatchTest(unittest.TestCase):
    """A ref a route names is matched on the OSM `ref` OR the road's `name`.

    The editor labels a road `name || ref` (services/worldeditor/layers.mjs), so a route picked on
    the map carries a NAME ("Robert Crain Highway"); a hand-written site names the `ref` ("US 301").
    `way_keys` reads both off a way, and the Overpass query filters on either tag.
    """

    def test_each_split_ref_is_a_key(self):
        wy = {"tags": {"ref": "I 70;US 40", "name": "Baltimore National Pike"}}
        self.assertEqual(
            routes.way_keys(wy),
            {"I 70", "US 40", "Baltimore National Pike"},
        )

    def test_a_name_only_way_is_matched_by_its_name(self):
        self.assertEqual(routes.way_keys({"tags": {"name": "Robert Crain Highway"}}), {"Robert Crain Highway"})

    def test_a_way_with_neither_is_matched_by_nothing(self):
        self.assertEqual(routes.way_keys({"tags": {}}), set())
        self.assertEqual(routes.way_keys({}), set())

    def test_blank_pieces_are_dropped(self):
        self.assertEqual(routes.way_keys({"tags": {"ref": "I 70 ; ;US 40", "name": "  "}}), {"I 70", "US 40"})

    def test_esc_regex_metacharacters(self):
        # a name with a dot or a bracket must not turn into a regex wildcard in the query
        self.assertEqual(routes._esc("St. John's Rd (Old)"), "St\\. John's Rd \\(Old\\)")
        self.assertEqual(routes._esc("US 301 [Business]"), "US 301 \\[Business\\]")
        self.assertEqual(routes._esc("I 70|US 40"), "I 70\\|US 40")


class ResolveSiteTest(unittest.TestCase):
    def test_to_wgs_ring_round_trips_through_the_frame(self):
        frame = Frame.at(-77.52, 39.47)
        x, y = frame.from_wgs(-77.5, 39.5)
        poly = Polygon([(x - 100, y - 100), (x + 100, y - 100), (x + 100, y + 100), (x - 100, y + 100)])
        ring = routes.to_wgs_ring(poly, frame)
        lons = [p[0] for p in ring]
        lats = [p[1] for p in ring]
        self.assertTrue(all(-77.6 < lo < -77.4 for lo in lons))
        self.assertTrue(all(39.4 < la < 39.6 for la in lats))

    def test_clip_polygon_reads_a_wgs84_ring(self):
        frame = Frame.at(-77.52, 39.47)
        site = {"slug": "r", "clip": [[-77.6, 39.4], [-77.4, 39.4], [-77.4, 39.6], [-77.6, 39.6]]}
        poly = routes.clip_polygon(site, frame)
        self.assertIsNotNone(poly)
        self.assertEqual(poly.geom_type, "Polygon")

    def test_clip_polygon_is_none_for_too_few_points(self):
        frame = Frame.at(-77.52, 39.47)
        self.assertIsNone(routes.clip_polygon({"clip": [[-77.6, 39.4], [-77.4, 39.4]]}, frame))


if __name__ == "__main__":
    unittest.main()
