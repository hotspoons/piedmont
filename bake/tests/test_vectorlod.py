"""vectorlod: which features survive in a coarse tile, and how they are reduced.

The LOD policy lifted from trailworks (`pipeline/bake/tiles.py`): per-layer class gates, dissolve by
identity, a minimum feature length, name-only, and simplify scaled to the tile. Synthetic lines only.

    bake/.venv/bin/python -m unittest discover -s bake/tests
"""
from __future__ import annotations

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from shapely.geometry import LineString  # noqa: E402

from piedmont_bake import vectorlod as vl  # noqa: E402


def feat(**kw):
    """A normalized feature: a class/kind field, a name/ref, and a shapely line."""
    f = {"id": kw.get("id") or kw.get("name") or kw.get("ref"),
         "name": kw.get("name"), "ref": kw.get("ref"),
         "line": kw.get("line") or LineString([(0, 0), (100, 0)])}
    f[kw.get("field", "highway")] = kw.get("kind")
    return f


def road(kind, name=None, ref=None, line=None, rid=None):
    return feat(field="highway", kind=kind, name=name, ref=ref, line=line, rid=rid)


def line_feat(field, kind, name=None, ref=None, length=100.0, rid=None):
    return feat(field=field, kind=kind, name=name, ref=ref, rid=rid,
                line=LineString([(0, 0), (length, 0)]))


class PolicyTest(unittest.TestCase):
    def test_fine_levels_keep_every_class(self):
        self.assertIsNone(vl.classes_for("roads", 14))
        self.assertIsNone(vl.classes_for("roads", 12))
        self.assertEqual(vl.min_len_for("roads", 14), 0.0)

    def test_road_classes_narrow_with_the_tile(self):
        self.assertEqual(vl.classes_for("roads", 11), {"motorway", "trunk", "primary", "secondary"})
        self.assertEqual(vl.classes_for("roads", 10), {"motorway", "trunk", "primary"})
        self.assertEqual(vl.classes_for("roads", 9), {"motorway", "trunk"})
        self.assertEqual(vl.classes_for("roads", 8), {"motorway"})
        self.assertEqual(vl.classes_for("roads", 6), {"motorway"})  # coarsest rule holds below

    def test_trails_and_streams_are_never_class_gated(self):
        for layer in ("trails", "rail", "streams"):
            self.assertIsNone(vl.classes_for(layer, 8))
            self.assertIsNone(vl.classes_for(layer, 10))

    def test_min_length_grows_with_the_tile(self):
        self.assertEqual(vl.min_len_for("roads", 11), 750.0)
        self.assertEqual(vl.min_len_for("roads", 10), 2000.0)
        self.assertEqual(vl.min_len_for("roads", 8), 12000.0)
        self.assertEqual(vl.min_len_for("streams", 8), 30000.0)

    def test_simplify_scales_with_the_tile(self):
        self.assertEqual(vl.simplify_for(1000.0), 1000.0 / 512.0)
        self.assertEqual(vl.simplify_for(80000.0), 80000.0 / 512.0)
        self.assertEqual(vl.simplify_for(10.0), 1.0)  # floored at a metre

    def test_keep_needs_a_name_once_classes_are_gated(self):
        self.assertTrue(vl.keep("roads", road("residential", name="Oak Ct"), 14))
        self.assertFalse(vl.keep("roads", road("residential", name="Oak Ct"), 10))
        self.assertFalse(vl.keep("roads", road("primary"), 10))  # right class, no name/ref
        self.assertTrue(vl.keep("roads", road("primary", ref="MD 450"), 10))

    def test_layers_are_the_distance_set(self):
        self.assertEqual(set(vl.LAYERS), {"streams", "trails", "rail", "roads"})


