# Specs: design notes, plans and handoffs

The working documents the project was built from: designs, plans, audits, spikes, handoffs and
measurement logs. They are kept because they record **why** things are the way they are, with the
numbers that decided it. They are not maintained as reference: many describe plans that have since
landed, partly landed or changed, and each one's own status line is as of when it was written.
For how things work now, read the pages in [docs/dev](../README.md) and the code.

## Design and reference notes

| Doc | About | Distilled into |
|---|---|---|
| [DESIGN.md](DESIGN.md) | the rules the code is built on: frames, the one-height rule, the LOD footprint, grass tiles, every detection rule with its threshold, sign conventions | [terrain](../terrain.md), [roads](../roads.md), [bake](../bake.md) |
| [PIPELINE.md](PIPELINE.md) | from a photo to a drivable road: every bake stage and viewer step as first written | [bake](../bake.md) |
| [FLORA.md](FLORA.md) | trees and ground cover from LANDFIRE, FIA and Daymet: sources, readouts, traps | [flora](../flora.md) |
| [LANES-AND-SIGNALS.md](LANES-AND-SIGNALS.md) | audit of lanes and signals: what OSM has and what was thrown away | [roads](../roads.md) |
| [GAME-MODE.md](GAME-MODE.md) | the game and developer views, the Escape menu, policy, finish screen, input | [traffic and game](../traffic-and-game.md), [user guide](../../guide/playing.md) |
| [SOUNDS.md](SOUNDS.md) | the sound bank, slots, overrides, the sound board | [traffic and game](../traffic-and-game.md#audio) |
| [STYLES-AND-GAMES.md](STYLES-AND-GAMES.md) | styles, play knobs, and the first game ideas | [rendering](../rendering.md) |
| [DATA-OUTSIDE-US.md](DATA-OUTSIDE-US.md) | baking outside the US: GLO-30, Sentinel-2, global canopy, measured | [bake](../bake.md#outside-the-united-states) |
| [OVERPASS-PLANET.md](OVERPASS-PLANET.md) | importing continent-scale Overpass instances | [services](../services.md#overpass) |
| [PERF-RIG.md](PERF-RIG.md) | the rig loop on the DC Beltway: every measurement and fix | [performance](../performance.md) |
| [DEPLOY.md](DEPLOY.md) | the Cloudflare deploy's design | [services](../services.md#the-cloudflare-deploy), [user guide](../../guide/cloudflare.md) |
| [SPIKE-water-gerstner.md](SPIKE-water-gerstner.md) | realistic water: Gerstner waves, depth extinction, shore foam | [rendering](../rendering.md) |

## Plans

| Doc | About |
|---|---|
| [PLAN-PORTABLE-ENGINE.md](PLAN-PORTABLE-ENGINE.md) | one simulation, many targets: a wasm game loop with a host/guest API, a native host, and more dynamics than driving |
| [PLAN-WORLD-SCALE.md](PLAN-WORLD-SCALE.md) | the map from a road band to a world of any size; points at the three below |
| [PLAN-OPEN-WORLD.md](PLAN-OPEN-WORLD.md) | from a road band to a world: trees and ground not tied to roads |
| [PLAN-STREAMING-WORLD.md](PLAN-STREAMING-WORLD.md) | from a compiled site to a streamed world |
| [PLAN-SHARDED-BAKE.md](PLAN-SHARDED-BAKE.md) | baking a large world in pieces: plan → shard → finalize |
| [PLAN-OVERPASS-DRAWN.md](PLAN-OVERPASS-DRAWN.md) | adding a polygon drawn in the editor to an Overpass instance: the smallest-extract pick, and why it is a snapshot |
| [PLAN-MONOLITHS.md](PLAN-MONOLITHS.md) | what the game still loads whole, measured, and the order to break it up |
| [PLAN-GRADE-SEPARATION-RENDER.md](PLAN-GRADE-SEPARATION-RENDER.md) | grade-separated crossings: the DEM, the underside, the ground |
| [PLAN-STREET-FURNITURE.md](PLAN-STREET-FURNITURE.md) | signs, kerbs, walks, trails and rail |
| [PLAN-PHYSICS.md](PLAN-PHYSICS.md) | Rapier in the engine and how it is wired into the world |
| [PLAN-VEHICLES-ACTORS.md](PLAN-VEHICLES-ACTORS.md) | vehicle, actor and weapon documents in the asset library |
| [PLAN-TRAFFIC-AND-RAGE.md](PLAN-TRAFFIC-AND-RAGE.md) | the traffic model, and two games that need it |
| [PLAN-RACES-TRAFFIC.md](PLAN-RACES-TRAFFIC.md) | traffic zones, circuits and stages, stunts, and a running log of what landed |
| [PLAN-GAME-PIPELINE.md](PLAN-GAME-PIPELINE.md) | from a real place to a playable level: presets, ECS config, programs |
| [PLAN-EDITOR-IDE.md](PLAN-EDITOR-IDE.md) | the editor as a web IDE over the ECS, the assets and the map |
| [PLAN-SPLAT-ROUTES.md](PLAN-SPLAT-ROUTES.md) | putting a captured gaussian-splat world inside the built one |
| [PLAN-RIGGING.md](PLAN-RIGGING.md) | rigging vehicles and characters with Blender |
| [PLAN-AUTH.md](PLAN-AUTH.md) | accounts, roles and per-user worlds in the world editor (not started) |

## Handoffs

| Doc | About |
|---|---|
| [HANDOFF-CAR-LIBRARY.md](HANDOFF-CAR-LIBRARY.md) | building a library of car models with the image and mesh models |
| [HANDOFF-SPLAT-CAPTURE.md](HANDOFF-SPLAT-CAPTURE.md) | turning a 360° capture into a splat world |
