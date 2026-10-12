# The tiled network: area bakes without a global spine; spine bakes keep theirs

**Status:** proposed 2026-10-11. Position paper and staged plan; Phase 0 started (`netsets.py`).
This extends [PLAN-SHARDED-BAKE.md](PLAN-SHARDED-BAKE.md): that plan sharded the **rasters** (dem,
naip, lidar, tiles, pyramid) and kept the **network** one global object — the plan step runs
`roads()`/`dead_ends()` over the whole region and the finalizer stitches one primary. That is fine
for a metro; it is the ceiling for a country.

## Why

Two workloads want different things, and today one code path tries to serve both:

- **An area bake** (a drawn region, a whole state, a country) should be **bounded by tiles**: no step
  whose working set is the whole world, no structure that couples a road in Maine to one in Arizona.
- **A spine bake** (I-70, I-95 with the metros along it) *wants* a long poly: picking a route and
  ordering the metro tile-sets along it is exactly a spine. That is the one place a global line is
  the right object.

So the spine stops being the backbone of every bake and becomes an **opt-in selector** used only by
spine bakes. Area bakes cut their network to tile-sets and never build a world line.

## Where we are (measured)

`dc-maryland-nova-suburbs`, the 2026-10-11 overnight bake, ~58 km across, 36 shards, 3,808 km tiles:

| quantity | value |
|---|---|
| distinct junction nodes | 87,985 |
| junction records | 181,668 |
| junction clusters | 78,651 (largest 9) |
| junction clustering, one global pass | **0.24 s** (was ~an hour; `_cluster_nodes`, 2026-10-11) |
| export stage (tiles/ktx2/overview/features) | ~44 min |
| km tiles | 3,808 |

The clustering fix made the *global* pass cheap; it did not make it *local*. It still reads all
87,985 nodes, and every other whole-network stage still holds the world at once. For a country,
0.24 s becomes minutes and the memory does not fit at all.

## What is still global (the long polies in the tent)

1. **The plan phase.** `network.roads()` (`network.py:156`) is one Overpass query for the whole
   region and builds all chains plus the whole-node `node_xy`/`node_ll`/`owners`/`by_id` dicts; the
   junction construction projects every junction against its chain (`network.py:238-265`).
   `write_vectors()` (`network.py:371`) emits **every sibling whole** and unions **every** chain
   buffer into one `road_band`. `dead_ends()` (`network.py:282`) enumerates every chain end in the
   world. This is where every long poly lands: `spine_utm.json` is a whole-region file.
2. **The junction model.** `intersections.build()` keys the whole site by OSM node id (`at_node`,
   `intersections.py:504-509`) and groups routes **by street name across the county**
   (`intersections.py:324-329`). A "Columbia Pike" identity couples ten km a seam would split.
3. **`grade.RoadModel`.** All stations resident at once, a 5 m station every 5 m along the whole
   spine, every carriageway's `Curve3`, a **junction meet over the whole network**, and **one
   cKDTree over all stations** (`grade.py:403`, driven by `pyramid.road_model`). The second tent.
4. **`export_site` + the finalizer.** One country-sized manifest; `_stub_roads`/`_signals`/
   `_sidewalks`/`_power` each loop all OSM features (`export.py:295,444,881,1030`); `walkways.zones()`
   unions **all** residential buffers at once (`walkways.py:85`); `overview()` mosaics the whole
   bbox. And finalize is one global merge — `stitch_profile`, `_merge_primary_cloud`, `merge_lidar`
   (`shards.py:306-690`) — precisely because the **primary is global**.

## What "O(log n)" should mean here

A bake **emits a country's tiles**; emitting k tiles is Ω(k). The target is not sublinear total
work, it is:

- **every stage's working set ≤ a tile-set (+ a halo)** — bounded memory, one tile-set in flight;
- **lookups and joins via spatial indexes** (STRtree/cKDTree, O(log n)) instead of scans — that is
  the piece "O(log n)" is right about;
- **no global barrier** — the finalizer assembles independent tile-sets, it does not union a world.

## The target model

**The unit is a tile-set**: a square block of the 1 km world tile grid, `SET_M` a side (default
4 km ⇒ 16 km², matching the shard block scale). A tile-set owns:

- **road segments** — every chain **cut at the tile-set seams** (see `netsets.cut_line`). A seam
  crossing becomes a node both neighbours agree on. This is the "no long polies in the tent" rule:
  no logical road is ever one geometry longer than a tile-set.
- **a halo** — its rectangle grown by `HALO_M` (default 300 m, matching `shards.DEFAULT_MARGIN_M`,
  and ≥ the widest consumer: lidar half-width, `CLUSTER_R`, `SIGNAL_SNAP`, the walkways zone buffer).
  A neighbouring segment inside the halo is present as **context**, so a junction, a priority
  decision, a route grouping or a walkway zone that straddles a seam is computed with both sides.
- **its own junction / priority / signals / walkways / furniture / profiles**, all scoped to
  (owned + halo), never the world.
- **its own vector tiles and its own manifest fragment**, assembled independently.

Identity changes with the model: a chain is no longer global. The OSM-derived `r<min way id>` is kept
as the correspondence key, but the unit of work is `(tile-set, segment)`.

## Area vs spine

| | area bake (default) | spine bake (opt-in) |
|---|---|---|
| selection | a drawn region / a state / a country bbox | a route (I-70, I-95) ± named metros |
| unit | tile-set | tile-set, ordered along the spine |
| spine | **none** | the route line is the selector: it picks and orders tile-sets |
| profile | per segment, per tile-set | per segment; the spine only orders them |
| global line | never built | built once, as a selector, and thrown away |

