"""No stop sign stands on a freeway.

Rich drove the Capital Beltway and found a STOP sign on its shoulder. Two independent defects put
it there, and both are asserted here:

  1. the spine (`primary`) carries its identity but not always its OSM tags; the class lives in the
     spine's own `segments`. `_roads` ignored them and defaulted the whole spine to `secondary`
     (rank 6), so a `motorway_link` joining it (rank 8) OUTRANKED the motorway — and where that link
     did not run through, no arm held the top rank, `main` came out empty, and the junction fell to
     an all-way stop that stopped I-495.

  2. a divided freeway is two one-way OSM ways, so its two carriageways enter `main` as two
     "roads" and an all-way stop is inferred. A `motorway` carriageway must never be a stopping arm.

The site is synthetic: a fake frame makes UTM and ENU the same plane, which is all `_roads` and
`build` need to reason about classes, bearings and priority.
"""
from __future__ import annotations

import json
import math
import random
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory


class _Frame:
    """to_enu is an identity: this test cares about class and continuity, not the ellipsoid."""

    def to_enu(self, xs, ys):
        return list(xs), list(ys)


def _site(primary: dict, segments: list[dict], siblings: list[dict]) -> TemporaryDirectory:
    tmp = TemporaryDirectory()
    sp = {
        "epsg": 32618,
        "coords": primary["coords"],
        "segments": segments,
        "siblings": siblings,
        "network": True,
        "primary": primary,
        "roads": [],
    }
    Path(tmp.name, "spine_utm.json").write_text(json.dumps(sp))
    return tmp


def _line(coords, junctions, highway, oneway="no", rid="r", ident=None, name=None, ref=None):
    return {
        "id": rid, "ident": ident, "name": name, "ref": ref, "highway": highway,
        "oneway": oneway, "tags": {}, "length_m": 0.0,
        "geometry": {"type": "LineString", "coordinates": coords},
        "junctions": junctions,
    }


_LINK_JUNCTION = {"node": 7, "x": 200.0, "y": 0.0, "s": 100.0, "with": []}


class SpineClass(unittest.TestCase):
    def test_the_spine_rank_is_read_from_its_segments(self):
        primary = {"id": "r26660521", "ident": "Capital Beltway", "coords": [[0, 0], [200, 0]], "junctions": []}
        segs = [{"osm_id": 1, "tags": {"highway": "motorway", "name": "Capital Beltway", "oneway": "yes"}}]
        tmp = _site(primary, segs, [])
        with tmp:
            from piedmont_bake.intersections import _roads

            roads = _roads(Path(tmp.name), _Frame())
        self.assertEqual(roads[0]["highway"], "motorway")
        self.assertEqual(roads[0]["rank"], 9)
        # the segment tags are what carries the class through to `_lanes` etc.
        self.assertEqual(roads[0]["tags"].get("highway"), "motorway")

    def test_a_spine_with_segments_and_no_tags_still_ranks_by_class(self):
        # the beltway's real shape: primary block lacks `highway`, segments say motorway
        primary = {"id": "r1", "ident": "Capital Beltway", "coords": [[0, 0], [200, 0]], "junctions": []}
        tmp = _site(primary, [{"tags": {"highway": "motorway"}}], [])
        with tmp:
            from piedmont_bake.intersections import _roads

            roads = _roads(Path(tmp.name), _Frame())
        self.assertNotEqual(roads[0]["highway"], "secondary")


class NoStopOnAFreeway(unittest.TestCase):
    def test_a_motorway_link_joining_a_motorway_is_a_merge_not_a_stop(self):
        # primary: motorway, through the junction at s=200 of 400
        primary = {
            "id": "r1", "ident": "Capital Beltway",
            "coords": [[0, 0], [100, 0], [200, 0], [300, 0], [400, 0]],
            "junctions": [{"node": 7, "x": 200.0, "y": 0.0, "s": 200.0, "with": []}],
        }
        segs = [{"tags": {"highway": "motorway"}}]
        # a ramp ENDS on the motorway: junction at its far end (s == length), one-way
        ramp = _line([[200, 100], [200, 0]], [_LINK_JUNCTION], "motorway_link", oneway="yes", rid="r2", ident="ramp")
        tmp = _site(primary, segs, [ramp])
        with tmp:
            from piedmont_bake.intersections import build

            built = build(Path(tmp.name), _Frame())
        self.assertEqual(len(built["list"]), 1)
        ix = built["list"][0]
        # a freeway + a ramp is a merge: nobody stops, and certainly not the motorway
        self.assertEqual(ix["control"], "uncontrolled")
        self.assertFalse(any(a["stop"] for a in ix["approaches"]))
        # the exact old failure: an all-way stop with the motorway stopping
        self.assertNotEqual(ix["control"], "all_way_stop")
        self.assertEqual(built["counts"]["all_way_stop"], 0)
        self.assertEqual(built["counts"]["stop_signs"], 0)

    def test_a_divided_freeway_crossing_is_not_an_all_way_stop(self):
        # two one-way carriageways of ONE freeway through the same node -> `main` sees two roads.
        a = {"id": "rA", "coords": [[0, 0], [200, 0], [400, 0]], "junctions": [{"node": 9, "x": 200.0, "y": 0.0, "s": 200.0, "with": []}]}
        b = _line([[0, 0], [200, 0], [400, 0]], [{"node": 9, "x": 200.0, "y": 0.0, "s": 200.0, "with": []}], "motorway", oneway="no", rid="rB")
        tmp = _site(a, [{"tags": {"highway": "motorway"}}], [b])
        with tmp:
            from piedmont_bake.intersections import build

            built = build(Path(tmp.name), _Frame())
        ix = built["list"][0]
        for arm in ix["approaches"]:
            self.assertFalse(arm["stop"], f"{arm['highway']} carriageway stopped")
        self.assertEqual(built["counts"]["stop_signs"], 0)
        self.assertEqual(ix["control"], "uncontrolled")


