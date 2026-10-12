"""Low-detail vectors for the coarse tiles: which features survive at which LOD, layer by layer.

THE PROBLEM. The bake's vector tiles are one flat level of ~1 km cells carrying EVERY feature (see
`export._vector_tiles`). Zoomed out, the editor's map and any flag-scale view still have to fetch and
draw all of them — high-resolution vectors spanning coast to coast, which is the wrong thing to draw
from 100 km up and blows the tile budget doing it.

THE SHAPE, lifted from trailworks (`pipeline/bake/tiles.py`). A coarse tile carries the layers that
read at distance, reduced as the tile grows. trailworks keeps
`LOD_OVERLAYS = (streams, routes, roads_major, trails, admin, boundaries)` — the trails never vanish,
"per the prime directive" — and controls volume per layer, not by dropping layers:

  * per-LOD road CLASSES — `_LOD_ROAD_CLASSES = {2: {motorway, trunk, primary}, 3: {motorway, trunk}}`;
  * ways DISSOLVED by identity (`ref`/`name`) into whole features before any length gate, because OSM
    arrives as hundreds of tiny fragments of one road and "length" only means anything after the merge;
  * a MINIMUM FEATURE LENGTH per layer per level (`_LOD_MIN_LEN_M`) and NAME-ONLY, so a clog of lanes
    or unnamed creeks cannot drag a tile;
  * geometry DECIMATED to the tile's own pixel scale (`simplify = max(1, px*0.75)`).

HERE the level is piedmont's quadtree `z` (`pyramid.tile_bounds`): z14 is the ~1 km leaf, z11 ~10 km,
z8 ~80 km. The layers are the ones piedmont bakes: **roads** (the drivable `branches`), **trails**
(`path`/`footway`/`cycleway`/…, carried in `sidewalks` by `kind`), **rail** (also a `sidewalks` kind),
and **streams** (`water.lines`). Trails must never vanish at a coarse level; they are length- and
name-gated instead. A coarse tile may drop a feature, never invent one, and the viewer can always
descend a level for the full set.
"""

from __future__ import annotations

from dataclasses import dataclass

from shapely.ops import linemerge

#: Major-first road class order; lower is more important (matches `intersections.RANK`).
RANK: dict[str, int] = {
    "motorway": 0, "trunk": 1, "primary": 2, "secondary": 3, "tertiary": 4,
    "unclassified": 5, "residential": 6, "living_street": 7, "service": 8,
}

#: Levels >= this keep every class in every layer (the leaf and its neighbours).
FINEST_FULL_LEVEL = 12
#: Levels <= this apply the coarsest rule; the tables below are keyed on the levels between.
COARSEST_LEVEL = 8
#: From this level up (coarser), a line must carry a `name` or a `ref` — a nameless fragment does not
#: read from altitude. Matches trailworks' `ln.get("name")` gate on every coarse layer.
NAME_ONLY_FROM = 11

#: How a coarse tile is rasterised for the simplify budget: a vector tile drawn this many pixels a
#: side, so the tolerance is about one pixel of the drawn tile.
VECTOR_PX = 512.0


@dataclass(frozen=True)
class LayerSpec:
    """How one layer is reduced as the tile grows."""
    class_field: str                     # the key carrying the class/kind (e.g. `highway`, `kind`)
    classes_by_level: dict[int, set[str]]  # level -> classes kept once gated (empty = never gated)
    dissolve_keys: tuple[str, ...]        # identity, first key present wins
    min_len_by_level: dict[int, float]    # level -> shortest feature kept


#: The layers a coarse tile ships, and their reduction. `roads` gate by class; the three others keep
#: every kind (a trail or a stream is never dropped for being "minor"), so their volume control is
#: the length and name gates alone.
SPEC: dict[str, LayerSpec] = {
    "roads": LayerSpec(
        "highway",
        {
            8: {"motorway"},
            9: {"motorway", "trunk"},
            10: {"motorway", "trunk", "primary"},
            11: {"motorway", "trunk", "primary", "secondary"},
        },
        ("ref", "name"),
        {8: 12000.0, 9: 5000.0, 10: 2000.0, 11: 750.0},
    ),
    "trails": LayerSpec(
        "kind", {}, ("name",),
        {8: 8000.0, 9: 3000.0, 10: 1500.0, 11: 500.0},
    ),
    "rail": LayerSpec(
        "kind", {}, ("name", "ref"),
        {8: 8000.0, 9: 3000.0, 10: 1500.0, 11: 500.0},
    ),
    "streams": LayerSpec(
        "kind", {}, ("name",),
        {8: 30000.0, 9: 10000.0, 10: 4000.0, 11: 1500.0},
    ),
}

#: The coarse layer set, in draw order: water under, roads over.
LAYERS: tuple[str, ...] = ("streams", "trails", "rail", "roads")


def _gated(level: int) -> bool:
    return level < FINEST_FULL_LEVEL


