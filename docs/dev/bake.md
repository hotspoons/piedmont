# The bake

`bake/` is the Python package `piedmont_bake`. It pulls everything the public record knows about a
place and writes one directory, `$PIEDMONT_DATA/sites/<slug>/`, with a `web/` subtree the game
reads. Nothing is generated in the browser that could have been computed here, and nothing here
knows what a three.js mesh is.

Its own README, [bake/README.md](../../bake/README.md), lists every file a site directory holds
and the traps in each source. This page is the map.

## Running it

```bash
cd bake
.venv/bin/python -m piedmont_bake fetch <slug>          # bake one site (or `all`); --skip lidar for a quick pass
.venv/bin/python -m piedmont_bake export <slug>         # rewrite web/ without fetching again
.venv/bin/python -m piedmont_bake plan|shard|finalize   # a sharded bake, step by step (finalize --prune drops intermediates)
.venv/bin/python -m piedmont_bake prune <slug|all>     # reclaim a shipped world's intermediates (--all, --dry-run)
.venv/bin/python -m piedmont_bake publish <slug>        # mirror to an S3-compatible bucket
.venv/bin/python -m piedmont_bake.verify                # is every site safe to publish?
.venv/bin/python -m unittest discover -s tests          # the unit tests
```

Other subcommands: `sites` (photos → `sites.json`), `report`, `context`, `vectors`, `promote` /
`rollback` (swap a staged export live), `flora`, `areas` (propose adjustment polygons). The `just
bake-*` recipes wrap the common ones.

It reads its site list from `sites.json` (`$PIEDMONT_SITES`) and writes `$PIEDMONT_DATA`. The
world editor does not call these by hand: it materialises its worlds into `sites.json` on the
volume and runs `fetch` (or the three sharded phases) as a local process, a Kubernetes Job or a
Docker container, always with `PIEDMONT_PYRAMID=1`. Every world drawn in the editor is a **network**
site (`kind: "network"`: every road chained, the primary as the spine, the rest as branches with
junctions) baked into a pyramid.

## The stages of `fetch`

| Stage | Module | What it produces |
|---|---|---|
| frame | `geo.py` | the site's UTM projection for fetching, its geodetic anchor, and `Frame.to_enu3`, which every coordinate the bake writes goes through ([frames.md](frames.md)) |
| roads | `osm.py`, `network.py` | the spine and branches as chains with tags by along-track metre, crossings, junctions, dead ends, driveways and stubs; every tagged feature in the area as `osm.geojson` |
| elevation | `dem.py`, `horizon.py` | USGS 3DEP bare earth (1 m, else 1/9 or 1/3 arc-second), Copernicus GLO-30 outside the US; a 30 m horizon out to 30 km |
| imagery | `naip.py`, `naip_pc.py` | NAIP from the Planetary Computer (one year chosen for the whole world, older flights fill holes), USGS ImageServer as a fallback, Sentinel-2 outside the US |
| point cloud | `lidar.py`, `lidar_sources.py` | USGS and NOAA Entwine (EPT) octrees walked directly (no PDAL), TNM delivery tiles as the last resort; ground, surface, canopy, bridge-deck and building rasters at 1 m, the along-track profile, detected structures |
| canopy fallback | `canopy.py` | the Meta/WRI global canopy model wherever lidar did not cover |
| flora | `flora.py` | LANDFIRE classes, species mix, ground cover, Daymet climate ([flora.md](flora.md)) |
| geology, cuts, rock, water | `geology.py`, `cuts.py`, `rock.py`, `water.py` | Macrostrat units; cut faces from DTM transects with rock type; exposed rock; waterways snapped to the lidar's low line, falls and rapids |
| junctions, sidewalks, buildings | `intersections.py`, `walkways.py`, `buildings.py` | junction control and signal phases ([roads.md](roads.md)); sidewalk zones; footprints with measured heights and points of interest |
| surface | `surface.py` | pavement class every 20 m from lidar intensity, imagery brightness and OSM |
| export | `export.py`, `network_tiles.py`, `pyramid.py`, `grade.py`, `ktx2.py` | the `web/` tree: manifest, vector tiles, the LOD pyramid with graded ground and KTX2 twins ([terrain.md](terrain.md)), `sites/index.json` |

`manifest.json` beside the site records what was fetched, from where, when and how long.
**Everything downloaded is cached** under `$PIEDMONT_DATA/cache/` (Overpass responses by query
hash, DEM and NAIP pieces, lidar), so a re-bake is mostly offline.

## Sharded bakes

A world too big for one job goes **plan → shard → finalize** (`shards.py`):

