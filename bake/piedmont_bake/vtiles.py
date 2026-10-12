"""Coarse vector tiles: the distance-reading layers, reduced and tiled beside `vt/0`.

WHY. `export._vector_tiles` writes ONE flat level of ~1 km cells carrying every feature. Zoomed out,
the editor's map and any flag-scale view still fetch and draw all of them — high-resolution vectors
spanning coast to coast, which is the wrong thing to draw from 100 km up and blows the tile budget
doing it. `vectorlod` is the reduction (which classes survive at which level, dissolve-by-identity, a
length gate, a decimate to the tile's scale); this module TILES it: it gathers the layers, assigns
each feature to the coarse cells it crosses, reduces per cell, and writes `web/vt/<z>/`.

THE SAME KEY SPACE AS `vt/0`, deliberately. A vector tile here is a SITE-METRE cell — a footprint at
(x, y) lives in `(floor(x / cell_m), floor(y / cell_m))`, exactly where the viewer buckets and where
`vt/0` already keys — and a coarse tile is a PARTIAL MANIFEST carrying the manifest's own field names
(`branches`, `trails`, `rail`, `water.lines`) and its own record shape (`coords`/`pts`). That is what
makes the viewer adopt it for free: `loadVectorTile` and the editor map's parser read a coarse tile
and a `vt/0` tile the same way. (The plan sketched a geographic quadtree key, "beside the raster
tile"; the viewer's vector stream has never been geographic, so keying it that way would mean a
second key space in the browser. The LEVEL is still a quadtree z, so the scale is the same.)

A LEVEL IS A QUADTREE z. `z14 ≈ 1 km` is the `vt/0` leaf; a coarser level `z` carries `cell_m =
size_m · 2^(14−z)` (z13 2 km, z12 4 km, z11 8 km, …), which is the same physical scale as the raster
tile at that z. `vectorlod`'s class/length tables are keyed on that z.

WHAT IS IN A COARSE TILE: the four layers that read at distance — streams, trails, rail, roads.
Trails and streams are never dropped for being minor; they are length- and name-gated, so a long
trail or river still crosses a coarse tile.

Additive: nothing here removes `vt/0`, and a tree without `vt.levels` is read exactly as before.
"""

from __future__ import annotations

import json
import shutil
from pathlib import Path

from shapely.geometry import LineString

from . import vectorlod

#: Which manifest array each layer comes from. Roads are the drivable `branches`; streams are
#: `water.lines`; trails and rail are their own layers (see export._paths).
SOURCE: dict[str, tuple[str, ...]] = {
    "roads": ("branches",),
    "trails": ("trails",),
    "rail": ("rail",),
    "streams": ("water", "lines"),
}
#: The coord key each source uses — `branches`/`trails`/`rail` carry `coords`, `water.lines` `pts`.
COORDS: dict[str, str] = {"roads": "coords", "trails": "coords", "rail": "coords", "streams": "pts"}
#: The manifest field a layer is written back under, and the coord key there. A coarse tile is a
#: partial manifest, so the viewer spreads it over the full one exactly like a `vt/0` tile.
OUT_FIELD: dict[str, tuple[str, ...]] = {
    "roads": ("branches",),
    "trails": ("trails",),
    "rail": ("rail",),
    "streams": ("water", "lines"),
}
OUT_COORDS: dict[str, str] = {"roads": "coords", "trails": "coords", "rail": "coords", "streams": "pts"}
#: The class/kind key, kept as the manifest names it.
CLASS_KEY: dict[str, str] = {"roads": "highway", "trails": "kind", "rail": "kind", "streams": "kind"}

#: The leaf level: `vt/0` is ~1 km cells, so a coarse level `z`'s cell is `size_m · 2^(LEAF_Z − z)`.
LEAF_Z = 14


def cell_m_for(z: int, size_m: float = 1000.0) -> float:
    """The side of a coarse cell at level `z`, metres (`vt/0`'s cell is `size_m` at `LEAF_Z`)."""
    return float(size_m) * float(2 ** max(0, LEAF_Z - z))


def _line(coords) -> LineString | None:
    pts = [(float(c[0]), float(c[1])) for c in (coords or []) if len(c) >= 2]
    return LineString(pts) if len(pts) >= 2 else None


def gather(arrays: dict) -> dict[str, list[dict]]:
    """The four coarse layers, as `vectorlod` features (`{"id","name","ref",<class>,"line"}` in m).

    A source array that is absent or empty contributes nothing. A line with fewer than two points is
    skipped: a one-point "line" is a bad record, not a feature.
    """
    out: dict[str, list[dict]] = {layer: [] for layer in vectorlod.LAYERS}
    for layer, path in SOURCE.items():
        if len(path) == 1:
            items = arrays.get(path[0]) or []
        else:
            items = (arrays.get(path[0]) or {}).get(path[1]) or []
        key = COORDS[layer]
        for it in items:
            line = _line(it.get(key))
            if line is None:
                continue
            out[layer].append({
                "id": it.get("id"), "name": it.get("name"), "ref": it.get("ref"),
                "highway": it.get("highway"), "kind": it.get("kind"), "line": line,
            })
    return out


