"""A route site: SEVERAL long roads, bounded to a region, baked as one spine world.

WHY. A spine bake (I-95, I-70 with the metros along it) wants a long poly, and the plan says so
(PLAN-TILED-NETWORK.md): picking a route and ordering the places along it *is* a spine. A spine used
to be one road: `osm.spine` takes the nearest way to a photo and trims it to ±half-length. A route is
the many-road case — `refs` names several roads (`I 70`, `US 15`) and a `clip` ring bounds them to a
region (Maryland), so the bake follows them across a state instead of a circle around one point.

HOW IT BAKEs. A route is resolved to a **boundary**: for each ref, the longest chain within the clip,
clipped to the ring; the route is those joined in `refs` order; the boundary is the route buffered by
`half_width`. That boundary and the refs are handed to `network.fetch_site`, which already knows how
to build a multi-road world from a `roads` list and a `selection_polygon` — junctions, dead ends,
tile-sets, vectors and all. So the route ADDS a selector; it does not add a second world builder.

Frames: the `clip` ring and everything Overpass returns is WGS84; a resolved route is kept in the
site frame and written back to `boundary` as WGS84 lon/lat, the one thing that does not depend on the
render frame (docs/dev/frames.md).
"""
from __future__ import annotations

import json
from pathlib import Path

from shapely.geometry import LineString, Point, Polygon
from shapely.ops import substring, unary_union

from . import osm
from .geo import Frame


def clip_polygon(site: dict, frame: Frame) -> Polygon | None:
    """The region a route is bounded to, in the site frame, from a WGS84 `clip` (or `boundary`) ring."""
    ring = site.get("clip") or site.get("boundary") or []
    pts: list[tuple[float, float]] = []
    for p in ring:
        if isinstance(p, (list, tuple)) and len(p) >= 2:
            x, y = frame.from_wgs(float(p[0]), float(p[1]))
            pts.append((float(x), float(y)))
    if len(pts) < 3:
        return None
    poly = Polygon(pts)
    if not poly.is_valid:
        poly = poly.buffer(0)
    if poly.is_empty or poly.geom_type != "Polygon" or poly.area <= 0:
        return None
    return poly


def longest_line(geom) -> LineString | None:
    """The longest `LineString` in any geometry, or None. An intersection can be a point, a
    `MultiLineString`, or a `GeometryCollection`; only whole lines are roads."""
    if geom is None or geom.is_empty:
        return None
    if isinstance(geom, LineString):
        return geom
    lines: list[LineString] = []
    parts = geom.geoms if hasattr(geom, "geoms") else [geom]
    for g in parts:
        if isinstance(g, LineString):
            lines.append(g)
        elif hasattr(g, "geoms"):
            lines.extend(h for h in g.geoms if isinstance(h, LineString))
    return max(lines, key=lambda ln: ln.length) if lines else None


def clip_line(line: LineString, poly: Polygon | None) -> LineString | None:
    """`line` cut to `poly`, keeping the longest surviving run (None when it does not reach in)."""
    if poly is None:
        return line if line is not None and not line.is_empty else None
    if not line.intersects(poly):
        return None
    return longest_line(line.intersection(poly))


