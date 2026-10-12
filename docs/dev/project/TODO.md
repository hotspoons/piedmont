# Tracked TODOs

The living list of known issues and deferred work. [HANDOFF.md](HANDOFF.md) is the split's
snapshot; this file is where the open items are tracked and closed. Add an item here when it is
found, and check it off (or delete it) when it is fixed, with the commit or link.

## Known issues, by area

| # | TODO | Area | Notes |
|---|---|---|---|
| 3 | **Geofabrik's published index can have empty region outlines** | services/worldeditor | 11 regions on 2026-10-10, `virginia.poly` 0 bytes. Routing refuses empty outlines and falls back to the volume's copy or the seed (`services/worldeditor/geofabrik.mjs`); an OSM import of Virginia may fail until Geofabrik fixes its files. |
| 4 | **Lidar canopy includes roofs** | bake / flora | where a vendor left buildings unclassified; the game masks OSM footprints out of tree planting. The perf panel's tree lines explain bare ground cell by cell. |
| 6 | **Tiled network: the per-tile-set OSM query** | bake | Phase 1 stops holding the whole network in one process — plan/query Overpass or clip a Geofabrik extract per tile-set. See Phase 1. **The next real step on the tiled network**: `roads()` still queries the whole site bbox and merges chains globally, so `plan` holds whole 100 km+ chains (`write_tilesets` then cuts them). The per-tile-set *sourcing* is what removes the long polies; the consumers are Phases 2–4. |
| 8 | **MCP config leaks the bearer token to an unauthenticated caller** | services/worldeditor | `GET /api/agent/mcp/config` returns `auth.token` in the clear (`mcpauth.describe()`, deliberately, so the Agent tab can show it) — but the deployed host answered that GET with no credentials, so the token (which gates `shell_exec`, `program_write`, …) is readable by anyone who can reach the ingress. The code assumes the ingress authenticates; empirically it does not in front of this path. Fix is a deployment/auth decision (gate the route, or front the editor with auth), not a unilateral code change — Rich's call. |
| 9 | **The bake volume fills and the worldeditor crash-loops** | ops | `worldeditor-data` is a 500 Gi PVC and it reached 100% on 2026-10-12: a sharded bake keeps its intermediates (`sites/<slug>/shards/`, `lidar/`, the per-shard `dem_1m.tif`) forever, so two big worlds plus the caches (`cache/ept` 236 Gi, `cache/usgs1m` 50 Gi) filled it. With no space the worldeditor dies on boot writing `coverage.json` (`EDQUOT`, errno -122) and a finalize dies inside `gdaladdo`. Nothing prunes a finished bake's intermediates, and the PVC has no growth/alerting. Needs an ops decision: prune `shards/`+`lidar/` after `finalize`, cap or evict `cache/ept`, or grow/split the volume. Freed by hand on 2026-10-12 (`cache/usgs1m`, `cache/laz`). |

## Recently fixed

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