def assign(features: dict[str, list[dict]], z: int, size_m: float = 1000.0) -> dict[tuple[int, int], dict[str, list[dict]]]:
    """Every feature assigned to every coarse cell at level `z` whose square it crosses.

    A feature lands in ALL the cells it touches (a long highway is in each), because a coarse tile
    that omitted a road merely passing through would draw a road that stops at its edge. The same
    feature in two cells is reduced twice; a per-cell dissolve is what makes each reduction see a
    whole feature rather than the stub that fits in the cell.
    """
    cell = cell_m_for(z, size_m)
    cells: dict[tuple[int, int], dict[str, list[dict]]] = {}
    for layer in vectorlod.LAYERS:
        for f in features.get(layer, []):
            x0, y0, x1, y1 = f["line"].bounds
            for ix in range(int(x0 // cell), int(x1 // cell) + 1):
                for iy in range(int(y0 // cell), int(y1 // cell) + 1):
                    cells.setdefault((ix, iy), {}).setdefault(layer, []).append(f)
    return cells


def _feature_doc(layer: str, f: dict) -> dict:
    """One reduced feature, in the manifest's site-metre vocabulary and nothing more."""
    xys = [[round(float(x), 1), round(float(y), 1)] for x, y in f["line"].coords]
    doc: dict = {}
    for k in ("id", "name", "ref"):
        if f.get(k) is not None:
            doc[k] = f[k]
    cls = f.get(CLASS_KEY[layer])
    if cls is not None:
        doc[CLASS_KEY[layer]] = cls
    doc[OUT_COORDS[layer]] = xys
    return doc


def _place(cell: dict, layer: str, docs: list[dict]) -> None:
    """Put a layer's reduced docs at its manifest path in the cell (`water.lines` is nested)."""
    path = OUT_FIELD[layer]
    node = cell
    for seg in path[:-1]:
        node = node.setdefault(seg, {})
    node[path[-1]] = docs


def build_level(features: dict[str, list[dict]], z: int, size_m: float = 1000.0) -> dict[tuple[int, int], dict]:
    """The reduced cells for one level: `(ix,iy) -> partial manifest`. Empty cells are dropped.

    The cell's own side (in metres) sets the decimate tolerance, so a coarser level carries coarser
    vertices.
    """
    edge = cell_m_for(z, size_m)
    cells: dict[tuple[int, int], dict] = {}
    for (ix, iy), by_layer in assign(features, z, size_m).items():
        cell: dict = {}
        for layer in vectorlod.LAYERS:
            reduced = vectorlod.coarse_layer(layer, by_layer.get(layer, []), z, edge)
            if reduced:
                _place(cell, layer, [_feature_doc(layer, f) for f in reduced])
        if cell:
            cells[(ix, iy)] = cell
    return cells


def levels_for(zmin: int, zmax: int) -> list[int]:
    """The levels that get a coarse bundle: the pyramid's coarse end, below `FINEST_FULL_LEVEL`.

    The leaf and its neighbours (`>= FINEST_FULL_LEVEL`) are the full `vt/0` population; a coarse
    bundle there would be a second copy of it. A site whose pyramid is all leaf returns nothing.
    """
    top = min(zmax, vectorlod.FINEST_FULL_LEVEL - 1)
    return [z for z in range(zmin, top + 1)] if top >= zmin else []


def write_levels(web: Path, arrays: dict, zmin: int, zmax: int, size_m: float = 1000.0) -> dict:
    """Write `web/vt/<z>/<ix>_<iy>.json` for each coarse level, and return the `vt.levels` index.

    The bundle is written into `vt/<z>/`, beside `vt/0/` (the flat 1 km level), and the index is what
    the manifest carries so a consumer can find a level and its cells without listing a directory.
    """
    levels = levels_for(zmin, zmax)
    if not levels:
        return {}
    features = gather(arrays)
    if not any(features.values()):
        return {}
    root = web / "vt"
    index: dict = {}
    for z in levels:
        cells = build_level(features, z, size_m)
        d = root / str(z)
        if d.exists():
            shutil.rmtree(d)
        d.mkdir(parents=True, exist_ok=True)
        rows = []
        for (ix, iy) in sorted(cells):
            cell = cells[(ix, iy)]
            (d / f"{ix}_{iy}.json").write_text(json.dumps(cell, separators=(",", ":")))
            rows.append({"x": ix, "y": iy, "n": sum(len(v) if isinstance(v, list) else sum(len(w) for w in v.values()) for v in cell.values())})
        index[str(z)] = {"cell_m": cell_m_for(z, size_m), "tiles": rows, "count": sum(r["n"] for r in rows)}
    return index
