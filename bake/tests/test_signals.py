"""`export.cluster_signals` — the signal nodes of one junction, grouped near-linearly.

The grouping used to be an all-pairs greedy closure (O(n^2 x group)); on the 62 km dc-metro world it
sat in that inner loop for hours with nothing printed (TODO #10). It is now connected components over
a grid. These pin the relation it must still compute: close, OR near on a shared way (the divided
highway case), and the transitive closure a chain of nodes needs.
"""
from __future__ import annotations

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from piedmont_bake import export  # noqa: E402


def node(x: float, y: float = 0.0, ways=()) -> dict:
    return {"x": x, "y": y, "ways": [(w, 0) for w in ways]}


def waysets(nodes: list[dict]) -> list[set]:
    return [{id(w) for w, _ in n["ways"]} for n in nodes]


class ClusterSignalsTest(unittest.TestCase):
    def groups(self, nodes: list[dict]) -> list[list[int]]:
        return export.cluster_signals(nodes, waysets(nodes))

    def test_close_nodes_are_one_junction(self):
        self.assertEqual(self.groups([node(0.0), node(30.0)]), [[0, 1]])

    def test_far_nodes_on_no_shared_way_are_separate(self):
        self.assertEqual(self.groups([node(0.0), node(200.0)]), [[0], [1]])

    def test_a_divided_highways_pair_groups_despite_the_median(self):
        """67 m apart on the same way is one crossing, 100 m apart on different ways is not."""
        self.assertEqual(self.groups([node(0.0, ways=[7]), node(100.0, ways=[7])]), [[0, 1]])
        self.assertEqual(self.groups([node(0.0, ways=[7]), node(100.0, ways=[8])]), [[0], [1]])

    def test_a_chain_closes_transitively(self):
        """A-B and B-C each related but A-C 260 m apart: the whole chain is one junction."""
        g = self.groups([node(0.0, ways=[7]), node(130.0, ways=[7]), node(260.0, ways=[7])])
        self.assertEqual(g, [[0, 1, 2]])

    def test_groups_are_ordered_by_lowest_index(self):
        g = self.groups([node(0.0, ways=[1]), node(30.0, ways=[1]), node(1000.0), node(1030.0)])
        self.assertEqual(g, [[0, 1], [2, 3]])

    def test_a_large_chain_does_not_blow_up(self):
        """The linear path: 4000 nodes, 120 m apart, one way. An O(n^2) closure would be 16M pairs."""
        nodes = [node(i * 120.0, ways=[7]) for i in range(4000)]
        g = self.groups(nodes)
        self.assertEqual(len(g), 1)
        self.assertEqual(len(g[0]), 4000)

    def test_grid_boundaries_do_not_split_a_group(self):
        """A pair straddling a shared_r cell edge must still be found: the BFS looks at 3x3 cells."""
        # cell edge at 140 m; place both just either side of it, related by distance
        self.assertEqual(self.groups([node(139.0), node(141.0)]), [[0, 1]])
        # and just either side of the corner of a cell, related by a shared way
        self.assertEqual(self.groups([node(139.0, 139.0, ways=[7]), node(141.0, 141.0, ways=[7])]), [[0, 1]])


if __name__ == "__main__":
    unittest.main()
