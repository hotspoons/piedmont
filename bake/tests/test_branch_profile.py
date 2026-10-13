"""Branch profiling: group the cloud once, fan the chains out, keep the answers.

The old loop did `pts["road"] == road_index` for every one of 10,137 chains — a full scan of the
669 M-point cloud per chain, ~3.5 h of the Capital Beltway bake — and ran them one at a time.
`build_road_index` sorts once; `profile_many` forks so the cloud is shared copy-on-write. These
tests pin the two rules that make that safe: a chain's slice is exactly the points the mask
selected, in the same order, and the pool returns results in task order (a failure is a None, not
a dead bake).

    bake/.venv/bin/python -m unittest discover -s bake/tests
"""
from __future__ import annotations

import json
import math
import sys
import tempfile
import unittest
from pathlib import Path

import numpy as np
from shapely.geometry import LineString

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from piedmont_bake import network_tiles as nt  # noqa: E402
from piedmont_bake.geo import Frame  # noqa: E402

LON, LAT = -76.685, 39.007
FRAME = Frame.at(LON, LAT)
OX, OY = FRAME.origin


def _raster(path: Path, value: float, west: float, north: float, n: int) -> None:
    import rasterio
    from rasterio.transform import from_origin

    with rasterio.open(
        path, "w", driver="GTiff", height=n, width=n, count=1, dtype="float32",
        crs="EPSG:32618", transform=from_origin(west, north, 1.0, 1.0), nodata=-9999.0,
    ) as dst:
        dst.write(np.full((n, n), value, np.float32), 1)


class RoadIndexTest(unittest.TestCase):
    def test_slice_is_exactly_the_mask_in_order(self):
        road = np.array([0, 2, 1, 2, 0, 1, 1], dtype=np.int16)
        pts = {"road": road, "x": np.arange(7)}
        order, bounds = nt.build_road_index(pts)
        for rid in (0, 1, 2):
            a, b = bounds[rid]
            sel = np.sort(order[a:b])
            np.testing.assert_array_equal(sel, np.flatnonzero(road == rid))

    def test_a_road_with_no_points_is_absent(self):
        order, bounds = nt.build_road_index({"road": np.array([1, 1, 3])})
        self.assertNotIn(2, bounds)
        self.assertEqual(bounds[1], (0, 2))
        self.assertEqual(bounds[3], (2, 3))

    def test_no_road_column_is_no_index(self):
        self.assertIsNone(nt.build_road_index(None))
        self.assertIsNone(nt.build_road_index({"x": np.arange(3)}))
        self.assertIsNone(nt.build_road_index({"road": np.zeros(0, np.int16)}))


class ProfileManyTest(unittest.TestCase):
    def setUp(self):
        self.orig = nt.profile_tiled

    def tearDown(self):
        nt.profile_tiled = self.orig

    def _fake(self, boom=None):
        def fake(line, ldir, pts, road_index=None, road_index_cache=None, crossings_over_s=None):
            if boom is not None and road_index == boom:
                raise RuntimeError("synthetic failure")
            a, b = road_index_cache[1][road_index]
            return {"road_index": int(road_index), "n": int(b - a), "length": float(line.length)}
        return fake

    def _tasks(self):
        return [
            (1, "a", LineString([(0.0, 0.0), (1.0, 0.0)])),
            (2, "b", LineString([(0.0, 0.0), (2.0, 0.0)])),
            (3, "c", LineString([(0.0, 0.0), (3.0, 0.0)])),
        ]

    def test_parallel_matches_serial_in_order(self):
        nt.profile_tiled = self._fake()
        pts = {"road": np.array([1, 2, 2, 3, 3, 3], np.int16)}
        serial = nt.profile_many(self._tasks(), Path("."), pts, jobs=1)
        parallel = nt.profile_many(self._tasks(), Path("."), pts, jobs=3)
        self.assertEqual(serial, parallel)
        self.assertEqual([p["road_index"] for p in parallel], [1, 2, 3])
        self.assertEqual([p["n"] for p in parallel], [1, 2, 3])

    def test_a_failed_chain_is_none_not_a_dead_pool(self):
        nt.profile_tiled = self._fake(boom=2)
        pts = {"road": np.array([1, 2, 2, 3, 3, 3], np.int16)}
        for jobs in (1, 3):
            got = nt.profile_many(self._tasks(), Path("."), pts, jobs=jobs)
            self.assertIsNone(got[1])
            self.assertIsNotNone(got[0])
            self.assertIsNotNone(got[2])


