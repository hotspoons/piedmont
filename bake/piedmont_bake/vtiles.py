"""Coarse vector tiles: the distance-reading layers, reduced and tiled beside the raster pyramid.

WHY. `export._vector_tiles` writes ONE flat level of ~1 km tiles carrying every feature. Zoomed out,
the editor's map and any flag-scale view still fetch and draw all of them — high-resolution vectors
spanning coast to coast, which is the wrong thing to draw from 100 km up and blows the tile budget
doing it. `vectorlod` is the reduction (which classes survive at which level, dissolve-by-identity,
a length gate, a decimate to the tile's scale); this module TILES it: it gathers the layers,
assigns each feature to the pyramid tiles it crosses, reduces per tile, and writes `web/vt/<z>/`.

THE TILE IS THE RASTER TILE. A coarse vector tile is keyed by the same `pyramid` quadtree (z, x, y)
as the DEM/NAIP tile beside it, so the viewer already knows which one it wants for a given eye. The
geometry inside stays in SITE METRES, the same space `vt/0` and the rest of the manifest use, so a
consumer draws it without a frame conversion.

WHAT IS IN A COARSE TILE: the four layers that read at distance — `streams`, `trails`, `rail`,
`roads` (`vectorlod.LAYERS`, in draw order). Trails and streams are never dropped for being minor;
they are length- and name-gated, so a long trail or river still crosses a coarse tile.

This is additive: nothing here removes `vt/0`, and a tree without `vt.levels` is read exactly as
before (the viewer's coarse path is the adoption still to come — see PLAN-TILED-NETWORK Phase 4b).
"""

from __future__ import annotations

import json
import shutil
from pathlib import Path

import numpy as np
from shapely.geometry import LineString

from . import grade, pyramid, vectorlod

#: Which manifest array each coarse layer comes from. Roads are the drivable `branches`; streams are
#: `water.lines`; trails and rail are their own layers (see export._paths).
SOURCE: dict[str, tuple[str, ...]] = {
    "roads": ("branches",),
    "trails": ("trails",),
    "rail": ("rail",),
    "streams": ("water", "lines"),
}
#: The coord key each source uses — `branches`/`trails`/`rail` carry `coords`, `water.lines` `pts`.
COORDS: dict[str, str] = {"roads": "coords", "trails": "coords", "rail": "coords", "streams": "pts"}


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


def _wgs_bbox(frame, line: LineString) -> tuple[float, float, float, float]:
    """The WGS84 bbox of a feature whose geometry is site metres.

    Site metres are true ENU about the site anchor, NOT UTM, so `Frame.to_wgs` cannot be applied to
    them directly (it expects UTM — the convergence error would be hundreds of metres over a county).
    `grade.enu_to_utm` is the exact inverse of the bake's ENU choke point; WGS from there is right.
    """
    xs, ys = line.xy
    ux, uy = grade.enu_to_utm(frame, list(xs), list(ys))
    lon, lat = frame.to_wgs(ux, uy)
    return (float(np.min(lon)), float(np.min(lat)), float(np.max(lon)), float(np.max(lat)))


def assign(features: dict[str, list[dict]], frame, z: int) -> dict[tuple[int, int], dict[str, list[dict]]]:
    """Every feature assigned to every pyramid tile at `z` whose square it crosses.

    A feature lands in ALL the tiles it touches (a long highway is in each), because a coarse tile
    that omitted a road merely passing through would draw a road that stops at its edge. The same
    feature in two tiles is reduced twice; a per-tile dissolve is what makes each reduction see a
    whole feature rather than the stub that fits in the tile.
    """
    tiles: dict[tuple[int, int], dict[str, list[dict]]] = {}
    for layer in vectorlod.LAYERS:
        for f in features.get(layer, []):
            w, s, e, n = _wgs_bbox(frame, f["line"])
            for (x, y) in pyramid.tiles_over(z, w, s, e, n):
                tiles.setdefault((x, y), {}).setdefault(layer, []).append(f)
    return tiles


def _feature_doc(f: dict) -> dict:
    """One reduced feature, in the manifest's site-metre vocabulary and nothing more."""
    xys = [[round(float(x), 1), round(float(y), 1)] for x, y in f["line"].coords]
    doc = {"line": xys}
    for k in ("id", "name", "ref", "highway", "kind"):
        if f.get(k) is not None:
            doc[k] = f[k]
    return doc


def build_level(features: dict[str, list[dict]], frame, z: int, lat: float) -> dict[tuple[int, int], dict]:
    """The reduced cells for one level: `(x,y) -> {layer: [feature doc]}`. Empty cells are dropped.

    `lat` is the site's mid-latitude; the tile's own edge (in metres) sets the decimate tolerance,
    so a coarser level carries coarser vertices.
    """
    edge = max(pyramid.tile_metres(z, lat))
    cells: dict[tuple[int, int], dict] = {}
    for (x, y), by_layer in assign(features, frame, z).items():
        cell: dict[str, list[dict]] = {}
        for layer in vectorlod.LAYERS:
            reduced = vectorlod.coarse_layer(layer, by_layer.get(layer, []), z, edge)
            docs = [_feature_doc(f) for f in reduced]
            if docs:
                cell[layer] = docs
        if cell:
            cells[(x, y)] = cell
    return cells


def levels_for(zmin: int, zmax: int) -> list[int]:
    """The levels that get a coarse bundle: the pyramid's coarse end, below `FINEST_FULL_LEVEL`.

    The leaf and its neighbours (`>= FINEST_FULL_LEVEL`) are the full `vt/0` population; a coarse
    bundle there would be a second copy of it. A site whose pyramid is all leaf returns nothing.
    """
    top = min(zmax, vectorlod.FINEST_FULL_LEVEL - 1)
    return [z for z in range(zmin, top + 1)] if top >= zmin else []


def write_levels(web: Path, frame, arrays: dict, zmin: int, zmax: int, mid_lat: float) -> dict:
    """Write `web/vt/<z>/<x>_<y>.json` for each coarse level, and return the `vt.levels` index.

    The bundle is written into `vt/<z>/`, beside `vt/0/` (the flat 1 km level), and the index is
    what the manifest carries so a consumer can find the levels without listing the directory.
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
        cells = build_level(features, frame, z, mid_lat)
        d = root / str(z)
        if d.exists():
            shutil.rmtree(d)
        d.mkdir(parents=True, exist_ok=True)
        rows = []
        for (x, y) in sorted(cells):
            cell = cells[(x, y)]
            (d / f"{x}_{y}.json").write_text(json.dumps(cell, separators=(",", ":")))
            rows.append({"x": x, "y": y, "n": sum(len(v) for v in cell.values())})
        index[str(z)] = {"edge_m": round(max(pyramid.tile_metres(z, mid_lat)), 1),
                         "tiles": rows, "count": sum(r["n"] for r in rows)}
    return index