def _d2(a: tuple[float, float], b: tuple[float, float]) -> float:
    return (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2


def trim_line(line: LineString, cut, frame: Frame) -> LineString | None:
    """`line` cut to the stretch between two WGS84 anchor points, each projected onto it.

    The editor stores a trim as the POINTS the person clicked, not as metres along a chain: the
    bake's chain of a ref (the longest one inside the clip) is not necessarily the one on screen.
    Projecting the anchors onto this line is what makes the trim land where the person meant. A
    missing or unreadable cut, or one that projects to a sliver, leaves the whole line.
    """
    if not cut or len(cut) != 2:
        return line
    try:
        a = frame.from_wgs(float(cut[0][0]), float(cut[0][1]))
        b = frame.from_wgs(float(cut[1][0]), float(cut[1][1]))
    except (TypeError, IndexError, ValueError):
        return line
    da = line.project(Point(a))
    db = line.project(Point(b))
    lo, hi = (da, db) if da <= db else (db, da)
    if hi - lo < 1.0:
        return line
    return substring(line, lo, hi)


def join_refs(order: list[str], lines: dict[str, LineString]) -> LineString | None:
    """Concatenate per-ref lines in `order`, flipping each so consecutive ends meet.

    A route is one poly for the world to hold; two refs that cross (I-70 and US-15 meet near
    Frederick) still join, the join being the shortest way in. A ref with no line is skipped, so a
    route one of whose roads is missing still bakes the rest.
    """
    out: list[tuple[float, float]] = []
    for r in order:
        ln = lines.get(r)
        if ln is None or ln.is_empty:
            continue
        pts = [tuple(c) for c in ln.coords]
        if out and len(pts) >= 2:
            if _d2(pts[0], out[-1]) > _d2(pts[-1], out[-1]):
                pts = pts[::-1]
            if pts and _d2(pts[0], out[-1]) < 1e-9:
                pts = pts[1:]
        out.extend(pts)
    return LineString(out) if len(out) >= 2 else None


def boundary_of(lines: list[LineString], half_width: float) -> Polygon | None:
    """The route's world: the union of the lines buffered by `half_width`."""
    bufs = [ln.buffer(half_width, cap_style="flat") for ln in lines if ln is not None and not ln.is_empty]
    if not bufs:
        return None
    u = unary_union(bufs)
    if u.is_empty:
        return None
    if u.geom_type == "MultiPolygon":
        u = max(u.geoms, key=lambda g: g.area)
    return u if u.geom_type == "Polygon" else None


def to_wgs_ring(poly: Polygon, frame: Frame) -> list[list[float]]:
    """A polygon's exterior as a WGS84 `[[lon, lat], …]` ring (the frame-independent authority)."""
    ext = poly.exterior if poly.geom_type == "Polygon" else poly.geoms[0].exterior
    xs = [c[0] for c in ext.coords]
    ys = [c[1] for c in ext.coords]
    lon, lat = frame.to_wgs(xs, ys)
    return [[round(float(lo), 7), round(float(la), 7)] for lo, la in zip(lon, lat)]


_RE_META = ".^$*+?()[]{}|\\"


def _esc(v: str) -> str:
    """Escape a road name or ref for Overpass's regex, which is POSIX ERE and unanchored by default."""
    return "".join("\\" + c if c in _RE_META else c for c in str(v))


def way_keys(way: dict) -> set[str]:
    """Every name a way could be asked for by: each `ref` split on `;`, and its `name`.

    The editor labels a road `name || ref` (services/worldeditor/layers.mjs), so a route picked on
    the map carries the NAME when a road has one, while a hand-written site in `sites.json` names
    the `ref` ("I 70"). Matching both is what lets either name the same road.
    """
    tags = way.get("tags") or {}
    keys = {p.strip() for p in str(tags.get("ref") or "").split(";") if p.strip()}
    name = str(tags.get("name") or "").strip()
    if name:
        keys.add(name)
    return keys


def fetch_ref_lines(refs: list[str], clip: Polygon, frame: Frame, cache: Path) -> dict[str, LineString]:
    """The longest chain of each ref within the clip, clipped to it. One Overpass query for all refs.

    A `ref` here is a route name in either sense the two callers use: the OSM `ref` (`I 70`) or the
    road's `name` (what the editor stores). The query matches either tag, and a returned way is
    filed under every key that matches (`way_keys`).
    """
    minx, miny, maxx, maxy = clip.bounds
    w, s, e, n = frame.bbox_wgs(minx, miny, maxx, maxy)
    alt = "|".join(_esc(r) for r in sorted(set(refs)))
    # `[~"^(ref|name)$"~...]` is Overpass's any-tag matcher: the road's ref OR its name.
    q = f'[out:json][timeout:300];way({s},{w},{n},{e})[highway][~"^(ref|name)$"~"(^|;)({alt})(;|$)"];out geom;'
    ways = [x for x in osm.overpass(q, cache)["elements"] if x.get("geometry") and x.get("nodes")]
    by_ref: dict[str, list[dict]] = {}
    for wy in ways:
        for r in way_keys(wy):
            if r in refs:
                by_ref.setdefault(r, []).append(wy)
    from . import network  # local: network imports this module's siblings, avoid a cycle at import

    lines: dict[str, LineString] = {}
    for r, ws in by_ref.items():
        best: LineString | None = None
        for chain in osm._chains(ws):
            ln = clip_line(network._chain_line(chain, frame), clip)
            if ln is not None and (best is None or ln.length > best.length):
                best = ln
        if best is not None:
            lines[r] = best
    return lines


def resolve(site: dict, frame: Frame, cache: Path, out: Path, half_width: float) -> dict:
    """Resolve a route site to a network site: write `boundary` (WGS84) and `roads`, and cache it.

    The resolved boundary is written to `<out>/route.json` so a re-run (a re-shard, a re-export) does
    not query Overpass again; `--force` on the bake re-resolves.
    """
    refs = [str(r) for r in site.get("refs") or []]
    if not refs:
        raise RuntimeError(f"route {site.get('slug')} names no refs")
    cuts = site.get("cuts") or {}
    cache_p = out / "route.json"
    saved = None
    if cache_p.exists() and not site.get("_force_route"):
        candidate = json.loads(cache_p.read_text())
        # A re-run reuses the cache only when the SAME refs and the SAME trim produced it; editing
        # either on the map has to re-resolve, or a moved start/end would silently bake the old one.
        if candidate.get("refs") == refs and (candidate.get("cuts") or {}) == cuts:
            saved = candidate
    if saved is not None:
        line = LineString(saved["route"])
        lines = {k: LineString(v) for k, v in saved["lines"].items()}
        boundary = Polygon(saved["boundary"])
    else:
        clip = clip_polygon(site, frame)
        if clip is None:
            raise RuntimeError(f"route {site.get('slug')} has no clip ring")
        lines = fetch_ref_lines(refs, clip, frame, cache)
        for r in list(lines):  # apply each ref's trim before the refs are joined and buffered
            trimmed = trim_line(lines[r], cuts.get(r), frame)
            if trimmed is not None and not trimmed.is_empty:
                lines[r] = trimmed
        missing = [r for r in refs if r not in lines]
        if missing:
            print(f"  route   WARNING no ways for {missing}", flush=True)
        ordered = [r for r in refs if r in lines]
        line = join_refs(ordered, lines)
        if line is None:
            raise RuntimeError(f"route {site.get('slug')} found no usable refs in the clip")
        boundary = boundary_of([lines[r] for r in ordered], half_width)
        if boundary is None:
            raise RuntimeError(f"route {site.get('slug')} produced an empty boundary")
        out.mkdir(parents=True, exist_ok=True)
        cache_p.write_text(json.dumps({
            "refs": refs,
            "cuts": cuts,
            "route": [[round(c[0], 2), round(c[1], 2)] for c in line.coords],
            "lines": {k: [[round(c[0], 2), round(c[1], 2)] for c in v.coords] for k, v in lines.items()},
            "boundary": [[round(c[0], 2), round(c[1], 2)] for c in boundary.exterior.coords],
        }))
    print(f"  route   {len(lines)}/{len(refs)} refs, {line.length / 1000:.1f} km, world {boundary.area / 1e6:.1f} km²", flush=True)
    return {
        **site,
        "kind": "network",
        "roads": refs,
        "boundary": to_wgs_ring(boundary, frame),
        "world": True,
        "primary": site.get("primary") or refs[0],
        "region": site.get("region") or f"route:{site.get('slug')}",
    }
