"""vtiles: coarse vector tiles tiled onto the raster pyramid, layer by layer.

`vectorlod` is the reduction; this is the tiling around it — gather the four distance-reading layers
from the manifest arrays, assign each feature to every pyramid tile it crosses, reduce per tile, and
write `web/vt/<z>/<x>_<y>.json`. Synthetic features and a real `Frame`, no bake.

    bake/.venv/bin/python -m unittest discover -s tests
"""
from __future__ import annotations

import json
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from shapely.geometry import LineString  # noqa: E402

from piedmont_bake import pyramid, vtiles as vt  # noqa: E402
from piedmont_bake.geo import Frame  # noqa: E402

# A real frame, so the ENU <-> WGS conversion under test is the bake's own.
FR = Frame.at(-76.7, 39.0)


def enu(lon, lat):
    """WGS -> the site metres the manifest stores (the inverse of `vtiles._wgs_bbox`)."""
    ux, uy = FR.from_wgs(lon, lat)
    e, n = FR.to_enu(ux, uy)
    return float(e), float(n)


def seg(lon0, lat0, lon1, lat1, nd=2):
    e0, n0 = enu(lon0, lat0)
    e1, n1 = enu(lon1, lat1)
    return [[round(e0, nd), round(n0, nd)], [round(e1, nd), round(n1, nd)]]


class GatherTest(unittest.TestCase):
    def test_the_four_sources_map_to_the_four_layers(self):
        arrays = {
            "branches": [{"highway": "motorway", "ref": "I 95", "coords": seg(-76.70, 39.0, -76.69, 39.0)}],
            "trails": [{"kind": "path", "name": "Patuxent Trail", "coords": seg(-76.70, 39.01, -76.69, 39.01)}],
            "rail": [{"kind": "rail", "name": "CSX", "coords": seg(-76.70, 39.02, -76.69, 39.02)}],
            "water": {"lines": [{"kind": "river", "name": "Patuxent", "pts": seg(-76.70, 39.03, -76.69, 39.03)}]},
        }
        out = vt.gather(arrays)
        self.assertEqual(out["roads"][0]["highway"], "motorway")
        self.assertEqual(out["trails"][0]["kind"], "path")
        self.assertEqual(out["rail"][0]["kind"], "rail")
        self.assertEqual(out["streams"][0]["kind"], "river")
        self.assertAlmostEqual(out["roads"][0]["line"].length, out["trails"][0]["line"].length, places=0)

    def test_a_one_point_or_missing_source_contributes_nothing(self):
        out = vt.gather({
            "branches": [{"highway": "motorway", "coords": [[0.0, 0.0]]}],
            "water": {},
        })
        self.assertEqual(out["roads"], [])
        self.assertEqual(out["streams"], [])

    def test_an_empty_arrays_dict_is_all_empty_layers(self):
        out = vt.gather({})
        self.assertEqual(set(out), set(vt.vectorlod.LAYERS))
        self.assertTrue(all(v == [] for v in out.values()))


class AssignTest(unittest.TestCase):
    def test_a_short_feature_lands_in_the_tile_that_contains_it(self):
        arrays = {"branches": [{"highway": "motorway", "ref": "I 95",
                                "coords": seg(-76.70, 39.0, -76.699, 39.0)}]}
        feats = vt.gather(arrays)
        z = 14
        tiles = vt.assign(feats, FR, z)
        want = pyramid.tile_of(z, -76.70, 39.0)
        self.assertIn(want, tiles)
        self.assertIn("roads", tiles[want])

    def test_a_long_feature_is_in_every_tile_it_crosses(self):
        # ~17 km of longitude at z11 (~10 km tiles) crosses more than one
        arrays = {"branches": [{"highway": "motorway", "ref": "I 95",
                                "coords": seg(-76.80, 39.0, -76.60, 39.0)}]}
        feats = vt.gather(arrays)
        tiles = vt.assign(feats, FR, 11)
        self.assertGreaterEqual(len(tiles), 2)
        # and it is in each, not split across them
        for t in tiles.values():
            self.assertEqual(len(t["roads"]), 1)

    def test_no_features_is_no_tiles(self):
        self.assertEqual(vt.assign(vt.gather({}), FR, 10), {})


