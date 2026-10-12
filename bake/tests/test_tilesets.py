"""The per-tile-set network artifact: a chain cut at the seams, covered exactly once.

PLAN-TILED-NETWORK Phase 1 writes `tilesets/<i>/roads.json` beside the global `spine_utm.json`.
These pin the two properties the later phases rest on: the union of the owned segments is the
chain (no drop, no duplicate, length preserved), and a seam is shared exactly (contiguous `s`,
one shared endpoint). Synthetic chains in a real frame — no OSM, no rasters.

    bake/.venv/bin/python -m unittest discover -s bake/tests
"""
from __future__ import annotations

import json
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from shapely.geometry import LineString  # noqa: E402

from piedmont_bake import network  # noqa: E402
from piedmont_bake.geo import Frame  # noqa: E402


def make_chain(cid: str, line: LineString, junctions=None) -> dict:
    return {
        "id": cid, "line": line, "ident": cid, "name": cid, "ref": None,
        "highway": "residential", "lanes": 2, "oneway": None,
        "length_m": round(float(line.length), 1), "junctions": junctions or [], "dead_ends": [],
    }


class BuildTest(unittest.TestCase):
    def setUp(self):
        self.frame = Frame.at(-76.62, 39.0)
        ox, oy = self.frame.origin
        self.ox, self.oy = ox, oy
        # 6 km across, cut by the 1 km grid into several seams
        self.crossing = make_chain("A", LineString([(ox - 3000, oy), (ox + 3000, oy)]))
        self.local = make_chain("B", LineString([(ox + 500, oy + 500), (ox + 900, oy + 900)]))
        self.chains = [self.crossing, self.local]
        self.bbox = (ox - 3500, oy - 3500, ox + 3500, oy + 3500)
        self.doc = network.build_tilesets(self.frame, self.chains, self.bbox, set_m=1000.0, primary_id="A")
        self.owned = [seg for ts in self.doc["tilesets"] for seg in ts["owned"]]

    def test_every_chain_is_covered_exactly_once(self):
        by_chain: dict[str, list[dict]] = {}
        for seg in self.owned:
            by_chain.setdefault(seg["chain"], []).append(seg)
        self.assertEqual(sorted(by_chain), ["A", "B"])
        for cid, segs in by_chain.items():
            chain = next(c for c in self.chains if c["id"] == cid)
            segs.sort(key=lambda s: s["s0"])
            self.assertAlmostEqual(segs[0]["s0"], 0.0)
            # s0/s1/length_m are rounded to 0.1 m in the artifact, hence the delta
            self.assertAlmostEqual(segs[-1]["s1"], float(chain["line"].length), delta=0.2)
            total = sum(s["length_m"] for s in segs)
            self.assertAlmostEqual(total, float(chain["line"].length), delta=0.5)

    def test_a_seam_is_shared_and_contiguous(self):
        segs = sorted([s for s in self.owned if s["chain"] == "A"], key=lambda s: s["s0"])
        self.assertGreater(len(segs), 1, "the 6 km chain must cross a seam")
        for a, b in zip(segs, segs[1:]):
            self.assertAlmostEqual(a["s1"], b["s0"], places=3)
            self.assertAlmostEqual(a["geometry"][-1][0], b["geometry"][0][0], places=6)
            self.assertAlmostEqual(a["geometry"][-1][1], b["geometry"][0][1], places=6)
        # an interior cut is flagged on both sides; the far ends are not cuts
        self.assertFalse(segs[0]["cut_start"])
        self.assertTrue(segs[0]["cut_end"])
        self.assertTrue(segs[-1]["cut_start"])
        self.assertFalse(segs[-1]["cut_end"])

    def test_geometry_is_wgs84_and_round_trips(self):
        seg = self.owned[0]
        lon, lat = seg["geometry"][0]
        x, y = self.frame.from_wgs(lon, lat)
        # the segment starts on the chain itself (its line, in ENU metres)
        chain = next(c for c in self.chains if c["id"] == seg["chain"])
        self.assertLess(chain["line"].distance(LineString([(x, y), (x, y)])), 0.05)

    def test_the_primary_is_marked(self):
        prim = [s for s in self.owned if s["chain"] == "A"]
        self.assertTrue(all(s["primary"] for s in prim))
        others = [s for s in self.owned if s["chain"] == "B"]
        self.assertTrue(all(not s["primary"] for s in others))

    def test_a_junction_lands_in_the_segment_that_contains_it(self):
        line = LineString([(self.ox - 3000, self.oy), (self.ox + 3000, self.oy)])
        js = [{"node": 1, "s": 1500.0}, {"node": 2, "s": 4500.0}]
        chain = make_chain("J", line, junctions=js)
        doc = network.build_tilesets(self.frame, [chain], self.bbox, set_m=1000.0)
        placed = {}
        for ts in doc["tilesets"]:
            for seg in ts["owned"]:
                for j in seg["junctions"]:
                    placed[j["node"]] = (seg["s0"], seg["s1"])
        self.assertEqual(sorted(placed), [1, 2])
        for node, (s0, s1) in placed.items():
            self.assertLessEqual(s0, 1500.0 if node == 1 else 4500.0)
            self.assertGreaterEqual(s1, 1500.0 if node == 1 else 4500.0)

    def test_context_is_a_neighbour_segment_inside_the_halo(self):
        # tile-set owning A's first piece sees A's next piece across the seam as context
        for ts in self.doc["tilesets"]:
            owned_ids = {(s["chain"], round(s["s0"], 1)) for s in ts["owned"]}
            for c in ts["context"]:
                self.assertNotIn((c["chain"], round(c["s0"], 1)), owned_ids, "context is not owned")
        total_context = sum(len(ts["context"]) for ts in self.doc["tilesets"])
        self.assertGreater(total_context, 0, "a 6 km chain must have a neighbour within the halo")

    def test_counts_are_consistent(self):
        counts = self.doc["counts"]
        self.assertEqual(counts["tilesets"], len(self.doc["tilesets"]))
        self.assertEqual(counts["owned"], len(self.owned))
        self.assertEqual(counts["context"], sum(len(ts["context"]) for ts in self.doc["tilesets"]))


class WriteTest(unittest.TestCase):
    def test_write_tilesets_writes_each_tileset_and_an_index(self):
        frame = Frame.at(-76.62, 39.0)
        ox, oy = frame.origin
        chains = [make_chain("A", LineString([(ox - 3000, oy), (ox + 3000, oy)]))]
        R = {"chains": chains, "primary": chains[0]}
        bbox = (ox - 3500, oy - 3500, ox + 3500, oy + 3500)
        with tempfile.TemporaryDirectory() as d:
            out = Path(d)
            counts = network.write_tilesets(out, frame, R, bbox, set_m=1000.0)
            index = json.loads((out / "tilesets" / "index.json").read_text())
            self.assertEqual(index["counts"], counts)
            self.assertEqual(len(index["tilesets"]), counts["tilesets"])
            for ts in index["tilesets"]:
                body = json.loads((out / "tilesets" / str(ts["index"]) / "roads.json").read_text())
                self.assertEqual(body["index"], ts["index"])
                self.assertEqual(len(body["owned"]), ts["owned"])
                self.assertEqual(body["frame"]["kind"], "enu")


if __name__ == "__main__":
    unittest.main()
