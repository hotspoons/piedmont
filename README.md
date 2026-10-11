# piedmont

Piedmont turns a piece of the real world into a game world you can drive in a browser. You draw an
area on a map, and piedmont bakes it from public data (OpenStreetMap roads, elevation, lidar,
aerial imagery and vegetation records); then you dress it, script a game on it in the built-in
editor, and publish it to Cloudflare as a website anyone can play.

Everything runs from one web app, the **world editor**, backed by a small set of services you host
yourself.

## Run it

The whole backend (the world editor, the asset service, an OpenStreetMap query server and the bake
runner) runs on one Docker host:

```bash
cd deploy/docker
cp .env.example .env
docker compose up -d
# then open http://localhost:8780/world.html
```

The AI services that generate images and 3D models are a separate, optional stack, so they can run
on another machine or be replaced by a hosted endpoint. A Kubernetes install with Helm charts is
also provided.

The Docker stack has been validated statically but not yet run end to end on a host. The Helm
charts are what the reference deployment runs.

[Running piedmont →](docs/guide/running.md)

## Create a world

1. Open the world editor and find a place: search by name or paste `lat, lon`.
2. **World → Define**: drag a square or click out a polygon, name the world, and choose its roads:
   every street, or a list of named roads with one picked as the spine.
3. **World → Bake**: press **Bake** and watch the run's log. Worlds wider than 10 km are cut into
   blocks and baked in parallel automatically.

A bake reads OpenStreetMap through Overpass, the USGS 1 m elevation model, USGS and NOAA lidar point
clouds, NAIP aerial photos, LANDFIRE vegetation and Macrostrat geology. Outside the United States it
falls back to Copernicus 30 m elevation, Sentinel-2 imagery and a global canopy-height model.

[Creating worlds →](docs/guide/worlds.md)

## Play it

Open a baked world in the browser at `/#<world>`. A deployed world opens as a game: an Escape menu
for settings, rebindable keys, gamepad support with rumble, and a full-screen map. The default keys
are W/A/S/D to drive, Left Shift for the handbrake and R to recover the car.

[Playing →](docs/guide/playing.md)

## Make a game with the built-in editor

The world editor has a mode for every step:

| Mode | What you do there |
|---|---|
| **Place** | correct what the bake got wrong, place props, paint traffic zones, stand up stunts, mark start and finish points, lay out race gates |
| **Stage** | turn a world into a level: the car you drive, time of day, weather, traffic, where it starts and which level comes next |
| **Assets** | the library: models, materials, vehicles (handling, engine, sounds), actors, weapons, sounds, building textures |
| **Program** | write the level's game logic in TypeScript, with type checking, completion and a dry run |
| **Shell** | a command line in the browser over the editor's own documents |

An AI agent can drive the editor too: it serves an MCP endpoint with tools for worlds, levels,
programs, assets and bakes.

- [The editor →](docs/guide/editor.md)
- [Writing a game program →](docs/guide/programs.md)
- [Driving the editor with an AI agent (MCP) →](docs/guide/mcp.md)

## Generate assets with AI

Describe a prop and the asset service draws it with FLUX.2, turns your chosen picture into a
textured 3D model with TRELLIS.2, and finishes it for the game. The model endpoints are plain URLs:
run them yourself with the provided compose file, use the ones on your cluster, or point at a
hosted service.

[Generating assets →](docs/guide/assets-ai.md)

## Publish to Cloudflare

**Deploy** mode uploads one or more baked worlds, with their levels, programs and only the assets
they use, to an R2 bucket, and publishes the game as a Cloudflare Worker on `workers.dev` or your
own hostname. The deploy client is covered by tests against a stand-in for Cloudflare's API; a
deploy from a piedmont install of its own has not been proved yet.

[Deploying to Cloudflare →](docs/guide/cloudflare.md)

## More

- [The user guide](docs/guide/README.md), and a [map of all the docs](docs/README.md).
- Working on piedmont itself: see [DEVELOPING.md](DEVELOPING.md).

## Licence

Apache-2.0. See [LICENSE](LICENSE), [NOTICE](NOTICE) and [CREDITS.md](CREDITS.md).