class ProfileTiledEquivalenceTest(unittest.TestCase):
    """The cached slice must produce the SAME profile as the old full-cloud scan."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.ldir = Path(self.tmp.name)
        _raster(self.ldir / "dtm.tif", 10.0, OX - 50.0, OY + 250.0, 300)
        _raster(self.ldir / "chm.tif", 0.0, OX - 50.0, OY + 250.0, 300)
        self.line = LineString([(OX, OY), (OX + 200.0, OY)])
        rng = np.random.default_rng(1)
        n = 400
        x = OX + rng.uniform(0.0, 200.0, n)
        y = OY + rng.uniform(-5.0, 5.0, n)
        self.pts = {
            "x": x, "y": y, "z": np.full(n, 10.0),
            "cls": np.full(n, 2, np.uint8), "rn": np.ones(n, np.uint8),
            "nr": np.ones(n, np.uint8), "i": rng.integers(100, 200, n).astype(np.uint16),
            "road": np.where(y > OY, 2, 1).astype(np.int16),
        }

    def tearDown(self):
        self.tmp.cleanup()

    def test_cached_slice_matches_the_scan(self):
        scan = nt.profile_tiled(self.line, self.ldir, self.pts, 1, road_index_cache=None)
        cache = nt.build_road_index(self.pts)
        cached = nt.profile_tiled(self.line, self.ldir, self.pts, 1, road_index_cache=cache)
        self.assertEqual(scan, cached)

    def test_forked_pool_matches_serial(self):
        tasks = [(1, "a", self.line), (2, "b", self.line)]
        serial = nt.profile_many(tasks, self.ldir, self.pts, jobs=1)
        parallel = nt.profile_many(tasks, self.ldir, self.pts, jobs=2)
        self.assertEqual(serial, parallel)


class SampleOutsideRasterTest(unittest.TestCase):
    """A station outside this shard's raster is NaN, not the nearest EDGE pixel.

    `lidar.profile` clamped out-of-bounds row/col to the raster edge, so a shard that did not cover
    a station still answered for it with a finite value. `shards.stitch_profile`'s "first finite
    wins" took that value wherever the OWNING shard's own cell was a hole, and on i70 one shard's
    edge — the constant 144.93 — leaked into 1,624 stations: every overpass read as a ditch
    (2026-10-12). The edge here is 999 so a clamp cannot be mistaken for the interior 5.
    """

    def setUp(self):
        import rasterio
        from rasterio.transform import from_origin

        self.tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self.tmp.name)
        west, north, n = OX, OY + 100.0, 100
        for name, val in (("dtm", 5.0), ("chm", 0.0)):
            a = np.full((n, n), val, np.float32)
            a[:, -1] = 999.0  # the far edge: a clamped far-away station would read this
            with rasterio.open(
                self.dir / f"{name}.tif", "w", driver="GTiff", height=n, width=n, count=1,
                dtype="float32", crs="EPSG:32618", transform=from_origin(west, north, 1.0, 1.0),
                nodata=-9999.0,
            ) as dst:
                dst.write(a, 1)
        # runs from inside the raster (x=OX..OX+100) off its east edge to x=OX+300
        self.line = LineString([(OX, OY + 50.0), (OX + 300.0, OY + 50.0)])

    def tearDown(self):
        self.tmp.cleanup()

    def _split(self, raw):
        inside = [z for z, s in zip(raw["road_z"], raw["s"]) if s < 80.0]
        outside = [z for z, s in zip(raw["road_z"], raw["s"]) if s > 150.0]
        return inside, outside

    def test_outside_is_nan_not_the_edge(self):
        import math

        raw = nt.profile_tiled(self.line, self.dir, None, fill=False)
        inside, outside = self._split(raw)
        self.assertTrue(inside and all(abs(z - 5.0) < 1e-6 for z in inside))
        self.assertTrue(outside and all(math.isnan(z) for z in outside))

    def test_the_filled_run_bridges_the_gap_without_the_edge(self):
        raw = nt.profile_tiled(self.line, self.dir, None, fill=True)
        self.assertTrue(all(abs(z - 5.0) < 1e-6 for z in raw["road_z"]))  # never 999


class NoDataShardTest(unittest.TestCase):
    """A shard that owns no lidar must not fill the stitch with sea level.

    The owner of i70's spine start (s=0..1846) has no lidar raster there, so once `sample` learned to
    answer NaN outside a raster the station was a hole in the OWNER. The shard that owns no world
    tiles profiles the WHOLE primary from its own block-sized DEM; where the line leaves that DEM,
    `_fill_along`'s all-bad branch wrote `0.0` and `stitch_profile`'s "first finite wins" took it --
    the grade dived to sea level. `profile_from_dem(..., fill=False)` keeps the NaN instead, so the
    stitch interpolates the hole along-track (2026-10-13).
    """

    def setUp(self):
        import rasterio
        from rasterio.transform import from_origin

        self.tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self.tmp.name)
        n = 40
        with rasterio.open(
            self.dir / "dem.tif", "w", driver="GTiff", height=n, width=n, count=1,
            dtype="float32", crs="EPSG:32618", transform=from_origin(OX, OY + 40.0, 1.0, 1.0),
            nodata=-9999.0,
        ) as dst:
            dst.write(np.full((n, n), 120.0, np.float32), 1)
        # 300 m east of the DEM: no station is covered
        self.far = LineString([(OX + 300.0, OY), (OX + 500.0, OY)])

    def tearDown(self):
        self.tmp.cleanup()

    def test_raw_dem_profile_is_nan_not_zero(self):
        prof = nt.profile_from_dem(self.far, self.dir / "dem.tif", fill=False)
        self.assertTrue(prof["road_z"])
        self.assertTrue(all(math.isnan(z) for z in prof["road_z"]))

    def test_the_filled_dem_profile_is_sea_level(self):
        # the documented all-bad fallback, kept for the whole-site path that has no stitch to fill it
        prof = nt.profile_from_dem(self.far, self.dir / "dem.tif")
        self.assertTrue(all(z == 0.0 for z in prof["road_z"]))

    def test_a_no_data_shard_does_not_fill_the_stitch_with_zero(self):
        from piedmont_bake import shards

        real = self.dir / "shard0"
        nodata = self.dir / "shard1"
        real.mkdir()
        nodata.mkdir()
        # the no-data shard's profile, exactly as the shard writes it (raw: NaN outside its DEM)
        nodata_prof = nt.profile_from_dem(self.far, self.dir / "dem.tif", fill=False)
        nodata_prof["owned"] = []
        (nodata / "profile.json").write_text(json.dumps(nodata_prof))
        s = nodata_prof["s"]
        hole = len(s) // 2
        real_z = [100.0] * len(s)
        real_z[hole] = None
        (real / "profile.json").write_text(json.dumps({
            "step_m": nodata_prof["step_m"], "s": s, "road_z": real_z, "owned": [[0, len(s) - 1]]}))
        out = self.dir / "out"
        self.assertTrue(shards.stitch_profile([real, nodata], out))
        got = json.loads((out / "profile.json").read_text())["road_z"]
        self.assertEqual(got, [100.0] * len(s))  # the owner's hole, not the no-data shard's zero


class BridgeNanTest(unittest.TestCase):
    """Detection reads a hole-bridged array; the returned arrays keep their NaN."""

    def test_holes_are_interpolated(self):
        from piedmont_bake.lidar import _bridge_nan

        got = _bridge_nan(np.array([1.0, np.nan, np.nan, 4.0]))
        np.testing.assert_allclose(got, [1.0, 2.0, 3.0, 4.0])

    def test_no_hole_is_returned_unchanged(self):
        from piedmont_bake.lidar import _bridge_nan

        a = np.array([1.0, 2.0, 3.0])
        self.assertIs(_bridge_nan(a), a)

    def test_all_holes_is_zeros_not_a_crash(self):
        from piedmont_bake.lidar import _bridge_nan

        np.testing.assert_array_equal(_bridge_nan(np.array([np.nan, np.nan])), [0.0, 0.0])


class AnOverpassOverADtmHoleTest(unittest.TestCase):
    """A hole in the DTM under a crossing deck must not truncate the deck's span.

    The owner shard's own raster is nodata where the ground under a bridge is never seen (i70's
    Ernstville: s=10904 and s=10914-10922), so `surface_z` was NaN exactly across a deck 6.4 m up.
    Every deck point there then failed the 4.5-40 m above-surface test, and a real overpass came out
    a 2 m `gantry`, which the game draws no scenery for (2026-10-12).
    """

    def setUp(self):
        import rasterio
        from rasterio.transform import from_origin

        self.tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self.tmp.name)
        n = 300
        west, north = OX - 50.0, OY + 50.0
        for name in ("dtm", "chm"):
            a = np.full((n, n), 100.0 if name == "dtm" else 0.0, np.float32)
            if name == "dtm":
                a[45:56, 145:158] = -9999.0  # nodata for x in [OX+95, OX+107]: under the bridge
            with rasterio.open(
                self.dir / f"{name}.tif", "w", driver="GTiff", height=n, width=n, count=1,
                dtype="float32", crs="EPSG:32618", transform=from_origin(west, north, 1.0, 1.0),
                nodata=-9999.0,
            ) as dst:
                dst.write(a, 1)
        self.line = LineString([(OX, OY), (OX + 200.0, OY)])
        rng = np.random.default_rng(3)
        gx, gy = OX + rng.uniform(0.0, 200.0, 800), OY + rng.uniform(-8.0, 8.0, 800)
        dx, dy = OX + rng.uniform(92.0, 112.0, 400), OY + rng.uniform(-8.0, 8.0, 400)
        x, y = np.concatenate([gx, dx]), np.concatenate([gy, dy])
        z = np.concatenate([np.full(800, 100.0), np.full(400, 106.0)])  # a deck 6 m up
        self.pts = {
            "x": x, "y": y, "z": z, "cls": np.full(x.size, 2, np.uint8),
            "rn": np.ones(x.size, np.uint8), "nr": np.ones(x.size, np.uint8),
            "i": rng.integers(100, 300, x.size).astype(np.uint16), "road": np.ones(x.size, np.int16),
        }

    def tearDown(self):
        self.tmp.cleanup()

    def test_the_span_covers_the_hole_and_is_an_overpass(self):
        prof = nt.profile_tiled(self.line, self.dir, self.pts, 1, crossings_over_s=[102.0])
        spans = [st for st in prof["structures"] if st["kind"] in ("overpass", "gantry")]
        self.assertTrue(spans, "no spanning structure at all")
        best = max(spans, key=lambda st: st["length_m"])
        self.assertGreaterEqual(best["length_m"], 5.0)  # not a 2 m gantry
        self.assertLessEqual(best["s_start"], 96.0)  # covers the hole on both sides
        self.assertGreaterEqual(best["s_end"], 108.0)
        self.assertEqual(best["kind"], "overpass")  # OSM says a way crosses over here


if __name__ == "__main__":
    unittest.main()