1. **plan** (one small job): resolves the frame, runs the road query once over the whole region,
   decides dead ends once (they are a property of the whole graph), and assigns each chain whole to
   one shard and each 1 km tile to one shard. Road identity is fixed here and cannot change per
   shard.
2. **shard** (N jobs in parallel): each fetches and profiles its own block plus a padding margin,
   and writes `shards/<i>/` in the site layout.
3. **finalize** (one job): mosaics the per-shard rasters, unions tiles and branches, stitches the
   primary road's profile by cumulative `s`, de-duplicates features by OSM id, fetches the global
   canopy where lidar left gaps, and runs the same `export_site` a single bake runs. Once `web/` is
   written it prunes the intermediates it no longer needs (`--prune`, which the world editor passes by
   default): `shards/`, the merged `lidar/`, `canopy_global.tif` and the mosaic `.ovr`s. A finished
   world is `web/` — the manifest references nothing else — so leaving them is what filled the 500 Gi
   bake volume. `piedmont_bake prune <slug|all>` does the same to an already-shipped world; keep the
   intermediates for a re-export with `PIEDMONT_KEEP_INTERMEDIATES=1`, or drop the merged rasters too
   with `--all`.

The world editor shards automatically above a 5 km half-width, in blocks of at most 10 km, up to
36 of them (`PIEDMONT_EDITOR_SHARD_ABOVE_M`, `_SHARD_SIDE_M`, `_MAX_SHARDS`); a bake request's
`"sharded": false|true` overrides. Sharding needs a Job runner (Kubernetes or Docker), and shards
spread across nodes with topology spread constraints. A large block peaked near 139 GiB of memory
on the reference cluster, which is what the default bake resources are sized for.

## Data sources and their traps

These cost real time. Each is written up at the code that handles it and in
[bake/README.md](../../bake/README.md):

- **Services say "not here" with a success.** Overpass, NAIP and Macrostrat all answer an
  out-of-coverage request with HTTP 200 and nothing in it. A regional Overpass instance asked about
  a box outside its extract returns zero ways, indistinguishable from the sea. Assert content
  against a control, never the status. The bake refuses an Overpass query its instance does not
  hold (`BakeFault`), and the world editor routes each world by the extracts' real outlines.
- **NAIP no-data is exact zero, and survives JPEG as 1 or 2.** Every NAIP read fills it; "no
  imagery" is a threshold (`NAIP_BLANK_MAX`), and a sharded bake's empty shard shows as a black
  square until its stage is re-run and the merged overviews rebuilt.
- **The DEM deletes bridges.** That is why the point cloud comes too: class 17 (bridge deck) is
  labelled, not inferred.
- **Python writes `NaN` into JSON**, and `JSON.parse` refuses the whole file. Fill or guard
  anything sampled from a raster that can be nodata.
- **A pre-2010 lidar delivery may carry no CRS** (and feet). Prefer a newer project before guessing
  one; the guess is self-validating (the right CRS lands the points in the road band).
- **Bounding a smoothed line's vertices does not bound the line**: pull each point toward the raw
  line at its own station, not the nearest point.

## Outside the United States

Roads and geology work worldwide. Elevation falls back to Copernicus GLO-30 (30 m, a surface model:
fine above the treeline, the ground rides on the canopy in woodland), imagery to Sentinel-2 at
10 m, canopy to the global model; there is no lidar, so structures and cut slopes are not measured.
Road identity can break at a language border. The measurements behind each decision are in
[specs/DATA-OUTSIDE-US.md](specs/DATA-OUTSIDE-US.md).

## Our own Overpass

Bakes and the editor's map query our own Overpass instances first (one US state, North America,
Europe), and the public mirrors only where none holds the area. How the instances are imported,
kept current and extended is in [services.md](services.md#overpass) and
[services/overpass/README.md](../../services/overpass/README.md); the continent-scale import is
written up in [specs/OVERPASS-PLANET.md](specs/OVERPASS-PLANET.md).

## Further reading

- [specs/PIPELINE.md](specs/PIPELINE.md): the whole chain from a photo to a drivable road, stage by
  stage, as first written (some details have since moved).
- [specs/PLAN-SHARDED-BAKE.md](specs/PLAN-SHARDED-BAKE.md),
  [specs/PLAN-OPEN-WORLD.md](specs/PLAN-OPEN-WORLD.md),
  [specs/DESIGN.md](specs/DESIGN.md) (detection rules with their thresholds).
- [project/SITES.md](project/SITES.md): what each early bake held (generated by
  `python -m piedmont_bake.sitesdoc`).
