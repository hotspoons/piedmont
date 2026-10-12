"""Tile-sets for the network: the unit of an area bake, and the end of the global spine.

WHY. A sharded bake shards the *rasters* (see `shards.py`) but keeps the *network* one global object:
`roads()` queries the whole region, `intersections` keys every node of the world, `grade.RoadModel`
holds a station every few metres along the whole spine. That is fine for a metro and is the ceiling
for a country. `docs/dev/specs/PLAN-TILED-NETWORK.md` replaces the global network with **tile-sets**.

WHAT A TILE-SET IS. A square block of the 1 km world tile grid, `SET_M` a side (default 4 km). It is
aligned to multiples of `SET_M` on the same UTM origin the tiles use, so a tile-set boundary always
falls on a 1 km tile boundary. A tile-set owns the **segments** of every chain that fall in it — cut
at the seams — and carries a **halo** (`HALO_M`) of its neighbours' segments so a decision that
straddles a seam is still made with both sides.

This module is the pure geometry: the grid, the halo, and cutting a line at the seams. It changes no
consumer yet; the migration is staged in the plan.
"""

from __future__ import annotations

import math

from shapely.geometry import LineString, MultiLineString, Point, box as shp_box
from shapely.ops import split as _split

TILE_M = 1000.0
# The block a tile-set is: 4 x 4 km, matching the shard block scale. A multiple of TILE_M, so seams
# land on tile boundaries.
DEFAULT_SET_M = 4000.0
# How far past its own rectangle a tile-set may look. Must be >= every consumer's reach (lidar half
# width, CLUSTER_R, SIGNAL_SNAP, the walkways zone buffer); `shards.DEFAULT_MARGIN_M` is the same 300
# so the two grids agree when a shard and a tile-set are aligned.
DEFAULT_HALO_M = 300.0

# Coordinates closer than this to a seam are treated as on it (metres; UTM is ~1 m resolution).
_EPS = 1e-6


def tilesets(bbox: tuple[float, float, float, float],
             set_m: float = DEFAULT_SET_M) -> list[dict]:
    """`SET_M`-sided rectangles covering `bbox`, aligned to multiples of `SET_M`.

    Each entry is `{"index", "ix", "iy", "bbox"}`. The alignment (`floor(bbox[0] / set_m) * set_m`)
    makes a tile-set boundary land on a 1 km tile boundary, so seams and tiles agree.
    """
    x0 = math.floor(bbox[0] / set_m) * set_m
    y0 = math.floor(bbox[1] / set_m) * set_m
    nx = max(1, int(math.ceil((bbox[2] - x0) / set_m)))
    ny = max(1, int(math.ceil((bbox[3] - y0) / set_m)))
    out: list[dict] = []
    for iy in range(ny):
        for ix in range(nx):
            out.append({
                "index": len(out),
                "ix": ix,
                "iy": iy,
                "bbox": [x0 + ix * set_m, y0 + iy * set_m,
                         x0 + (ix + 1) * set_m, y0 + (iy + 1) * set_m],
            })
    return out


def tile_set_at(sets: list[dict], x: float, y: float) -> int:
    """The tile-set containing `(x, y)`, or the nearest one if it is outside the covered bbox."""
    best, best_d = None, None
    for s in sets:
        sx0, sy0, sx1, sy1 = s["bbox"]
        if sx0 <= x < sx1 and sy0 <= y < sy1:
            return int(s["index"])
        dx = max(sx0 - x, 0.0, x - sx1)
        dy = max(sy0 - y, 0.0, y - sy1)
        d = dx * dx + dy * dy
        if best_d is None or d < best_d:
            best_d, best = d, s["index"]
    return int(best)


def halo_rect(rect: list[float], halo_m: float = DEFAULT_HALO_M) -> list[float]:
    """`[x0, y0, x1, y1]` grown by `halo_m` a side."""
    x0, y0, x1, y1 = rect
    return [x0 - halo_m, y0 - halo_m, x1 + halo_m, y1 + halo_m]