A spine bake is a **chain of tile-sets** chosen and ordered by the spine. The spine never becomes a
data structure the bake carries; it resolves selection, then the tiled pipeline runs.

## Phases

**Phase 0 — the tile-set primitive (started).** `piedmont_bake/netsets.py`: the tile-set grid, the
halo, and cutting a chain at the seams into owned segments with shared seam nodes. Pure functions,
tested in isolation. No consumer changes; the tree stays green.

**Phase 1 — plan per tile-set.** Move `roads()`/`dead_ends()`/`write_vectors()` off the one global
query: plan each tile-set's bbox (query Overpass per tile-set, or take a Geofabrik extract and clip)
and write per-tile-set network artifacts (`tilesets/<i>/roads.json`). Keep the global
`spine_utm.json` as a compatibility rollup until Phase 3, so shards keep working.

**Phase 2 — the junction model per tile-set.** `intersections` takes (owned + halo) for one tile-set
instead of the whole site; route grouping becomes per tile-set (with the halo making a seam-split
road read as one road locally); `at_node` never spans the world. Same for `walkways`, `_signals`,
`_sidewalks`, `_stub_roads`, `_power`, `_parking`, `_barriers`.

**Phase 3 — profiles and the pyramid per tile-set; drop `RoadModel`'s global spine for area mode.**
Per-segment profiles replace the world primary; `stitch_profile` / `_merge_primary_cloud` /
`pyramid.road_model`'s whole-network meet disappear for area bakes. (`overview` becomes a pyramid
read, as PLAN-SHARDED-BAKE Phase 0 already points at.)

**Phase 4 — finalize as a tile-set union.** The finalizer assembles `web/` and a **tileset index**
`manifest.json` (tile-set → its fragments), not one country manifest. The viewer loads neighbour
tiles for cross-seam continuity (the seam nodes make this exact). Publishing becomes per tile-set.

**Phase 5 — spine mode.** Reuse the current single-primary machinery as the selector: resolve the
route, buffer it, pick the tile-sets it crosses and the metros to include, order them, then run the
tiled pipeline. This is the only path that builds a long line, and it does not carry it into the bake.

## Seams and correctness

| seam | risk | resolution |
|---|---|---|
| a chain cut at a seam | two segments where there was one road | shared seam node; halo gives each side the neighbour's segment for decisions |
| route grouping by name | a divided road split across a seam stops reading as one road | group within (owned + halo), not the county |
| junction at a seam | a crossing two tile-sets both see | cluster within the halo; the seam node is identical on both sides |
| halo width | a decision that reaches further than the halo is wrong at the seam | halo ≥ every consumer's reach; assert it against the constants, not a comment |
| profiles | split `s`-keyed arrays | per-segment profiles; no world stitch |
| determinism | two tile-sets disagree about a shared feature | seam node + a stated tie-break (lower tile-set wins) |

## Acceptance

The area bake's **output representation intentionally changes** (segments, a tileset index), so the
acceptance is not byte-equality with the single bake — it is "the same world":

1. **Coverage** — the union of tile-set segments equals the single bake's chains, cut at seams; no
   segment dropped, none duplicated.
2. **Continuity** — at every seam, the two segments' endpoint metres match to the coordinate quantum;
   a walked route crosses a seam with no gap.
3. **Decisions preserved** — for a small world, every intersection, signal, stop, walkway zone and
   building those within a tolerance of the single bake's, measured tile-set by tile-set.
4. **Bounded** — peak memory of a tile-set stage is flat as the world grows (log the peak per stage,
   as the bake log already does).
5. **`piedmont_bake.verify` passes** on the assembled world, and the viewer streams it with no seam
   visible at speed.

Prove it first on a **2×2 tile-set split of Crofton** (cheap, every seam), then on
`dc-maryland-nova-suburbs`.

## Open questions / risks

- **Halo width.** `shards.DEFAULT_MARGIN_M = 300` is the starting point, but the walkways zone buffer
  and the lidar half-width are the real bounds. Set it from the constants and assert it.
- **`context.json` lanes** are keyed by `r<osm way id>` across the whole world (`osm.py:538`); per
  tile-set they must be scoped or looked up by segment.
- **The viewer assumes one manifest.** Phase 4 changes that contract; `PLAN-STREAMING-WORLD.md` is
  where the streaming consumer lives. Sequence the two together.
- **`surface.measure` reads the primary** (`surface.py:139`) and is not yet per-shard
  (PLAN-SHARDED-BAKE flags this). It must become per-segment in Phase 3.
- **OSM ingestion at country scale.** One Overpass query per tile-set is a lot of queries; a
  Geofabrik extract clipped per tile-set is probably the answer, and that is an ingestion job of its
  own (see [OVERPASS-PLANET.md](OVERPASS-PLANET.md)).
- **The `world`/canopy global raster** is fetched whole today; it must tile too.

## What we are NOT doing

- **Not changing OSM ingestion yet** — Phase 1 starts on the current `roads()` output, cut to
  tile-sets; the extract-clip path is a later ingestion job.
- **Not deleting the single-Job path** — a small world still bakes whole.
- **Not removing the spine** — it is kept, exactly, for spine baking (`mode: spine`).
- **Not moving off the RWX PVC** or the `web/` output format before Phase 4.
