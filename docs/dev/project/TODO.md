# Tracked TODOs

The living list of known issues and deferred work. [HANDOFF.md](HANDOFF.md) is the split's
snapshot; this file is where the open items are tracked and closed. Add an item here when it is
found, and check it off (or delete it) when it is fixed, with the commit or link.

## Known issues, by area

| # | TODO | Area | Notes |
|---|---|---|---|
| 1 | **World editor: Assets mode has no Traffic tab** | editor | traffic sets are only editable from `/editor.html`'s Assets dialog or MCP. Looks like a bug. |
| 2 | **Stage panel has no control for a level's `program` or traffic `set`** | editor | the guide sends users to Shell mode or MCP `level_save`. |
| 3 | **Geofabrik's published index can have empty region outlines** | services/worldeditor | 11 regions on 2026-10-10, `virginia.poly` 0 bytes. Routing refuses empty outlines and falls back to the volume's copy or the seed (`services/worldeditor/geofabrik.mjs`); an OSM import of Virginia may fail until Geofabrik fixes its files. |
| 4 | **Lidar canopy includes roofs** | bake / flora | where a vendor left buildings unclassified; the game masks OSM footprints out of tree planting. The perf panel's tree lines explain bare ground cell by cell. |
| 5 | **Port `agent/mcp-fixes` into piedmont** | editor / services | The arcade branch (`agent/mcp-fixes`, tip `c4be424`) fixed the MCP tools and was never merged, so none of it is here. Seven of ten findings still reproduce against today's code; port by intent — see [specs/PLAN-MCP-PORT.md](../specs/PLAN-MCP-PORT.md). Open: the document channel, explicit `shell_exec` cwd, `program_delete` on a folder, schema fixes, `projectedAt` for `shell_list`, `code_outline` flags, `code_definition` on API symbols, `program_list` `id`/`path`, and `ensureMachine()`. |

## Recently fixed

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