class BuildLevelTest(unittest.TestCase):
    def test_a_coarse_tile_drops_minor_and_unnamed_roads(self):
        # long enough that a tile's fragment clears the z10 length gate after the split
        arrays = {"branches": [
            {"highway": "motorway", "ref": "I 95", "coords": seg(-76.80, 39.0, -76.50, 39.0)},
            {"highway": "residential", "name": "Oak Ct", "coords": seg(-76.80, 39.0, -76.50, 39.0)},
            {"highway": "primary", "coords": seg(-76.80, 39.0, -76.50, 39.0)},  # right class, no name
        ]}
        cells = vt.build_level(vt.gather(arrays), FR, 10, 39.0)
        docs = [d for cell in cells.values() for d in cell.get("roads", [])]
        self.assertTrue(docs)
        self.assertEqual({d.get("ref") for d in docs}, {"I 95"})

    def test_the_leaf_level_keeps_everything(self):
        arrays = {"branches": [
            {"highway": "residential", "name": "Oak Ct", "coords": seg(-76.70, 39.0, -76.699, 39.0)},
        ]}
        cells = vt.build_level(vt.gather(arrays), FR, 14, 39.0)
        docs = [d for cell in cells.values() for d in cell.get("roads", [])]
        self.assertEqual(len(docs), 1)
        self.assertEqual(docs[0]["name"], "Oak Ct")

    def test_an_empty_cell_is_dropped(self):
        arrays = {"branches": [{"highway": "residential", "name": "Oak Ct",
                                "coords": seg(-76.70, 39.0, -76.699, 39.0)}]}
        self.assertEqual(vt.build_level(vt.gather(arrays), FR, 10, 39.0), {})


class LevelsTest(unittest.TestCase):
    def test_coarse_levels_stop_below_the_finest_full_level(self):
        self.assertEqual(vt.levels_for(9, 14), [9, 10, 11])
        self.assertEqual(vt.levels_for(11, 14), [11])

    def test_a_leaf_only_pyramid_gets_no_coarse_bundle(self):
        self.assertEqual(vt.levels_for(13, 14), [])
        self.assertEqual(vt.levels_for(12, 14), [])


class WriteLevelsTest(unittest.TestCase):
    def test_it_writes_a_bundle_per_level_and_an_index(self):
        arrays = {"branches": [{"highway": "motorway", "ref": "I 95",
                                "coords": seg(-76.70, 39.0, -76.69, 39.0)}]}
        with tempfile.TemporaryDirectory() as tmp:
            web = Path(tmp)
            index = vt.write_levels(web, FR, arrays, 11, 11, 39.0)
            self.assertIn("11", index)
            self.assertGreater(index["11"]["count"], 0)
            # the index names the tiles it wrote, and each is a real file
            row = index["11"]["tiles"][0]
            f = web / "vt" / "11" / f"{row['x']}_{row['y']}.json"
            self.assertTrue(f.exists())
            cell = json.loads(f.read_text())
            self.assertIn("roads", cell)
            self.assertIn("line", cell["roads"][0])

    def test_nothing_to_write_is_no_index_and_no_directory(self):
        with tempfile.TemporaryDirectory() as tmp:
            web = Path(tmp)
            self.assertEqual(vt.write_levels(web, FR, {}, 11, 11, 39.0), {})
            self.assertFalse((web / "vt").exists())

    def test_a_rewrite_replaces_the_level_rather_than_accumulating(self):
        arrays = {"branches": [{"highway": "motorway", "ref": "I 95",
                                "coords": seg(-76.70, 39.0, -76.69, 39.0)}]}
        with tempfile.TemporaryDirectory() as tmp:
            web = Path(tmp)
            first = vt.write_levels(web, FR, arrays, 11, 11, 39.0)
            second = vt.write_levels(web, FR, arrays, 11, 11, 39.0)
            self.assertEqual(first, second)
            files = list((web / "vt" / "11").glob("*.json"))
            self.assertEqual(len(files), len(second["11"]["tiles"]))


class GeometrySpaceTest(unittest.TestCase):
    def test_a_written_feature_is_where_the_raster_tile_says(self):
        # the whole point: the vector tile is keyed like the raster tile beside it
        lon, lat = -76.7, 39.0
        arrays = {"branches": [{"highway": "motorway", "ref": "I 95",
                                "coords": seg(lon, lat, lon + 0.001, lat)}]}
        for z in (12, 13, 14):
            cells = vt.build_level(vt.gather(arrays), FR, z, lat)
            self.assertIn(pyramid.tile_of(z, lon, lat), cells)

    def test_site_metres_are_not_utm_so_the_conversion_goes_through_enu(self):
        # a feature 20 km east of the anchor: treating its metres as UTM would miss the tile it is
        # really in by the convergence; going through enu_to_utm must land it exactly
        lon, lat = -76.5, 39.0
        arrays = {"branches": [{"highway": "motorway", "ref": "US 50",
                                "coords": seg(lon, lat, lon + 0.001, lat)}]}
        cells = vt.build_level(vt.gather(arrays), FR, 13, lat)
        self.assertIn(pyramid.tile_of(13, lon, lat), cells)

    def test_the_written_line_is_in_site_metres(self):
        arrays = {"branches": [{"highway": "motorway", "ref": "I 95",
                                "coords": seg(-76.70, 39.0, -76.69, 39.0)}]}
        cells = vt.build_level(vt.gather(arrays), FR, 13, 39.0)
        doc = next(d for cell in cells.values() for d in cell.get("roads", []))
        # site metres are small offsets from the anchor, not degrees and not 400 km UTM eastings
        for x, y in doc["line"]:
            self.assertLess(abs(x), 20000.0)
            self.assertLess(abs(y), 20000.0)


if __name__ == "__main__":
    unittest.main()