class CoarseRoadsTest(unittest.TestCase):
    def test_leaf_is_untouched_apart_from_simplify(self):
        feats = [road("residential", name="Oak Ct"), road("motorway", ref="I 95")]
        out = vl.coarse_roads(feats, level=14, edge_m=1000.0)
        self.assertEqual(len(out), 2)
        self.assertEqual({f["highway"] for f in out}, {"residential", "motorway"})

    def test_coarse_drops_classes_and_unnamed(self):
        feats = [
            road("motorway", ref="I 95", line=LineString([(0, 0), (30000, 0)])),
            road("primary", ref="MD 450", line=LineString([(0, 0), (30000, 0)])),
            road("residential", name="Oak Ct", line=LineString([(0, 0), (30000, 0)])),
            road("primary", line=LineString([(0, 0), (30000, 0)])),  # no name/ref
        ]
        out = vl.coarse_roads(feats, level=10, edge_m=20000.0)
        self.assertEqual(len(out), 2)
        self.assertEqual({f["ref"] for f in out}, {"I 95", "MD 450"})

    def test_dissolve_merges_fragments_before_the_length_gate(self):
        # two 3 km trunk fragments that share an endpoint: neither alone clears z9's 5 km, together
        # they do — the case trailworks dissolves for.
        feats = [
            road("trunk", ref="US 50", line=LineString([(0, 0), (3000, 0)]), rid="a"),
            road("trunk", ref="US 50", line=LineString([(3000, 0), (6000, 0)]), rid="b"),
        ]
        out = vl.coarse_roads(feats, level=9, edge_m=40000.0)
        self.assertEqual(len(out), 1)
        self.assertAlmostEqual(float(out[0]["line"].length), 6000.0, places=3)

    def test_a_short_major_is_dropped_at_a_coarse_level(self):
        feats = [road("primary", ref="MD 2", line=LineString([(0, 0), (500, 0)]))]
        self.assertEqual(vl.coarse_roads(feats, level=10, edge_m=20000.0), [])

    def test_simplify_decimates_a_jagged_line(self):
        pts = [(x, 10.0 if x % 20 == 0 else 0.0) for x in range(0, 5000, 10)]
        feats = [road("motorway", ref="I 95", line=LineString(pts))]
        out = vl.coarse_roads(feats, level=10, edge_m=20000.0)
        self.assertLess(len(out[0]["line"].coords), len(pts))

    def test_order_is_major_first_and_stable(self):
        feats = [
            road("primary", ref="MD 450", line=LineString([(0, 0), (30000, 0)])),
            road("motorway", ref="I 95", line=LineString([(0, 0), (30000, 0)])),
            road("trunk", ref="US 50", line=LineString([(0, 0), (30000, 0)])),
        ]
        out = vl.coarse_roads(feats, level=10, edge_m=20000.0)
        self.assertEqual([f["highway"] for f in out], ["motorway", "trunk", "primary"])
        again = vl.coarse_roads(list(reversed(feats)), level=10, edge_m=20000.0)
        self.assertEqual([f["ref"] for f in out], [f["ref"] for f in again])


class LayerTest(unittest.TestCase):
    def test_trails_survive_a_coarse_level_when_named_and_long(self):
        # a trail is never dropped for being "minor" — only for being nameless or short
        feats = [
            line_feat("kind", "path", name="Appalachian Trail", length=9000.0),
            line_feat("kind", "cycleway", name="Rock Creek Trail", length=9000.0),
            line_feat("kind", "path", length=9000.0),  # unnamed
            line_feat("kind", "path", name="Short Spur", length=1000.0),  # too short at z8
        ]
        out = vl.coarse_layer("trails", feats, level=8, edge_m=80000.0)
        self.assertEqual({f["name"] for f in out}, {"Appalachian Trail", "Rock Creek Trail"})

    def test_trails_keep_every_kind_at_a_mid_level_too(self):
        feats = [line_feat("kind", "bridleway", name="Bridle Path", length=2000.0)]
        out = vl.coarse_layer("trails", feats, level=10, edge_m=20000.0)
        self.assertEqual(len(out), 1)

    def test_streams_are_length_gated_hardest(self):
        feats = [
            line_feat("kind", "river", name="Patuxent River", length=40000.0),
            line_feat("kind", "stream", name="Long Branch", length=20000.0),  # < 30 km at z8
        ]
        out = vl.coarse_layer("streams", feats, level=8, edge_m=80000.0)
        self.assertEqual([f["name"] for f in out], ["Patuxent River"])

    def test_rail_is_a_layer_of_its_own(self):
        feats = [line_feat("kind", "rail", name="CSX", length=20000.0)]
        out = vl.coarse_layer("rail", feats, level=9, edge_m=40000.0)
        self.assertEqual(len(out), 1)


if __name__ == "__main__":
    unittest.main()
