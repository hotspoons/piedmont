"""netsets: the tile-set grid and cutting a network at the seams.

These pin the geometry an area bake rests on: the grid aligns to tile boundaries, a line is cut at
every seam and the pieces tile it exactly (contiguous `s`, shared seam point), and a tile-set's
context is its neighbours' pieces inside the halo and nothing else. Synthetic lines only — no OSM,
no rasters.

    bake/.venv/bin/python -m unittest discover -s bake/tests
"""
from __future__ import annotations

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from shapely.geometry import LineString  # noqa: E402

from piedmont_bake import netsets  # noqa: E402


class GridTest(unittest.TestCase):
    def test_covers_the_bbox_and_aligns_to_set_multiples(self):
        sets = netsets.tilesets((1234.0, 5678.0, 9000.0, 9000.0), set_m=4000.0)
        for s in sets:
            for c in s["bbox"]:
                self.assertAlmostEqual(c % 4000.0, 0.0, places=6)
        # the union covers the bbox
        x0 = min(s["bbox"][0] for s in sets)
        y0 = min(s["bbox"][1] for s in sets)
        x1 = max(s["bbox"][2] for s in sets)
        y1 = max(s["bbox"][3] for s in sets)
        self.assertLessEqual(x0, 1234.0)
        self.assertLessEqual(y0, 5678.0)
        self.assertGreaterEqual(x1, 9000.0)
        self.assertGreaterEqual(y1, 9000.0)

    def test_sets_are_disjoint_and_indexed_from_zero(self):
        sets = netsets.tilesets((0.0, 0.0, 8000.0, 8000.0), set_m=4000.0)
        self.assertEqual([s["index"] for s in sets], list(range(4)))
        area = sum((s["bbox"][2] - s["bbox"][0]) * (s["bbox"][3] - s["bbox"][1]) for s in sets)
        self.assertAlmostEqual(area, 8000.0 * 8000.0, places=3)

    def test_small_bbox_is_one_set(self):
        self.assertEqual(len(netsets.tilesets((0.0, 0.0, 3000.0, 2000.0))), 1)

    def test_tile_set_at_picks_the_cell_and_falls_back_to_nearest(self):
        sets = netsets.tilesets((0.0, 0.0, 8000.0, 8000.0), set_m=4000.0)
        self.assertEqual(netsets.tile_set_at(sets, 1000.0, 1000.0), 0)
        self.assertEqual(netsets.tile_set_at(sets, 5000.0, 1000.0), 1)
        self.assertEqual(netsets.tile_set_at(sets, 5000.0, 5000.0), 3)
        # outside the grid: nearest wins
        self.assertEqual(netsets.tile_set_at(sets, -5000.0, -5000.0), 0)

    def test_halo_rect_grows_each_side(self):
        self.assertEqual(netsets.halo_rect([0.0, 0.0, 4000.0, 4000.0], 300.0),
                         [-300.0, -300.0, 4300.0, 4300.0])


class CutTest(unittest.TestCase):
    def setUp(self):
        self.sets = netsets.tilesets((0.0, 0.0, 8000.0, 8000.0), set_m=4000.0)

    def test_line_inside_one_set_is_untouched(self):
        line = LineString([(1000, 1000), (3000, 1000), (3000, 3000)])
        pieces = netsets.cut_line(line, self.sets)
        self.assertEqual(len(pieces), 1)
        self.assertEqual(pieces[0]["tileset"], 0)
        self.assertAlmostEqual(pieces[0]["s0"], 0.0)
        self.assertAlmostEqual(pieces[0]["s1"], float(line.length))

    def test_crossing_a_vertical_seam_is_two_pieces_that_share_the_seam_point(self):
        line = LineString([(1000, 2000), (7000, 2000)])
        pieces = netsets.cut_line(line, self.sets)
        self.assertEqual([p["tileset"] for p in pieces], [0, 1])
        self.assertAlmostEqual(pieces[0]["geom"].coords[-1][0], 4000.0)
        self.assertAlmostEqual(pieces[0]["geom"].coords[-1][1], 2000.0)
        self.assertAlmostEqual(pieces[0]["s1"], pieces[1]["s0"])
        self.assertAlmostEqual(pieces[1]["s1"], float(line.length))

    def test_diagonal_through_two_seams_tiles_the_line(self):
        line = LineString([(500, 500), (7500, 4500)])
        pieces = netsets.cut_line(line, self.sets)
        self.assertGreaterEqual(len(pieces), 3)
        self.assertAlmostEqual(pieces[0]["s0"], 0.0)
        self.assertAlmostEqual(pieces[-1]["s1"], float(line.length))
        total = 0.0
        for a, b in zip(pieces, pieces[1:]):
            self.assertAlmostEqual(a["s1"], b["s0"], places=6)  # contiguous
            self.assertAlmostEqual(a["geom"].coords[-1][0], b["geom"].coords[0][0], places=6)
            self.assertAlmostEqual(a["geom"].coords[-1][1], b["geom"].coords[0][1], places=6)
        for p in pieces:
            total += float(p["geom"].length)
        self.assertAlmostEqual(total, float(line.length), places=6)

    def test_cut_is_deterministic(self):
        line = LineString([(500, 500), (7500, 4500)])
        a = [(p["tileset"], p["s0"], p["s1"]) for p in netsets.cut_line(line, self.sets)]
        b = [(p["tileset"], p["s0"], p["s1"]) for p in netsets.cut_line(line, self.sets)]
        self.assertEqual(a, b)

    def test_empty_line_is_no_pieces(self):
        self.assertEqual(netsets.cut_line(LineString(), self.sets), [])


class AssignTest(unittest.TestCase):
    def setUp(self):
        self.sets = netsets.tilesets((0.0, 0.0, 8000.0, 8000.0), set_m=4000.0)
        self.chains = [
            {"id": "A", "line": LineString([(1000, 2000), (7000, 2000)])},
            {"id": "B", "line": LineString([(7500, 6000), (7600, 6000)])},
        ]

    def test_every_piece_is_owned_exactly_once(self):
        owned = netsets.cut_chains(self.chains, self.sets)
        pieces = [p for v in owned.values() for p in v]
        self.assertEqual(len(pieces), 3)  # A splits at x=4000, B whole
        ids = sorted((p["chain"], round(p["s0"], 3)) for p in pieces)
        self.assertEqual(ids, [("A", 0.0), ("A", 3000.0), ("B", 0.0)])

    def test_context_is_the_neighbour_piece_at_the_seam_only(self):
        assigned = netsets.assign(self.chains, self.sets, halo_m=300.0)
        # tile-set 0 owns A's left piece and sees A's right piece across the seam
        self.assertEqual({p["chain"] for p in assigned[0]["owned"]}, {"A"})
        self.assertEqual({p["chain"] for p in assigned[0]["context"]}, {"A"})
        # tile-set 3 owns B and does not reach A (1700 m away) or its own origin
        self.assertEqual({p["chain"] for p in assigned[3]["owned"]}, {"B"})
        self.assertEqual(assigned[3]["context"], [])

    def test_a_tiny_halo_drops_the_neighbour_segment(self):
        # a chain in another tile-set beyond the halo is not context for this one
        chains_only_far = [{"id": "C", "line": LineString([(7500, 6000), (7600, 6000)])}]
        far = netsets.assign(chains_only_far, self.sets, halo_m=0.01)
        self.assertEqual(far[0]["owned"], [])
        self.assertEqual(far[0]["context"], [])


if __name__ == "__main__":
    unittest.main()
