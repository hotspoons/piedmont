# Terrain, tiles and streaming

How a baked world gets from the volume into the frame: what the bake writes, how the viewer
streams it, and the one rule that keeps the ground, the road, the grass and the physics agreeing.

## Three sizes of bake, three layouts

| Kind | What the bake writes | How the viewer loads it |
|---|---|---|
| **road band** (the original: one road, a few km) | one image per layer: `dem`, `chm`, `naip`, the horizon | whole, at boot |
| **network**, a few km across | the same, plus 1 km tiles on the projection grid (`web/tiles/0/<x>_<y>`, one `pack-1` blob per tile) | heights decoded up front, imagery streamed (`lod/tiles.ts`) |
| **world** (tiled network, any size; sharded above 10 km) | an LOD **pyramid** on the geographic quadtree (`web/pyr/<z>/<x>_<y>.pack` + `.jpg` + `.ktx2`), per-cell **vector tiles** (`web/vt/0/<x>_<y>.json`) | streamed against the camera (`lod/pyramidstream.ts`) |

The manifest (`web/manifest.json`, types in `apps/game/src/world/site.ts`) says which: `layers.dem`
etc. for single images, `layers.tiles` for flat tiles, `layers.pyramid` for a pyramid, `vt` for
vector tiles. Everything new targets the pyramid; the flat paths stay for older bakes.

## The pyramid

`bake/piedmont_bake/pyramid.py` writes it; `apps/game/src/lod/pyramidstream.ts` streams it.

- **Scheme:** the geographic quadtree shared with trailworks and the engine (`tileBounds` /
  `tileOf` in `@apex/engine/geo/wgs84.ts`): level z has 2^(z+1) columns and 2^z rows. At 39° N, z14
  is about 1.2 × 0.95 km and is the leaf; the root is the coarsest level that covers the world.
- **Quad closure:** a tile subdivides only when all four children exist, so the bake emits every
  sibling of a wanted tile (an empty marker where there is no data). Without that, a region
  boundary freezes at a coarse level.
- **A tile** is a `pack-1` blob (uint32 LE header length, a JSON header
  `{rev, files: {name: [offset, length]}}`, then the payloads): the height (`dem.png`, RGB-encoded:
  R high byte, G low byte, `zmin + v × zscale`), canopy, and on graded levels the bare earth
  (`bare.png`). The imagery is a `.jpg` with a `.ktx2` twin (ETC1S with mips, stored bottom-up so it
  matches three's `flipY` upload); `layers.pyramid.texture_ktx2` is set only when every tile has a
  twin.
- **Decode** happens in a worker (`lod/tiledecode.worker.ts`), which also builds the terrain grid
  and normals, so the main thread only wraps arrays.
- **Selection** is screen-space: a tile subdivides when it covers more than a set number of metres
  per pixel. **Loading is nearest the eye first**, so the ground under the camera is never the tile
  left waiting while the budget fills with the far ring. A tile is **dropped** only when something
  else already covers its ground (a parent waits for its children to arrive), or when it left the
  view. Fetches in flight are re-checked for wantedness on arrival.
- **Budgets:** decoded bytes resident and fetches in flight are capped; the farthest tiles are
  evicted first.

## The graded ground

The road is not draped on the DEM; the DEM is graded to the road. On a graded bake
(`layers.pyramid.graded`), the fine pyramid levels (z13 and z14 at mid latitudes, pixels under 6 m)
carry the ground **with every road's grade already folded in**, computed at bake time by
`bake/piedmont_bake/grade.py`, a line-for-line port of the viewer's `gradedHeight` in
`world/scene.ts` (the station field, `edgeDistance`, centripetal Catmull-Rom splines checked
against three.js to 1e-9 m, junction meets, cul-de-sac bulbs, driveways). The physics heightfield
and the terrain strips then read the raster instead of grading every sample. Exceptions keep the
formula: a cell that spans a step between two carriageways (`RASTER_CLIFF_M`), decks (the raster
there is the earth below), and worlds whose `ground_offset_m` adjustments are active. `?grade=runtime`
forces the old path for an A/B; an older bake grades at run time exactly as before.

The bake refuses to ship a grade that sits off the earth (`GradeFault`, median beyond 0.5 m) or
junctions in another frame.

## One surface, one height function

Every bug shaped like "green stuff on the road", "ribbons on the embankment" or "the car shakes"
has been two meshes modelling the same ground at different samplings. The rule:

1. **The carriageway spline is the road height.** It drives the asphalt, the paint, the strip
   under the pavement, the car and the camera.
2. **The strip (`world/strip.ts`) is the only ground near a road**: 1 m across by 2 m along, at the
   road height under the pavement, blending to the DEM over 7 m. The coarse terrain is sunk beneath
   it. On a bridge the verge stops at the parapet.
3. **The horizon exists only outside the near terrain's footprint.**
4. **Authored grade changes happen before the spline** (`structures.json` `flatten`).
5. **Physics stands on the same function** (`new Terrain(phys, site.groundAt)` in
   `game/world/physics.ts`): the wheels and the picture cannot disagree.

Where two carriageways cross at different heights, the ground follows the earth and the elevated
one is a **deck** with its own trimesh collider (`world/overpass.ts`); the bake records which
stations are decks (`spine.elev_s`, `branches[].elev_s`) so the viewer and the raster agree.

## Streaming everything else

The road network, buildings, furniture, grass and trees are built near the eye and in budgeted
slices, never in one call stack:

- `world/budget.ts`: a `Budget` hands out main-thread time; `await b.tick()` yields to the next
  frame when this one is spent. It must not wait on a frame that is not coming: a hidden tab gets
  no `requestAnimationFrame`, so it falls back to a macrotask.
- `world/streamscale.ts`: the **frame governor**. The frame loop measures its own CPU and scales
  every builder's budget (grass, tree planting, the grading pump, building fill) toward
  `STREAM_TARGET_MS`, with a floor so the world keeps arriving.
- **Direction of travel:** the builders rank work by a focus point `STREAM_LEAD_S` seconds of travel
  ahead of the eye; a unit covering the eye always comes first, and one behind counts triple.
- `world/branchchunks.ts`: long roads are cut into chunks on a shared 6 m station grid, so a 60 km
  motorway never lands as one unit, and neighbouring chunks abut exactly.
- **Vector tiles** (`vt`): buildings, branches, furniture and other arrays live per 1 km cell in
  site metres and are fetched only near the eye (`loadVectorTile` in `world/site.ts`, fetched with
  `cache: 'no-cache'` so a re-export is seen).

## What is still loaded whole

Some files and runtime structures are still loaded or kept for the whole session: the 8 m overview
DEM and canopy, `context.json`, the full manifest, the NAIP overview, and nothing streamed is ever
unloaded yet. [specs/PLAN-MONOLITHS.md](specs/PLAN-MONOLITHS.md) measures each and lays out the
order to break them up; [specs/PLAN-WORLD-SCALE.md](specs/PLAN-WORLD-SCALE.md) is the map of what
stands between the current bake and a world of any size.

## Further reading

- [frames.md](frames.md): why the metres are ENU about a geodetic anchor, and how a raster is
  placed on the ellipsoid.
- [specs/PLAN-STREAMING-WORLD.md](specs/PLAN-STREAMING-WORLD.md),
  [specs/PLAN-OPEN-WORLD.md](specs/PLAN-OPEN-WORLD.md): the plans behind the pyramid and world bakes.
- [bake/README.md](../../bake/README.md): the graded raster and the KTX2 twins, with their
  measurements.
- [performance.md](performance.md): what the governor and the budgets were tuned against.
