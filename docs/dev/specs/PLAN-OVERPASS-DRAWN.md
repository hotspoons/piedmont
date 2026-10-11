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
- A global "region A contains region B" test is no better, because neighbouring regions ADJOIN.
  Washington DC shares a border with Maryland and with Virginia, so samples of a drawn shape land in
  each, and the rule dropped both states for the tiny enclave they abut — a shape spanning Maryland
  and Virginia came back as DC alone.

  (A related trap, from TODO #3: Geofabrik ships some regions with an **empty** index outline —
  Maryland and Virginia among them — filled in here from the vendored seed, whose polygons match the
  region's own `.poly`.)

A local "is this point inside this region, smallest area wins" is exact, cannot cascade, and needs
no nesting to be correct. A bounding-box overlap is only a pre-filter — a continent's bbox spans the
world.

Consequences. A shape that genuinely crosses a border names both neighbours: a square drawn on DC
comes back as DC **and** Maryland **and** Virginia, because its corners really are in Maryland (east)
and Virginia (across the Potomac) — checked against Geofabrik's own `.poly`, not a bug. And an
open-ocean draw inside a group region's convex hull (the Pacific states' `us-pacific`, say) names
that hull, because Geofabrik's outline for a group region is a hull that covers the ocean between
its members; telling that from a real island needs land data the index does not carry. A shape no
extract covers at all is a plain 400.

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
