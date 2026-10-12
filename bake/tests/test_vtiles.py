"""vtiles: coarse vector tiles tiled beside `vt/0`, layer by layer.

`vectorlod` is the reduction; this is the tiling around it — gather the four distance-reading layers
from the manifest arrays, assign each feature to every coarse site-metre cell it crosses, reduce per
cell, and write `web/vt/<z>/<ix>_<iy>.json` as a partial manifest. Synthetic features, no bake.

    bake/.venv/bin/python -m unittest discover -s tests
"""
from __future__ import annotations

import json
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from piedmont_bake import vtiles as vt  # noqa: E402


def seg(x0, y0, x1, y1):
    return [[float(x0), float(y0)], [float(x1), float(y1)]]


def road(cls, x0, x1, y=0.0, name=None, ref=None):
    return {"highway": cls, "name": name, "ref": ref, "coords": seg(x0, y, x1, y)}


class CellTest(unittest.TestCase):
    def test_a_level_is_a_quadtree_z_off_the_leaf(self):
        self.assertEqual(vt.cell_m_for(14), 1000.0)
        self.assertEqual(vt.cell_m_for(13), 2000.0)
        self.assertEqual(vt.cell_m_for(12), 4000.0)
        self.assertEqual(vt.cell_m_for(11), 8000.0)
        self.assertEqual(vt.cell_m_for(8), 64000.0)

    def test_the_cell_size_scales_with_the_base(self):
        self.assertEqual(vt.cell_m_for(11, 2000.0), 16000.0)


class GatherTest(unittest.TestCase):
    def test_the_four_sources_map_to_the_four_layers(self):
        arrays = {
            "branches": [road("motorway", 0, 100, ref="I 95")],
            "trails": [{"kind": "path", "name": "Patuxent Trail", "coords": seg(0, 0, 100, 0)}],
            "rail": [{"kind": "rail", "name": "CSX", "coords": seg(0, 0, 100, 0)}],
            "water": {"lines": [{"kind": "river", "name": "Patuxent", "pts": seg(0, 0, 100, 0)}]},
        }
        out = vt.gather(arrays)
        self.assertEqual(out["roads"][0]["highway"], "motorway")
        self.assertEqual(out["trails"][0]["kind"], "path")
        self.assertEqual(out["rail"][0]["kind"], "rail")
        self.assertEqual(out["streams"][0]["kind"], "river")

    def test_a_one_point_or_missing_source_contributes_nothing(self):
        out = vt.gather({"branches": [{"highway": "motorway", "coords": [[0.0, 0.0]]}], "water": {}})
        self.assertEqual(out["roads"], [])
        self.assertEqual(out["streams"], [])

    def test_an_empty_arrays_dict_is_all_empty_layers(self):
        out = vt.gather({})
        self.assertEqual(set(out), set(vt.vectorlod.LAYERS))
        self.assertTrue(all(v == [] for v in out.values()))


class AssignTest(unittest.TestCase):
    def test_a_short_feature_lands_in_the_cell_that_contains_it(self):
        feats = vt.gather({"branches": [road("motorway", 500, 1500, 500, ref="I 95")]})
        cells = vt.assign(feats, 14)  # 1 km cells
        self.assertIn((0, 0), cells)
        self.assertIn("roads", cells[(0, 0)])

    def test_a_long_feature_is_in_every_cell_it_crosses(self):
        feats = vt.gather({"branches": [road("motorway", 0, 25000, ref="I 95")]})
        cells = vt.assign(feats, 11)  # 8 km cells: x in 0..3
        self.assertEqual(sorted(c[0] for c in cells), [0, 1, 2, 3])
        for c in cells.values():
            self.assertEqual(len(c["roads"]), 1)

    def test_no_features_is_no_cells(self):
        self.assertEqual(vt.assign(vt.gather({}), 10), {})


