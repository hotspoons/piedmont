# Architecture

What lives where in piedmont, and how the pieces talk. Each part has its own page in
[docs/dev](README.md): the [coordinate frames](frames.md), [terrain streaming](terrain.md),
[rendering](rendering.md), [the bake](bake.md), [the services](services.md) and the rest.

```
                       public data (OSM via Overpass, USGS 3DEP DEM + lidar, NAIP, LANDFIRE, Macrostrat)
                                                  │
  world.html ──/api──▶ services/worldeditor ──Job/process──▶ bake/ (piedmont_bake) ──▶ $PIEDMONT_DATA/sites/<slug>/
  (draw, bake,          │  serves apps/game/dist,                                         │
   publish)             │  /sites, /levels, /api, MCP                                     │
                        ├──/assetsvc──▶ services/assetsvc ──▶ flux (images), services/recon (TRELLIS meshes)
                        ├──splat runs──▶ gaussworks (by image) ──▶ $PIEDMONT_DATA/splats/<world>/
                        └──publish/deploy──▶ S3/R2, Cloudflare Workers
                                                  │
  index.html (the game) / editor.html (site editor) ◀──/sites, /levels, /splats──┘
```

In development the two halves are two processes: Vite serves `apps/game` and proxies `/api` to the
world editor service (`just worldeditor-svc` + `just worldeditor-app`), or serves `$PIEDMONT_DATA`
straight off disk (`just dev`), or proxies a deployed editor (`just remote`). In a cluster they are
one image: the world editor serves the built pages and the API from one origin, so the browser
never knows two.

## The game — `apps/game`

One Vite app, three pages ([README](../../apps/game/README.md)):

| Page | What it is |
|---|---|
| `index.html` | the game: the world, the car, traffic, races, levels and their programs; the developer chrome and the F6 tuning panel |
| `editor.html` | the site editor: areas, placements, structures, autogen, stunts, races, zones, programs (Monaco) |
| `world.html` | the world editor: draw a world on a map, bake it, publish it, deploy it, the asset library, splat runs, the in-browser agent and shell |

The address is the hash, `/#<world>?k=v&flag` ([traffic and game](traffic-and-game.md)). The console surface is
`window.piedmont`; the dev bridge context is `apex` (from `@apex/engine`). Its tests are
`apps/game/test/*.test.ts` (vitest project `game`).

## The bake — `bake/`

