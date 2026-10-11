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

## Also open

- **Cloudflare deploy from a piedmont install is unproven** — the client is tested against a stand-in.
- **dc-metro-take-2's last bake** had 12 coarse pyramid tiles with no NAIP, painted the mean colour.
- **Dev container fixed but never built** — Rich's first build is its first test.
- **The cluster deployment's acceptance items** — publish/deploy, the OSM-region import, a splat
  training run. See [ACCEPTANCE.md](ACCEPTANCE.md).
