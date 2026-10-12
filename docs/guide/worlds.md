# Creating worlds

A **world** is a piece of the real world baked into something the game can draw and drive: terrain,
roads with their lanes and junctions, bridges, trees, buildings, water and imagery. You create one
in the world editor's **World** mode, which has three steps along its tab strip: **Explore**,
**Define** and **Bake**. A tick on a step means it is done for the selected world; you can move
between the steps freely.

Open the world editor at `/world.html` on your install ([Running piedmont](running.md)).

## 1. Explore: find a place

The map shows more detail as you zoom in: country outlines and major cities at the start, towns from
zoom 6, motorways from zoom 7, and every drivable street (the roads a bake will use) from zoom 11.
The side panel says what is loaded, and why the map is empty when it is.

- **Search** (the box in the top bar, or press `/`): a place name, or a coordinate as `lat, lon`.
  A result is framed at its own size: a country fills the screen, a street is close up.
- **New world here** (or press `N`) starts a new world and switches to Define.
- **Overpass status** says which OpenStreetMap server answered, and whether the editor fell back to
  a public mirror.
- **OSM data** (also under Settings → Services) opens the OSM data dialog: each instance's coverage,
  which instance each world reads from, and adding data to an instance — a named region, or a shape
  you **draw and build** (see [Where the OpenStreetMap data comes from](#where-the-openstreetmap-data-comes-from)).

The world picker on the left of the top bar lists every world on this install, baked or not. The
globe button beside it opens the selected world in the game.

## 2. Define: draw it and choose its roads

**Selection.** Choose **Square** and drag a box, or **Polygon** and click points around the area
(click the first point again to close it; drag a point to move it, click an edge to add one,
Backspace removes the selected point). **Use the current view** takes whatever is on screen.

**Route** is the third mode, for following several long roads across a region rather than baking a
box. Click a road to select just it; **Ctrl/Cmd-click** adds or removes one, so you can pick as many
as you like (I‑70 *and* US‑15, say). Each picked route shows a green **start** marker and an orange
**end** marker; press **start** or **end** on a row in **Roads** and then click the road to move that
marker, and the bake keeps only the stretch between them. With no Square/Polygon area drawn, a
route is bounded to whatever is on screen when you save — draw the region first if you want a
larger one.

**Name.** Type a name; the slug (the world's id in files and URLs) is derived from it and fixed once
the world is saved. A description is optional.

**Extent.** For a square, the **half-width** slider sets half the side of the square the bake takes
(150 m to 12 km). A drawn polygon is baked as that shape, and ground outside it is not fetched.
There is no size ceiling: a world too big for one bake is sharded automatically (see **Bake**
below), and the editor states the area and the grid it will become.

**Contents** reports how many road ways and kilometres of road the bake will take.

**Roads.**

- **Every street**: every drivable road in the area.
- **Named roads**: click roads on the map to add them (shift-click toggles). Only those are baked.
  In **Route** selection this is the multi-road picker: click selects one, Ctrl/Cmd-click adds or
  removes one, and each picked road gets a **start** and an **end** so you can bake only part of it.
- **Spine**: the main road of the world. It is the road the game measures most carefully and the
  default place you start. A route world's spine is one of its roads.

**Look.** The defaults the world opens with: **style** (Realistic or Fantasy), **season**,
**terrain relief** (an exaggeration factor, 1 = as measured) and, optionally, a fixed **water
level**. A player can still change season and style, and a link can override them with `?season=`
and `?style=`.

**Surfaces** (collapsed) lets you pick a texture from the library for a road or ground role. Leave
a role on its default unless this world needs something else.

Press **Create world** (or **Save changes**). A baked world also gets a **Delete** button here,
which removes the world and its bake.

**Import a baked world…** (on a new world) takes a `.zip` downloaded from another install and adds
it without baking.

## 3. Bake

Select the world and open **Bake**. The panel shows where bakes run (`docker`, Kubernetes Jobs, or a
`local` process), the world's definition, and when it was last baked.

Press **Bake** (or **Re-bake**). The run opens in a log window that follows it live; you can close
the window and come back, or cancel the run. **Runs** at the bottom of the panel lists past runs.
When a bake finishes, **Open in the viewer** plays the world and **Open in the editor** opens it in
the place editor.

**How long:** from a few minutes for a world a kilometre or two across, to hours for a metropolitan
area. Everything downloaded is cached on the volume, so a re-bake is much faster.

**Large worlds are sharded.** A world more than 10 km across (half-width over 5 km) is baked in
pieces: a plan step, then blocks of up to 10 km a side baked in parallel (up to 36 of them), then a
finalize step that joins them. This happens automatically when bakes run as containers or
Kubernetes Jobs. The **Bake** panel shows what the selected world will become and lets you cap it:
**One Job** bakes it whole, or pick a block count for fewer, larger blocks (more memory each) or
more, smaller ones (wider spread). With the `local` runner, keep worlds small. The thresholds come
from the environment (`PIEDMONT_EDITOR_SHARD_ABOVE_M`, `PIEDMONT_EDITOR_SHARD_SIDE_M`,
`PIEDMONT_EDITOR_MAX_SHARDS`).

**Download** saves the baked world as a `.zip` (*viewer files only* leaves out the source rasters
and is much smaller) to import on another install.

**Publish** appears when a bucket is configured (`PIEDMONT_EDITOR_S3_*`). It mirrors baked worlds
to that S3-compatible bucket; **Dry run** lists what would be uploaded. This is separate from
publishing a playable game to Cloudflare, which is the Deploy mode ([guide](cloudflare.md)).

## What a bake downloads

| Layer | In the United States | Elsewhere |
|---|---|---|
| roads, buildings, land use, waterways | OpenStreetMap via Overpass | the same |
| elevation | USGS 3DEP bare-earth DEM (1 m where available) | Copernicus GLO-30 (30 m, a surface model) |
| point cloud: bridges, overpasses, canopy, cut slopes, building heights | USGS 3DEP and NOAA Digital Coast lidar | none; tree heights come from the Meta/WRI global 1 m canopy-height model |
| aerial imagery | NAIP (0.3 to 0.6 m), from Microsoft's Planetary Computer, with USGS as a fallback | Sentinel-2 (10 m) |
| vegetation and species | LANDFIRE vegetation types, USFS forest inventory species, Daymet climate | the game picks ground cover and trees from OSM land use instead |
| geology (rock in cut faces) | Macrostrat | Macrostrat |
| far horizon | 30 m elevation out to 30 km | the same sources |

Where lidar exists, the bake measures bridges you drive on, overpasses above you and rock cuts
beside the road from the classified points rather than guessing. Where it does not, the world still
bakes, with less detail in those places.

Outside the United States the roads, geology and canopy are as good as at home; the 30 m elevation
and 10 m imagery are coarser. The elevation model is a surface model, so in woodland the ground can
sit on the tree tops.

Licences: USGS, NAIP and LANDFIRE data are public domain; OpenStreetMap is ODbL and Macrostrat and
the Meta/WRI canopy model are CC-BY, so attribution is required. The game shows a small attribution
for the sources a world was built from.

## Where the OpenStreetMap data comes from

Bakes ask your own Overpass instances first, routed by which regions each one holds, and fall back
to the public Overpass mirrors for anywhere none of them covers. **World → Explore → OSM data** (also
under Settings → Services) shows each instance's coverage on a map, which instance each world reads
from, and adds data to an instance. There are two ways to add data; both run as a job like a bake,
with a log, and are listed together while they run:

- **Add a Geofabrik region**: the named extract (a state, a country), downloaded whole.
- **Build a drawn area**: pick an instance, draw a shape on the coverage map, and build it. The job
  downloads the smallest Geofabrik extract(s) that cover the shape, clips them to it, and applies
  only what is inside — the way to take a subset of a big area instead of importing all of it. A
  drawn area is a **snapshot**: it is not kept current by diffs (the extract it is cut from also
  covers ground outside the shape), so re-draw and rebuild it to refresh.

If a world was baked from stale or wrong OSM data, a bake request with `"refreshOsm": true` asks
Overpass again instead of using the cache.

## Over the API

Everything above is also an HTTP API on the world editor (and MCP tools, see [mcp.md](mcp.md)):

```bash
# define a world from a bundle
curl -X POST -H 'content-type: application/json' localhost:8780/api/worlds/import \
  -d '{"kind":"piedmont-worlds","worlds":[{"slug":"my-world","lat":39.02,"lon":-76.68,"radius_m":900}]}'

# bake it; the reply carries the run id
curl -X POST -H 'content-type: application/json' localhost:8780/api/runs/bake -d '{"slug":"my-world"}'

# follow it
curl localhost:8780/api/runs/<run-id>
curl 'localhost:8780/api/runs/<run-id>/log?offset=0'
```

The bake request also takes `"sharded": true|false` to force or skip sharding, and
`"refreshOsm": true`.

Next: [play it](playing.md), or [dress it and make a level](editor.md).
