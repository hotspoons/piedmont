# Tracked TODOs

The living list of known issues and deferred work. [HANDOFF.md](HANDOFF.md) is the split's
snapshot; this file is where the open items are tracked and closed. Add an item here when it is
found, and check it off (or delete it) when it is fixed, with the commit or link.

## Known issues, by area

| # | TODO | Area | Notes |
|---|---|---|---|
| 2 | **Stage panel has no control for a level's `program` or traffic `set`** | editor | the guide sends users to Shell mode or MCP `level_save`. |
| 3 | **Geofabrik's published index can have empty region outlines** | services/worldeditor | 11 regions on 2026-10-10, `virginia.poly` 0 bytes. Routing refuses empty outlines and falls back to the volume's copy or the seed (`services/worldeditor/geofabrik.mjs`); an OSM import of Virginia may fail until Geofabrik fixes its files. |
| 4 | **Lidar canopy includes roofs** | bake / flora | where a vendor left buildings unclassified; the game masks OSM footprints out of tree planting. The perf panel's tree lines explain bare ground cell by cell. |
| 6 | **Tiled network: the per-tile-set OSM query** | bake | Phase 1 stops holding the whole network in one process — plan/query Overpass or clip a Geofabrik extract per tile-set. See Phase 1. |
| 7 | **MCP port: prove it in a real browser** | editor / services | the port is in and unit-tested (`316d583`); the remaining acceptance item is a real-browser check with the Shell tab never opened. See [specs/PLAN-MCP-PORT.md](../specs/PLAN-MCP-PORT.md) *Done when*. |

## Recently fixed

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
- **World editor: Assets mode had no Traffic tab** — `worldedit/main.ts` built its `AssetCatalog`
  without `trafficExtension()`, which `editor/main.ts` and the viewer both pass, so traffic sets could
  only be edited from `/editor.html` or MCP. Wired in; Assets mode now shows Catalog, Materials,
  Service, Blender, Vehicles, Actors, Weapons, **Traffic**, Fixtures, Sounds, Buildings (verified in a
  headless browser against `/world.html`).
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
