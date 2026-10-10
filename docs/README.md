# Docs

Everything here is about piedmont. The services' and pipelines' own pages sit beside their code;
[ARCHITECTURE.md](ARCHITECTURE.md) links each one.

## Start here

- [ARCHITECTURE.md](ARCHITECTURE.md) — Architecture
- [ARCADE.md](ARCADE.md) — The arcade dependency
- [ORIGIN.md](ORIGIN.md) — Origin: where this came from, and how to port a later change
- [ACCEPTANCE.md](ACCEPTANCE.md) — Acceptance: the split's criteria and what proves each

## The game

- [DESIGN.md](DESIGN.md) — Design — the rules the code is built on
- [FRAME.md](FRAME.md) — The frame: geodetic authority, ENU rendering, a floating origin
- [GAME-MODE.md](GAME-MODE.md) — Game mode
- [LANES-AND-SIGNALS.md](LANES-AND-SIGNALS.md) — What we know about lanes and signals, and what we throw away
- [FLORA.md](FLORA.md) — Flora — the right trees and the right ground, from the public record
- [SOUNDS.md](SOUNDS.md) — Sounds
- [STYLES-AND-GAMES.md](STYLES-AND-GAMES.md) — Styles, play knobs, and the first two games
- [PERF-RIG.md](PERF-RIG.md) — The rig loop: 60 fps on the DC Beltway
- [SPIKE-water-gerstner.md](SPIKE-water-gerstner.md) — Spike — realistic water (Gerstner + depth extinction + shore foam)

## The bake and the data

- [PIPELINE.md](PIPELINE.md) — Pipeline — from a photo to a drivable road
- [SITES.md](SITES.md) — Sites — what each bake actually holds
- [DATA-OUTSIDE-US.md](DATA-OUTSIDE-US.md) — Baking outside the United States
- [OVERPASS-PLANET.md](OVERPASS-PLANET.md) — The full world pull

## Deploying

- [DEPLOY.md](DEPLOY.md) — Deploying a world to Cloudflare
- [CLOUDFLARE.md](CLOUDFLARE.md) — Cloudflare: what the deploy needs from the account

## Plans

- [PLAN-AUTH.md](PLAN-AUTH.md) — Plan: accounts, roles and per-user worlds in the world editor
- [PLAN-EDITOR-IDE.md](PLAN-EDITOR-IDE.md) — The editor: a web IDE over the ECS, the assets, the map — and now physics
- [PLAN-GAME-PIPELINE.md](PLAN-GAME-PIPELINE.md) — The game pipeline: from a real place to a playable level
- [PLAN-GRADE-SEPARATION-RENDER.md](PLAN-GRADE-SEPARATION-RENDER.md) — Plan — grade-separated crossings: rendering the DEM, the underside, and the ground
- [PLAN-MONOLITHS.md](PLAN-MONOLITHS.md) — The monoliths: what the game still loads whole
- [PLAN-OPEN-WORLD.md](PLAN-OPEN-WORLD.md) — From a road band to a world
- [PLAN-PHYSICS.md](PLAN-PHYSICS.md) — Physics: Rapier in the engine, and what it is for
- [PLAN-RACES-TRAFFIC.md](PLAN-RACES-TRAFFIC.md) — Traffic areas, circuits and stages, and games that autowire
- [PLAN-RIGGING.md](PLAN-RIGGING.md) — Rigging: getting bones back into the platform
- [PLAN-SHARDED-BAKE.md](PLAN-SHARDED-BAKE.md) — Baking a large world in pieces: plan → shard → finalize
- [PLAN-SPLAT-ROUTES.md](PLAN-SPLAT-ROUTES.md) — Splat routes: putting a captured world inside the built one
- [PLAN-STREAMING-WORLD.md](PLAN-STREAMING-WORLD.md) — From a compiled site to a streamed world
- [PLAN-STREET-FURNITURE.md](PLAN-STREET-FURNITURE.md) — Street furniture: signs, kerbs, walks, trails and rail
- [PLAN-TRAFFIC-AND-RAGE.md](PLAN-TRAFFIC-AND-RAGE.md) — Traffic, and two games that need it
- [PLAN-VEHICLES-ACTORS.md](PLAN-VEHICLES-ACTORS.md) — Vehicles, actors and weapons: the asset library's two missing tabs
- [PLAN-WORLD-SCALE.md](PLAN-WORLD-SCALE.md) — From a road band to a world: the scale plan

## Handoffs

- [HANDOFF-CAR-LIBRARY.md](HANDOFF-CAR-LIBRARY.md) — Handoff: building a library of car models
- [HANDOFF-SPLAT-CAPTURE.md](HANDOFF-SPLAT-CAPTURE.md) — Handoff: turn the Arrowhead Farms capture into a splat world

## Elsewhere

- [README.md](../README.md) — Quick start
- [AGENTS.md](../AGENTS.md) — Working in this repository
- [deploy/README.md](../deploy/README.md) — Helm, cluster values, the pull-policy rule
- [deploy/docker/README.md](../deploy/docker/README.md) — The Docker stack
- [services/worldeditor/MCP.md](../services/worldeditor/MCP.md) — The MCP reference (server `piedmont-world-editor`)
- [apps/game/README.md](../apps/game/README.md) — The game app
- [bake/README.md](../bake/README.md) — The bake

## History

- [history/2026-09-21-cadre.md](history/2026-09-21-cadre.md) — Piedmont cadre — four agents, one night
- [history/2026-09-21-poc.md](history/2026-09-21-poc.md) — Piedmont POC — running checklist
- [history/2026-09-22-fleet.md](history/2026-09-22-fleet.md) — Piedmont — what the fleet did, 2026-09-21 → 22
