"""The dead-end lookup is split into chunks, because one query over a big world is over a megabyte.

`network.dead_ends` asks Overpass for the tags of every chain-end node in the world in a single
`node(id:…)` lookup. dc-maryland-nova-suburbs listed ~110k ids — past the 1 MB body nginx in front
of overpass-na accepts — so the instance answered HTTP 413 and the bake fell to a public mirror
(2026-10-11, `overpass-api.de` in the cache sidecar). The ids now go out in batches; these pin that
the batching happens, that no query carries more than `DEAD_END_ID_CHUNK` ids, and that every end is
still asked about exactly once.

    bake/.venv/bin/python -m unittest tests.test_dead_ends_chunk
"""
from __future__ import annotations

import re
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from shapely.geometry import LineString

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from piedmont_bake import network, osm  # noqa: E402
from piedmont_bake.geo import Frame  # noqa: E402

LON, LAT = -76.685, 39.007
FRAME = Frame.at(LON, LAT)


def _chains(n: int) -> list[dict]:
    """`n` one-way chains, each contributing two distinct end nodes (head and tail)."""
    chains = []
    for i in range(n):
        head, tail = i * 2, i * 2 + 1
        chains.append({
            "ways": [{"id": head, "nodes": [head, tail]}],
            "line": LineString([(0.0, 0.0), (10.0, 0.0)]),
            "highway": "residential",
        })
    return chains


def _ids(query: str) -> list[int]:
    m = re.search(r"node\(id:([^)]*)\)", query)
    return [int(x) for x in m.group(1).split(",")] if m and m.group(1) else []


class DeadEndChunkTest(unittest.TestCase):
    def _run(self, n_chains: int, chunk: int):
        chains = _chains(n_chains)
        seen: list[str] = []

        def fake_overpass(q: str, _cache):
            seen.append(q)
            return {"elements": []}

        with tempfile.TemporaryDirectory() as tmp, \
                mock.patch.object(osm, "overpass", fake_overpass), \
                mock.patch.object(network, "DEAD_END_ID_CHUNK", chunk):
            network.dead_ends(chains, FRAME, Path(tmp), 5000.0, LAT, LON)
        return chains, seen

    def test_one_query_per_chunk_and_no_chunk_over_the_limit(self):
        n_chains, chunk = 12, 5
        _chains_, seen = self._run(n_chains, chunk)
        self.assertEqual(len(seen), 5)  # 24 ends -> 5+5+5+5+4
        for q in seen:
            self.assertLessEqual(len(_ids(q)), chunk)

    def test_every_end_is_asked_about_exactly_once(self):
        n_chains, chunk = 12, 5
        _chains_, seen = self._run(n_chains, chunk)
        asked: list[int] = []
        for q in seen:
            asked.extend(_ids(q))
        self.assertEqual(len(asked), 2 * n_chains)
        self.assertEqual(sorted(asked), sorted(set(asked)))  # no end in two chunks

    def test_a_world_under_one_chunk_is_still_a_single_query(self):
        _, seen = self._run(2, network.DEAD_END_ID_CHUNK)
        self.assertEqual(len(seen), 1)


if __name__ == "__main__":
    unittest.main()
