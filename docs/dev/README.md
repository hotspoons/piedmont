# Developing the engine

For engineers working on piedmont's open-world engine: the game runtime, streaming, rendering,
physics, traffic, the bake and the services. Set-up, the dev servers and the test gate are in
[DEVELOPING.md](../../DEVELOPING.md); start there if you have not built the project yet.

## Pages

| Page | What it covers |
|---|---|
| [architecture.md](architecture.md) | what lives where and how the pieces talk; the checks |
| [frames.md](frames.md) | coordinate frames: WGS84 authority, ENU about a geodetic anchor, three.js axes, rebasing, what was measured |
| [terrain.md](terrain.md) | road-band, network and world bakes; the LOD pyramid and how it streams; the graded ground; "one surface, one height function"; budgets and the frame governor |
| [rendering.md](rendering.md) | the renderer and reversed depth, the look pipeline (season, weather, style), materials, Detail and the tuning panel, shader traps |
| [flora.md](flora.md) | canopy height, LANDFIRE and FIA species, ground cover; near trees, impostors, grass |
| [roads.md](roads.md) | the road network from OSM, junction control and signals, lanes, furniture, sign conventions |
| [physics.md](physics.md) | Rapier in the shared engine, the five handling profiles, how the game binds it to a world |
| [traffic-and-game.md](traffic-and-game.md) | the ECS, traffic (IDM, zones, sets), levels, programs, races and stunts, game mode, the finish screen, audio |
| [bake.md](bake.md) | the bake's stages and data sources, sharded bakes, outside the US, the traps in public data |
| [services.md](services.md) | the world editor, the asset service, Overpass, recon, and the Cloudflare deploy internals |
| [performance.md](performance.md) | how to measure (the bridge, the rig, the wake lock), what was fixed, what is left |
| [arcade.md](arcade.md) | the shared `@apex` engine packages: what is in them, when to change them, and how, through `ext/siomporas-arcade` |

## Also here

- [specs/](specs/README.md): design documents, plans, spikes and handoffs. They record why things
  are the way they are, with their measurements; some describe plans that have since landed or
  changed, so check the code before relying on a detail.
- [project/](project/): [HANDOFF.md](project/HANDOFF.md) (where the split stands and what is next — start here),
  [TODO.md](project/TODO.md) (the tracked known issues and open work),
  [ORIGIN.md](project/ORIGIN.md) (the split from siomporas-arcade and how to
  port a later change from it), [ACCEPTANCE.md](project/ACCEPTANCE.md) (the split's criteria and
  what proves each), [SITES.md](project/SITES.md) (what the early bakes held, generated).
- [history/](history/): session logs from the project's first days.

Beside the code: [apps/game/README.md](../../apps/game/README.md),
[apps/game/src/editor/README.md](../../apps/game/src/editor/README.md) (the place editor),
[bake/README.md](../../bake/README.md), the services' READMEs, and the pipelines' READMEs under
`pipelines/`.