class RouteGrouping(unittest.TestCase):
    def test_a_divided_arterial_is_one_road_not_a_crossroads(self):
        # two carriageways of Columbia Pike (same name) through one node + a residential crossing.
        # Without route grouping `main` holds two roads and the whole thing goes all-way.
        primary = {
            "id": "r1", "ident": "Columbia Pike", "name": "Columbia Pike",
            "coords": [[0, 0], [200, 0], [400, 0]],
            "junctions": [{"node": 5, "x": 200.0, "y": 0.0, "s": 200.0, "with": []}],
        }
        pike_b = _line([[0, 0], [200, 0], [400, 0]], [{"node": 5, "x": 200.0, "y": 0.0, "s": 200.0, "with": []}], "trunk", oneway="no", rid="r2", name="Columbia Pike")
        cardinal = _line([[200, -200], [200, 0], [200, 200]], [{"node": 5, "x": 200.0, "y": 0.0, "s": 200.0, "with": []}], "residential", rid="r3", name="Cardinal Drive")
        tmp = _site(primary, [{"tags": {"highway": "trunk"}}], [pike_b, cardinal])
        with tmp:
            from piedmont_bake.intersections import build

            built = build(Path(tmp.name), _Frame())
        ix = built["list"][0]
        self.assertEqual(ix["control"], "two_way_stop")
        for a in ix["approaches"]:
            if a["name"] == "Columbia Pike":
                self.assertFalse(a["stop"], "the arterial must not stop")
            else:
                self.assertTrue(a["stop"], "the residential yields to the arterial")

    def test_two_unnamed_streets_are_not_the_same_route(self):
        # «unnamed» is a placeholder, not an identity; these two must stay distinct roads and their
        # crossing stays an all-way stop instead of collapsing to "one road forking".
        primary = {
            "id": "r1", "ident": "«unnamed»", "name": None,
            "coords": [[0, 0], [200, 0], [400, 0]],
            "junctions": [{"node": 6, "x": 200.0, "y": 0.0, "s": 200.0, "with": []}],
        }
        sib = _line([[200, -200], [200, 0], [200, 200]], [{"node": 6, "x": 200.0, "y": 0.0, "s": 200.0, "with": []}], "residential", rid="r2", ident="«unnamed»")
        tmp = _site(primary, [{"tags": {"highway": "residential"}}], [sib])
        with tmp:
            from piedmont_bake.intersections import build

            built = build(Path(tmp.name), _Frame())
        ix = built["list"][0]
        self.assertEqual(ix["control"], "all_way_stop")
        self.assertTrue(any(a["stop"] for a in ix["approaches"]))


def _old_cluster(nodes: list[dict], radius: float) -> list[list[int]]:
    """The all-pairs loop `_cluster_nodes` replaced: the regression oracle for membership AND order."""
    unassigned = list(range(len(nodes)))
    clusters = []
    while unassigned:
        grp = [unassigned.pop()]
        moved = True
        while moved:
            moved = False
            for i in list(unassigned):
                if any(math.dist((nodes[i]["x"], nodes[i]["y"]), (nodes[k]["x"], nodes[k]["y"])) <= radius for k in grp):
                    grp.append(i)
                    unassigned.remove(i)
                    moved = True
        clusters.append(grp)
    return clusters


class Clustering(unittest.TestCase):
    """The junction clustering is O(n) now; the clusters, and the order of clusters and members, must
    be exactly what the old all-pairs loop produced — a re-bake has to write the same manifest."""

    def test_matches_the_old_all_pairs_loop(self):
        from piedmont_bake.intersections import _cluster_nodes

        for size, spread, seed in [(0, 0, 1), (1, 0, 2), (2, 0, 3), (60, 300, 4), (400, 600, 5), (800, 250, 6)]:
            rng = random.Random(seed)
            nodes = [{"x": rng.uniform(0, spread), "y": rng.uniform(0, spread)} for _ in range(size)]
            self.assertEqual(_cluster_nodes(nodes), _old_cluster(nodes, 20.0), f"size {size} spread {spread}")

    def test_a_chain_is_one_cluster_and_isolated_points_are_singletons(self):
        from piedmont_bake.intersections import _cluster_nodes

        nodes = [{"x": 15.0 * i, "y": 0.0} for i in range(10)]  # each within 20 m of the next
        nodes.append({"x": 0.0, "y": 1000.0})
        nodes.append({"x": 1000.0, "y": 1000.0})
        got = _cluster_nodes(nodes)
        self.assertEqual(len(got), 3)
        self.assertEqual(sorted(len(g) for g in got), [1, 1, 10])

    def test_a_large_network_returns_promptly(self):
        # 20,000 nodes on a jittered 10 m grid: one connected mesh. The old loop was ~4e8 distance
        # comparisons here (minutes); this must return, and cover every node, in about a second.
        from piedmont_bake.intersections import _cluster_nodes

        rng = random.Random(7)
        nodes = [{"x": (i % 200) * 10.0 + rng.uniform(-2, 2),
                  "y": (i // 200) * 10.0 + rng.uniform(-2, 2)} for i in range(20_000)]
        got = _cluster_nodes(nodes)
        self.assertEqual(sum(len(g) for g in got), len(nodes))


if __name__ == "__main__":
    unittest.main()