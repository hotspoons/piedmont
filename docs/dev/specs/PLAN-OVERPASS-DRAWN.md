# Drawn-area Overpass builds

Status: landed (2026-10-11). Editor: `World → Explore → OSM data`. Server:
`services/worldeditor/osmbuild.mjs`, `runs.mjs` (`osmBuild`, `osmBuildJob`), `server.mjs`
(`POST /api/osm/builds`). Script: `deploy/helm/overpass/files/import.sh` (drawn mode).

## Why

Rich, 2026-10-11: "for world -> explore ... clicking OSM data will list the instances — selecting an
instance will let you draw a polygon on the screen, and once you close the polygon you can launch an
index/build job for the overpass instance." And the reason it matters: "In the future I won't bake
all of north america if I am just interested in a subset, that would help."

Before this, the only way to add data to an instance was `osm-import`: a NAMED Geofabrik region,
downloaded whole. Taking a strip of one meant importing a whole state, continent or country. A
drawn shape is the missing primitive.

## What it does

1. In **Explore**, **OSM data** lists the instances. Clicking an instance arms the coverage map for
   drawing; a click adds a corner, and the shape closes on the first corner, a double-click or
   Enter. **Build this area** launches a job.
2. The route `POST /api/osm/builds` takes `{ upstream, polygon, name? }`. It picks the **smallest
   Geofabrik extract(s)** whose own coverage the drawn shape touches (`coveringRegions`), then
   starts an `osm-build` run. `dryRun: true` answers with the pick alone, so the confirmation names
   real extracts and sizes and a refusal starts nothing (`api.osmBuildPreview`).
3. The run is a Job identical to an import's — the instance's own image, on the instance's node,
   with its volume and `<release>-regions` ConfigMap — running the same `import.sh`. So everything
   about staging, the sidecar, the dispatcher, the log and the cancel is shared.

## The pick: smallest, not biggest

For each point of the drawn boundary, take the **smallest-area overlapping region that contains it**;
the union over the boundary is what to download. So a shape inside Virginia picks `us/virginia`, not
`us`, `us-south` or `north-america`, and a shape across a border picks both neighbours.

This is deliberately NOT built on `properties.parent`, and NOT on a global "region A contains region
B" test. Both look right and both broke in production:

- In the live index `us`, `us-south`, `us/maryland` and `us/district-of-columbia` **all** name
  `north-america` as their parent. They are siblings, so a DC-sized shape matched the whole-US
  extract (11 GB) beside DC itself.
- Geofabrik ships some regions with an **empty outline** (TODO #3), patched here from the coarse
  vendored seed. Deciding containment from those geometries drops a state for the tiniest enclave
  inside it and cascades: a shape spanning Maryland and Virginia came back as Washington DC alone.

A local "is this point inside this region, smallest area wins" is exact, cannot cascade, and needs
no nesting to be correct. A bounding-box overlap is only a pre-filter — a continent's bbox spans the
world. Two edge cases are known and cosmetic: a square whose corner crosses the Potomac into the
coarse patched Virginia outline names Virginia as well as DC, and an open-ocean draw in the Pacific
can name `us-pacific` (another whole-world-bbox outline in the index). A shape no extract covers at
all is a plain 400.

## The snapshot decision

A named Geofabrik region carries a replication sequence and base URL in its extract header, and the
`regions` sidecar follows its diff stream from there. A drawn area cannot: the extract it is clipped
from also covers ground OUTSIDE the shape, so following that extract's diffs would pour data back in
outside the drawing. The area is therefore staged with **no updates**; the sidecar applies it once
and stops (`regions-agent.sh` returns early when the request's `updates` is empty). Re-draw and
rebuild to refresh. Clipping each diff to the shape would make it live, and is the obvious follow-up
if refresh-by-diff is ever wanted.

The region id is `osmium extract -p`'d into the `.poly` the delete filter and coverage map already
read, so a drawn region is a first-class region everywhere else: `source: 'build'` on the coverage
record, drawn on the map, routed to like any other.

## See also

- [OVERPASS-PLANET.md](OVERPASS-PLANET.md) — importing and keeping a continent-scale instance.
- `services/overpass/README.md` — the sidecar, `update_from_dir`, and the delete filter.
- [docs/dev/services.md](../services.md#overpass) — how it fits together now.