def classes_for(layer: str, level: int) -> set[str] | None:
    """The classes kept for `layer` at `level`, or `None` for every kind (the fine levels, or a
    layer that is never class-gated)."""
    spec = SPEC[layer]
    if not spec.classes_by_level or not _gated(level):
        return None
    if level <= COARSEST_LEVEL:
        return set(spec.classes_by_level[COARSEST_LEVEL])
    return set(spec.classes_by_level[level])


def min_len_for(layer: str, level: int) -> float:
    """The shortest feature kept for `layer` at `level` (metres); 0 at the fine levels."""
    spec = SPEC[layer]
    if not _gated(level):
        return 0.0
    if level <= COARSEST_LEVEL:
        return spec.min_len_by_level[COARSEST_LEVEL]
    return spec.min_len_by_level.get(level, 0.0)


def simplify_for(edge_m: float, px: float = VECTOR_PX) -> float:
    """Douglas-Peucker tolerance for a tile `edge_m` a side drawn `px` across, floored at 1 m.

    About a pixel of the drawn tile, so coarser tiles carry coarser vertices (trailworks scales the
    same way: `max(1.0, px * 0.75)` against the tile's raster pixel size).
    """
    return max(1.0, abs(float(edge_m)) / max(1.0, float(px)))


def _len_m(line) -> float:
    try:
        return float(line.length)
    except Exception:
        return 0.0


def keep(layer: str, feature: dict, level: int) -> bool:
    """Whether a feature survives at `level`: its class (when the layer gates), and a name once the
    level is coarse enough."""
    spec = SPEC[layer]
    classes = classes_for(layer, level)
    if classes is not None and str(feature.get(spec.class_field) or "") not in classes:
        return False
    if _gated(level) and level <= NAME_ONLY_FROM:
        return bool(feature.get("name") or feature.get("ref"))
    return True


def _identity(spec: LayerSpec, feature: dict):
    for k in spec.dissolve_keys:
        v = feature.get(k)
        if v:
            return v
    return None


def _dissolve(spec: LayerSpec, features: list[dict]) -> list[dict]:
    """Merge fragments of one feature by identity, so a length gate sees the whole thing, not a stub.

    Identity is `(class, ref or name)`. Within a tile two features sharing a name but not a ref would
    still merge, which is the price trailworks pays too; scoping by class keeps an arterial from
    absorbing a service road of the same name.
    """
    groups: dict[tuple, dict] = {}
    for f in features:
        key = (str(f.get(spec.class_field) or ""), _identity(spec, f))
        groups.setdefault(key, {"props": dict(f), "geoms": []})["geoms"].append(f["line"])
    out: list[dict] = []
    for grp in groups.values():
        geoms = grp["geoms"]
        try:
            merged = linemerge(geoms) if len(geoms) > 1 else geoms[0]
        except Exception:
            merged = None
        if merged is None:
            parts = geoms
        elif merged.geom_type == "LineString":
            parts = [merged]
        else:
            parts = list(merged.geoms)
        for p in parts:
            out.append({**{k: grp["props"].get(k) for k in ("id", "name", "ref", spec.class_field)},
                        "line": p})
    return out


def _simplify(line, tol: float):
    try:
        return line.simplify(tol, preserve_topology=False)
    except Exception:
        return line


def _order(layer: str, f: dict):
    spec = SPEC[layer]
    rank = RANK.get(str(f.get(spec.class_field) or ""), 5) if layer == "roads" else 0
    return (rank, str(f.get("name") or f.get("ref") or ""), str(f.get("id") or ""))


def coarse_layer(layer: str, features: list[dict], level: int, edge_m: float) -> list[dict]:
    """The features of `layer` to ship in a tile at `level` (`edge_m` a side).

    Fine levels (`>= FINEST_FULL_LEVEL`) return the input simplified and otherwise untouched, so a
    leaf tile and the existing 1 km `vt/0` agree. Coarse levels gate by class (roads), require a name,
    dissolve the survivors by identity, drop anything now shorter than the level's minimum, and
    decimate to the tile's scale. Order is stable so two bakes are identical.
    """
    spec = SPEC[layer]
    tol = simplify_for(edge_m)
    if not _gated(level):
        return [{**{k: f.get(k) for k in ("id", "name", "ref", spec.class_field)},
                 "line": _simplify(f["line"], tol)} for f in features]

    kept = [f for f in features if keep(layer, f, level)]
    minlen = min_len_for(layer, level)
    out: list[dict] = []
    # A layer that is never class-gated and has no near feature to merge can skip the dissolve; but
    # doing it always keeps one code path and one length semantics.
    for f in _dissolve(spec, kept):
        if minlen > 0.0 and _len_m(f["line"]) < minlen:
            continue
        f["line"] = _simplify(f["line"], tol)
        out.append(f)
    out.sort(key=lambda f: _order(layer, f))
    return out


def coarse_roads(features: list[dict], level: int, edge_m: float) -> list[dict]:
    """Roads for a coarse tile — `coarse_layer("roads", …)`."""
    return coarse_layer("roads", features, level, edge_m)