def _seams_within(line, sets: list[dict]) -> list[LineString]:
    """The vertical and horizontal seam segments the line's interior actually crosses.

    Only seams strictly inside the line's bbox are used, so the seam segments reach past both ends
    and every crossing is a clean two-way intersection rather than a degenerate touch at an endpoint.
    """
    xs = sorted({s["bbox"][0] for s in sets} | {s["bbox"][2] for s in sets})
    ys = sorted({s["bbox"][1] for s in sets} | {s["bbox"][3] for s in sets})
    minx, miny, maxx, maxy = line.bounds
    seams: list[LineString] = []
    for x in xs:
        if minx + _EPS < x < maxx - _EPS:
            seams.append(LineString([(x, miny - 1.0), (x, maxy + 1.0)]))
    for y in ys:
        if miny + _EPS < y < maxy - _EPS:
            seams.append(LineString([(minx - 1.0, y), (maxx + 1.0, y)]))
    return seams


def cut_line(line, sets: list[dict]) -> list[dict]:
    """Cut `line` at every tile-set seam, returning one piece per tile-set it passes through.

    Each piece is `{"tileset", "s0", "s1", "geom"}` where `s0`/`s1` are the piece's along-line metres
    on the ORIGINAL line (so a profile keyed by `s` still lines up). The pieces tile the line: their
    `s`-ranges are contiguous and share the seam point exactly, so two tilesets never disagree about
    where the road is. A line wholly inside one tile-set is returned as one piece, untouched.
    """
    if line is None or line.is_empty or float(line.length) <= 0.0:
        return []
    seams = _seams_within(line, sets)
    if not seams:
        pieces = [line]
    else:
        parts = _split(line, MultiLineString(seams))
        pieces = [g for g in parts.geoms if g.geom_type == "LineString" and float(g.length) > 0.0]

    out: list[dict] = []
    for g in pieces:
        coords = list(g.coords)
        s0 = float(line.project(Point(coords[0])))
        s1 = float(line.project(Point(coords[-1])))
        mid = g.interpolate(0.5, normalized=True)
        out.append({
            "tileset": tile_set_at(sets, mid.x, mid.y),
            "s0": min(s0, s1),
            "s1": max(s0, s1),
            "geom": g,
        })
    # Deterministic order along the original line, so a tile-set's segments are written start-first.
    out.sort(key=lambda p: (p["s0"], p["s1"]))
    return out


def cut_chains(chains: list[dict], sets: list[dict]) -> dict[int, list[dict]]:
    """Cut every chain at the seams, grouped by the tile-set that owns each piece.

    `chains` is any sequence of `{"id", "line"}`. The result maps a tile-set index to its owned
    pieces, each carrying `chain` (the id) alongside `cut_line`'s fields.
    """
    out: dict[int, list[dict]] = {}
    for c in chains:
        for p in cut_line(c["line"], sets):
            p = dict(p, chain=str(c["id"]))
            out.setdefault(int(p["tileset"]), []).append(p)
    return out


def assign(chains: list[dict], sets: list[dict],
           halo_m: float = DEFAULT_HALO_M) -> dict[int, dict]:
    """Per tile-set: the segments it owns, and the neighbours' segments inside its halo.

    `owned` is `cut_chains`'s entry. `context` is every piece another tile-set owns whose geometry
    reaches into this tile-set's halo — what a junction, a priority decision, a route grouping or a
    walkway zone at the seam needs to see. Context is read-only: a tile-set never writes a piece it
    does not own, so a feature exactly on a seam is still produced exactly once.
    """
    owned = cut_chains(chains, sets)
    out: dict[int, dict] = {}
    for s in sets:
        idx = int(s["index"])
        halo = shp_box(*halo_rect(s["bbox"], halo_m))
        context: list[dict] = []
        for o in sets:
            oi = int(o["index"])
            if oi == idx:
                continue
            for p in owned.get(oi, []):
                if p["geom"].intersects(halo):
                    context.append(p)
        out[idx] = {"owned": owned.get(idx, []), "context": context}
    return out
