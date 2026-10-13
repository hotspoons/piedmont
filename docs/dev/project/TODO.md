# Tracked TODOs

The living list of known issues and deferred work. [HANDOFF.md](HANDOFF.md) is the split's
snapshot; this file is where the open items are tracked and closed. Add an item here when it is
found, and check it off (or delete it) when it is fixed, with the commit or link.

## Known issues, by area

| # | TODO | Area | Notes |
|---|---|---|---|
| 3 | **Geofabrik's published index can have empty region outlines** | services/worldeditor | 11 regions on 2026-10-10, `virginia.poly` 0 bytes. Routing refuses empty outlines and falls back to the volume's copy or the seed (`services/worldeditor/geofabrik.mjs`); an OSM import of Virginia may fail until Geofabrik fixes its files. That fallback is now pinned by tests (`geofabrik.test.mjs`: a hole in the live index keeps the volume's outline and is written back; a region nobody can outline is reported and never routed to). Nothing more to do here until Geofabrik fixes its index. |
| 6 | **Tiled network: the per-tile-set OSM query** | bake | Phase 1 stops holding the whole network in one process — plan/query Overpass or clip a Geofabrik extract per tile-set. See Phase 1. **The next real step on the tiled network**: `roads()` still queries the whole site bbox and merges chains globally, so `plan` holds whole 100 km+ chains (`write_tilesets` then cuts them). The per-tile-set *sourcing* is what removes the long polies; the consumers are Phases 2–4. |
| 8 | **MCP config leaks the bearer token to an unauthenticated caller** | services/worldeditor | `GET /api/agent/mcp/config` returns `auth.token` in the clear (`mcpauth.describe()`, deliberately, so the Agent tab can show it) — but the deployed host answered that GET with no credentials, so the token (which gates `shell_exec`, `program_write`, …) is readable by anyone who can reach the ingress. The code assumes the ingress authenticates; empirically it does not in front of this path. **A code-side gate cannot close this alone**: the Agent tab has to read the token to show it (that is the same-origin page), and the sibling `POST /api/agent/mcp/config` can *set* the token with no credentials either — gating the read while leaving the write open buys nothing. The fix is an edge/deployment decision — authenticate `/api/agent/*` (or the whole editor) at the ingress, or put the config route behind the agent tunnel's credential — Rich's call, not a unilateral code change. |

## Recently fixed

- **An overpass on i70 is a deck, not a ditch** — Rich saw the eastbound lane dive into a ditch at
  every overpass and the crossing roads stubbed into it. Two bake defects, one root. `lidar.profile`
  sampled a shard's rasters with a clamp, so a station OUTSIDE the raster came back as the nearest
  EDGE pixel — finite and wrong, which silently defeated `profile_tiled`'s documented `fill=False`
  ("NaN outside the block, for `stitch_profile` to hand them to the neighbouring shard"). `_combine`'s
  "first finite wins" then took a non-owner's edge value wherever the OWNING shard's own cell was a
  hole (a bridge, a culvert, canopy): one shard's edge, the constant `144.93`, leaked into 1,624
  stations. The wrong `surface_z` also truncated each overpass span to a 2 m `gantry`, because the
  crossing deck's points fell outside the 4.5–40 m above-surface test — so the game (which draws a
  deck for `overpass`/`bridge` but only a marker for `gantry`) never drew a bridge. `sample()` now
  returns NaN outside the raster and `_fill_along` bridges what no shard can answer. Separately, the
  structure tests read a hole-bridged reference (`lidar._bridge_nan`): the owner shard's own DTM is
  nodata exactly under a crossing bridge (Ernstville s=10904 and 10914–10922), so `surface_z` was
  NaN across the whole deck and its points failed the 4.5–40 m above-surface test — the span was
  truncated to the 2 m `gantry`. The returned arrays keep their NaN (the `fill=False` contract).
  And `export._stub_roads` followed the bare-earth DEM down into the hole a bridge spans (Ernstville
  Road, 6.7 m); `_hold_grade` bridges a short dip to the stub's own grade. `68329aa`; the sampling
  contract, the hole-bridged detection and the grade hold are unit-tested
  (`bake/tests/test_branch_profile.py`, `test_stub_span.py`).