class BuildLevelTest(unittest.TestCase):
    def test_a_coarse_tile_drops_minor_and_unnamed_roads(self):
        arrays = {"branches": [
            road("motorway", 0, 50000, ref="I 95"),
            road("residential", 0, 50000, name="Oak Ct"),
            road("primary", 0, 50000),  # right class, no name/ref
        ]}
        cells = vt.build_level(vt.gather(arrays), 10)
        docs = [d for cell in cells.values() for d in cell.get("branches", [])]
        self.assertTrue(docs)
        self.assertEqual({d.get("ref") for d in docs}, {"I 95"})

    def test_a_coarse_tile_is_a_partial_manifest_in_site_metres(self):
        arrays = {"branches": [road("motorway", 0, 50000, y=1000, ref="I 95")]}
        cells = vt.build_level(vt.gather(arrays), 10)
        cell = next(iter(cells.values()))
        self.assertIn("branches", cell)
        doc = cell["branches"][0]
        self.assertEqual(doc["highway"], "motorway")
        self.assertIn("coords", doc)
        for x, y in doc["coords"]:
            self.assertLess(abs(x), 200000.0)
            self.assertLess(abs(y), 200000.0)

    def test_streams_are_nested_under_water_lines(self):
        arrays = {"water": {"lines": [{"kind": "river", "name": "Patuxent", "pts": seg(0, 0, 50000, 0)}]}}
        cells = vt.build_level(vt.gather(arrays), 10)
        docs = [d for cell in cells.values() for d in cell.get("water", {}).get("lines", [])]
        self.assertTrue(docs)
        self.assertEqual({d["kind"] for d in docs}, {"river"})

    def test_the_leaf_level_keeps_everything(self):
        arrays = {"branches": [road("residential", 0, 500, name="Oak Ct")]}
        cells = vt.build_level(vt.gather(arrays), 14)
        docs = [d for cell in cells.values() for d in cell.get("branches", [])]
        self.assertEqual(len(docs), 1)
        self.assertEqual(docs[0]["name"], "Oak Ct")

    def test_an_empty_cell_is_dropped(self):
        arrays = {"branches": [road("residential", 0, 500, name="Oak Ct")]}
        self.assertEqual(vt.build_level(vt.gather(arrays), 10), {})


class LevelsTest(unittest.TestCase):
    def test_coarse_levels_stop_below_the_finest_full_level(self):
        self.assertEqual(vt.levels_for(9, 14), [9, 10, 11])
        self.assertEqual(vt.levels_for(11, 14), [11])

    def test_a_leaf_only_pyramid_gets_no_coarse_bundle(self):
        self.assertEqual(vt.levels_for(13, 14), [])
        self.assertEqual(vt.levels_for(12, 14), [])


class WriteLevelsTest(unittest.TestCase):
    def test_it_writes_a_bundle_per_level_and_an_index(self):
        arrays = {"branches": [road("motorway", 0, 50000, ref="I 95")]}
        with tempfile.TemporaryDirectory() as tmp:
            web = Path(tmp)
            index = vt.write_levels(web, arrays, 11, 11)
            self.assertIn("11", index)
            self.assertEqual(index["11"]["cell_m"], 8000.0)
            self.assertGreater(index["11"]["count"], 0)
            row = index["11"]["tiles"][0]
            f = web / "vt" / "11" / f"{row['x']}_{row['y']}.json"
            self.assertTrue(f.exists())
            cell = json.loads(f.read_text())
            self.assertIn("branches", cell)
            self.assertIn("coords", cell["branches"][0])

    def test_nothing_to_write_is_no_index_and_no_directory(self):
        with tempfile.TemporaryDirectory() as tmp:
            web = Path(tmp)
            self.assertEqual(vt.write_levels(web, {}, 11, 11), {})
            self.assertFalse((web / "vt").exists())

    def test_a_rewrite_replaces_the_level_rather_than_accumulating(self):
        arrays = {"branches": [road("motorway", 0, 50000, ref="I 95")]}
        with tempfile.TemporaryDirectory() as tmp:
            web = Path(tmp)
            first = vt.write_levels(web, arrays, 11, 11)
            second = vt.write_levels(web, arrays, 11, 11)
            self.assertEqual(first, second)
            self.assertEqual(len(list((web / "vt" / "11").glob("*.json"))), len(second["11"]["tiles"]))


if __name__ == "__main__":
    unittest.main()