`python -m piedmont_bake` ([README](../../bake/README.md)): `fetch` a site or network, `export` its web
layers, `plan`/`shard`/`finalize` a sharded bake of a large world ([the bake](bake.md#sharded-bakes)),
`publish` to S3/R2. It reads `sites.json` (`$PIEDMONT_SITES`) and writes `$PIEDMONT_DATA`. Unit tests:
`cd bake && python -m unittest discover -s tests`. Image: `ghcr.io/hotspoons/piedmont-bake`; chart
`deploy/helm/bake` for a one-off Job (the world editor normally launches bake Jobs itself).

## Services

| Service | Port | Page | Image |
|---|---|---|---|
| world editor + MCP | 8780 | [services/worldeditor](../../services/worldeditor/README.md), MCP: [MCP.md](../../services/worldeditor/MCP.md) | `piedmont-worldeditor` |
| asset service | 8770 | [services/assetsvc](../../services/assetsvc/README.md) | `piedmont-assetsvc` |
| Overpass (our own OSM API) | 80 | [services/overpass](../../services/overpass/README.md), [services](services.md#overpass) | upstream `wiktorn/overpass-api` |
| recon (TRELLIS.2, GPU) | 8000 | [services/recon](../../services/recon/README.md) | `piedmont-recon` |
| the Docker install's core (DinD; runs the rows above on one host) | 8780 | [deploy/docker](../../deploy/docker/README.md), [docs/deploy/docker.md](../deploy/docker.md) | `piedmont-core` |

- **The world editor** (`services/worldeditor`, Node, no framework) owns the worlds, levels, runs and
  the data volume. It runs bakes as Kubernetes Jobs (or local processes), OSM region imports into an
  Overpass instance, splat training runs (gaussworks, by image), publishes to a bucket and deploys a
  world to Cloudflare ([services](services.md#the-cloudflare-deploy), [user guide](../guide/cloudflare.md)), keeps the volume in a
  git repository, supervises a headless Blender for rigging, and serves an MCP endpoint
  (`/api/agent/mcp`, server name `piedmont-world-editor`) through which an agent can do everything
  the page can. Its suites are `services/worldeditor/*.test.mjs` (node:test, run by the `checks`
  vitest project). Configuration is environment (`PIEDMONT_EDITOR_*`) overridden by the Settings
  panel.
- **The asset service** (`services/assetsvc`) turns a spec or a description into a finished `.glb`
  or material: an image from flux, a mesh from recon (TRELLIS.2), finishing with the glTF toolchain.
  The GPUs are reached by URL, so the AI endpoints can live anywhere.
- **Overpass**: Helm chart around the upstream image, one instance per extract, with a sidecar that
  imports further regions on request.
- **recon**: TRELLIS.2 behind a FastAPI, built for Grace-Hopper (aarch64, CUDA 13).

## Pipelines

| Pipeline | Page | What it makes |
|---|---|---|
| `pipelines/assetgen` | [README](../../pipelines/assetgen/README.md) | specs → flux prompts → images; `finish.mjs` (simplify, Draco) used by the asset service |
| `pipelines/assetlib` | [README](../../pipelines/assetlib/README.md) | the asset library's rosters (`specs/`) and the draw → key → reconstruct → finish build |
| `pipelines/rigging` | [README](../../pipelines/rigging/README.md) | Blender riggers for vehicles and characters, and the bridge the world editor drives |
| `pipelines/blender` | [README](../../pipelines/blender/README.md) | the headless Blender image the world editor copies from |
| `pipelines/surfaces` | [README](../../pipelines/surfaces/README.md) | tileable ground and road textures (`gen.py`) |
| `pipelines/sky` | [README](../../pipelines/sky/README.md) | the star catalogue and Milky Way assets the sky draws |
| `pipelines/sounds` | [README](../../pipelines/sounds/README.md) | the CC0 sound bank cut into `apps/game/public/sounds` ([traffic and game](traffic-and-game.md#audio)) |

## Shared code from the arcade

`@apex/engine`, `@apex/enginesim`, `@apex/stunt-pieces` — linked in by `npm run setup` from the ref
in `arcade.json` or from `ext/siomporas-arcade` ([arcade.md](arcade.md)).

## Deploy

Helm charts in `deploy/helm/`, per-cluster values in `deploy/<cluster>/` with the namespace as a
value, applied by `just deploy <cluster>` ([deploy/README.md](../../deploy/README.md)). Every image
pulls with policy `Always`, enforced by `scripts/check-pull-policy.mjs`. The Docker/DinD compose
stack is [deploy/docker](../../deploy/docker/README.md) (design: [docs/deploy/docker.md](../deploy/docker.md)): one privileged
`piedmont-core` container runs its own Docker daemon, the services on it, and the world editor's
Jobs as containers through `services/worldeditor/docker.mjs` (`PIEDMONT_EDITOR_RUNNER=docker`).

## Checks

| Check | Command | Where it runs |
|---|---|---|
| typecheck | `npx tsc -b` | CI `node` job |
| game tests, service suites, oxlint, names, pull policy, links | `npx vitest run` | CI `node` job; `scripts/checks/` |
| bake unit tests | `cd bake && python -m unittest discover -s tests` | CI `bake` job, and inside the bake image before it is pushed |
| build | `npm run build` | CI `node` job |
| names / pull policy / links alone | `node scripts/check-{names,pull-policy,links}.mjs` | CI `repo` job |
| headless boot | `node scripts/boot-check.mjs <url>` | by hand, before a start-up change reaches a live tab |