- **A shard with no lidar no longer fills the stitched grade with sea level** — the follow-up the
  overpass fix exposed. `sample()` returning NaN outside a raster is right for a lidar shard, whose
  `profile.json` keeps its NaN for the stitch to fill along-track. But a shard that owns no world
  tiles (`larea` empty) profiles the WHOLE primary from its own block-sized DEM — most of the line is
  outside that DEM, `profile_from_dem`'s `_fill_along` turned the all-NaN run into `[0.0] * n`, and
  `stitch_profile`'s "first finite wins" then took those zeros for every station no OTHER shard
  covered. On the i70 rebake the spine start (s=0–1846) and the far east read exactly `0.00`, and the
  1,615 stations that had leaked `144.93` now read `0.00` — the grade dived to sea level where it had
  dived into a ditch. `profile_from_dem(..., fill=False)` keeps the raw NaN (the whole-site DEM
  fallback, which has no stitch to fill it, still fills); the shard's no-lidar primary now uses it, so
  the stitch interpolates. Tested (`NoDataShardTest`). `48ecd30`-follow-up; rebake confirms.
- **A finished bake's intermediates are pruned (the volume no longer fills)** — nothing removed a
  shipped world's `shards/`, merged `lidar/`, `canopy_global.tif` or mosaic `.ovr`s, so two big
  worlds filled the 500 Gi `worldeditor-data` PVC and the worldeditor crash-looped on `EDQUOT`
  (TODO #9). A world is `web/` (the manifest references nothing else), so
  `shards.prune_intermediates` drops the rest — the merged rasters are kept unless `--all`. New
  `piedmont_bake prune <slug|all> [--all] [--dry-run]`, and a sharded `finalize` prunes itself when
  passed `--prune`, which the worldeditor service now does by default (`PIEDMONT_KEEP_INTERMEDIATES=1`
  opts out for a re-export). Tested in `bake/tests/test_shards.py`.
- **`export_site`'s signal clustering is linear, and every silent helper has a heartbeat** — the
  finalizer's `_signals` grouped traffic-signal nodes with an all-pairs greedy closure
  (`any(linked(i, j) for j in grp)`), O(n²·group): on the 62 km dc-metro world it sat in that loop
  for hours with nothing printed (TODO #10). `linked` is symmetric, so the groups are its connected
  components; `cluster_signals` now BFSes over a uniform grid of the 140 m shared-way radius, visiting
  only the 3×3 cells a node can reach. `_paths`/`_service_ways`/`_stub_roads`/`_power`/`_signals`/
  `_parking`/`_barriers` each run under `progress.heartbeat`, so a slow world names the helper that is
  slow instead of going quiet. Tested in `bake/tests/test_signals.py`.
- **Lidar canopy and roofs (TODO #4): already handled, closed** — the CHM is "unclassified points
  above ground", so where a vendor left buildings unclassified a roof reads as a crown. But every
  canopy layer the game consumes is masked over the OSM footprints before it ships: the tiled/network
  path (`network_tiles.mask_shapes` → `export_tiles`/`overview`, roads + buildings) and the
  single-image path (`export_site` zeroes the canopy under every footprint, `export.py` ~1671). The
  game masks footprints again at planting for worlds already published
  (`apps/game/src/world/footprintmask.ts`). The only unmasked copy left is the raw `lidar/chm.tif`,
  which is a measurement input (the flora species-height cross-check and the beside-road canopy
  profile), not a placement. Nothing to change.

- **The road stood 100 ft above the terrain, and coarse tiles cut walls through it (I-70 east)** —
  Rich saw the road surface floating over the ground and green vertical "towers" along the eastbound
  side at the east end of I-70. Root cause was one thing, not the sibling carriageway grade he first
  suspected (that path is off for a network site — `i70-us15-maryland` draws its carriageways as
  `branches`, not `siblings`): the coarse terrain tile under the eye is drawn over the finer, graded
  one, and the sink that keeps it below the child was the constant `PYR_DROP_M` (8 m). On a
  country-sized world the z10/z11 surface stands **up to ~115 m** above the finer tile beneath it (a
  graded cut or a hill the coarse raster misses), so 8 m let the coarse tile punch straight through
  the fine ground and the road on it. Sink is now MEASURED: `PYR_DROP_AUTO` (F6 ▸ tiles, on) samples
  the tile that actually covers each quadrant through its own raster and sinks by the largest
  overflow found, plus `PYR_DROP_M` as margin (the knob is now a floor). Sampled per quadrant and
  cached, re-measured only when the covering tile changes. `PYR_DROP_M` alone still works (turn
  measure off). Also smoothed the road-band sibling's hard 60 m switch from the spine's grade to its
  own DEM — a 40–80 m ramp instead of a step — which is the same wall on an older site.

- **A shard whose lidar tiles all fall outside its area is "no lidar here"** — the i70 bake then
  died on shard 31: it fetched three TNM LAZ tiles, every one lay outside its area, so nothing was
  written, but `lidar_tiled` still returned and `fetch_shard` profiled against a `dtm.tif` that was
  never created (`RasterioIOError: .../lidar/dtm.tif`). `lidar_tiled` now raises `NoLidarHere` when
  it wrote no tiles, the fact the caller already understands (fall through to the elevation-model
  profiles, the same path `bbff1eb` uses). `6a0f02d`; tested.
- **A service suite hung CI on ~half of pushes** — `runs-osm.test.mjs` passed every test and then
  never exited. `Runs.cancel` finishes a run while `#advance` is mid-flight, so the advance started
  the next phase and re-armed a watcher for an already-terminal run, whose log follower kept opening
  the run's (removed) log file. The phase watchers no-op on a terminal run, the log sinks tolerate a
  vanished directory, and the checks wrapper passes `--test-force-exit`. `a1439b0`; cleared at 16-way
  concurrency.

- **Tiled network: the game minimap read the whole network** — `game/move/minimap.ts`'s worker
  loaded the site's entire network export (`context.json`, ~47 MB on dc-metro) once and tiled it
  itself. It now reads the coarse `vt/<z>` cells for the view (`chooseMapLevel`: the finest level
  whose cell keeps the view under ~8 cells across, via the shared `loadVectorTile` LRU), sends each
  cell to the worker as its own message, and only falls back to `context.json`/`osm.geojson` when a
  site has no `vt.levels`. The "spider web" (one `Float32Array` per class read as ONE polyline, so
  the worker joined the end of each road to the start of the next) is gone: a `cell` now carries
  `layers: Record<string, Float32Array[]>` — one array per polyline. Live-verified on the deployed
  viewer (`piedmont.minimapVectors()` reports `mode:"cells"`, `dir:"vt/0"` at default zoom, `vt/11`
  zoomed out). `0990b53`.
- **Tiled network: the coarse-vector LODs, bake and viewer** — the bake now reduces the
  distance-reading layers (roads, trails, rail, streams) into `web/vt/<z>/` bundles beside `vt/0`
  and carries a `vt.levels` index, keyed on the SAME site-metre cells `vt/0` uses so a coarse tile is
  a partial manifest the existing loader reads unchanged; `export_site` writes them for every coarse
  level and `piedmont_bake vectors [--force]` backfills a deployed site. The editor map picks the
  level with `chooseVectorLevel`, streams it with `streamLevel`, tags buckets `b.level` and frees the
  previous level's GPU buffers on a switch. Live-verified on a backfilled `crofton-triangle`, where
  the coarse bundle is ~4500x smaller than `vt/0` (z10: 3 KiB over 4 tiles vs 13.2 MB). The game's 3D
  world needs no change: it streams branch asphalt only within `STREAM_BUILD_M` (≤ 6 km) of the eye
  (`world/scene.ts` `gradeNear`), so it never fetches vectors coast to coast. See
  [specs/PLAN-TILED-NETWORK.md](../specs/PLAN-TILED-NETWORK.md) Phase 4b.
- **MCP port verified in a real browser** — the last acceptance box (`docs/dev/specs/PLAN-MCP-PORT.md`
  *Done when*) is ticked. `services/worldeditor/mcp-browser-check.mjs` drives a headless Chromium on
  `/world.html` against a local `server.mjs` (so nothing else owns the bridge) and checks the whole
  flow over `POST /api/agent/mcp`: `shell_exec` succeeds with the Shell tab never opened, the second
  call reuses the machine, the visible pane is undisturbed, an MCP `program_write` shows up in the page
  shell's `cat`, and opening the Shell tab afterwards shows the machine the agent started — 13/13.
- **World editor: Assets mode had no Traffic tab** — `worldedit/main.ts` built its `AssetCatalog`
  without `trafficExtension()`, which `editor/main.ts` and the viewer both pass, so traffic sets could
  only be edited from `/editor.html` or MCP. Wired in; Assets mode now shows Catalog, Materials,
  Service, Blender, Vehicles, Actors, Weapons, **Traffic**, Fixtures, Sounds, Buildings (verified in a
  headless browser against `/world.html`).
- **Stage panel: a level's `program` and a traffic simulation's `set` had no control** — both were
  JSON-only, so the guide sent users to Shell mode or MCP `level_save` (`worldedit/stage.ts`). The
  panel now offers a **program** picker filled from `GET /api/programs` (the `program` field on the
  editor's `Level` type too) and, on each **traffic** simulation, a **set** picker filled from the
  traffic-set builds. Both verified in a headless browser against `/world.html` (the labels appear and
  persist), and the guide's Stage section and Assets tab table updated to match.
- **Port `agent/mcp-fixes` into piedmont** — the arcade branch (`agent/mcp-fixes`) was never merged,
  so all nine live findings were ported by intent against today's code (`316d583`): the document
  channel (`apiFetch` broadcasts `documentsChanged` to every page, `Shell.refresh` pulls the text
  into the machine without saving back), an explicit `shell_exec` cwd, `program_delete` refusing a
  folder without `recursive`, `code_hover`/`code_definition` warming the service instead of answering
  a false `null`/`[]`, schema fixes (`program_check`, a path WITH extension), `shell_list`'s
  `projectedAt`, `code_outline` flags + by-line sort, `code_definition` on API declarations, and
  `ShellPanel.ensureMachine()`. Tests: `services/worldeditor/mcpbridge.test.mjs`,
  `services/worldeditor/program-delete.test.mjs`. Finding #4 was already handled; see
  [specs/PLAN-MCP-PORT.md](../specs/PLAN-MCP-PORT.md).
- **No way to add just a slice of a region to an Overpass instance** — the only lane was a named
  Geofabrik region, downloaded whole, so taking a strip of one meant importing a whole state or
  continent. **World → Explore → OSM data** now lists the instances, lets you draw a polygon on the
  coverage map, and builds it (`osm-build`): the server picks the smallest Geofabrik extract(s)
  covering the shape (`osmbuild.mjs`) and the job clips them to it with `osmium extract -p`
  (`import.sh` drawn mode). A drawn area is a snapshot, not kept current by diffs — see
  [specs/PLAN-OVERPASS-DRAWN.md](../specs/PLAN-OVERPASS-DRAWN.md).
- **The built-in asset kit never shipped** — `catalog.json` listed 33 ids but no `.glb` existed
  and `surfaces/` was empty, so a fresh editor drew none of its own models or road textures. The
  generated kit (33 models, 8 surface sets) is now tracked in Git LFS and shipped by the
  worldeditor image (`a1d5566`).
- **Trees planted far-first** — the crescent cursor walked in from the context edge, so a capped
  tree budget was spent on the hidden `spare` ring beyond the draw radius and the near annulus was
  never measured; the near trees then appeared a replant later, as you drove up. Rows are now
  ordered nearest-first and drawn trees fill before spare (`6b2427e`). A fixed-eye boot on
  `crofton-triangle` went from 1 850 drawn / 0 near to 25 000 drawn / 0 spare.

## Also open

- **Cloudflare deploy from a piedmont install is unproven** — the client is tested against a stand-in.
- **dc-metro-take-2's last bake** had 12 coarse pyramid tiles with no NAIP, painted the mean colour.
- **Dev container fixed but never built** — Rich's first build is its first test.
- **The cluster deployment's acceptance items** — publish/deploy, the OSM-region import, a splat
  training run. See [ACCEPTANCE.md](ACCEPTANCE.md).
