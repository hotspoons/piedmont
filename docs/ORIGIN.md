# Origin

Piedmont was split out of [siomporas-arcade](https://github.com/hotspoons/siomporas-arcade), where it
grew as one of the arcade's games. The plan, the decisions and the acceptance criteria are the
arcade's `docs/piedmont/SPLIT.md`; the criteria are copied, with what proves each, into
[ACCEPTANCE.md](ACCEPTANCE.md).

On this page **`<old>`** stands for the arcade's name for this project — the word in the arcade's
`apps/<old>`, `tools/<old>` and `docs/<old>` paths (SPLIT.md spells it out). This repository does
not contain the word: `scripts/check-names.mjs` fails on it, case-insensitively, in any tracked
file or path.

## The source

| | |
|---|---|
| Repository | `https://github.com/hotspoons/siomporas-arcade.git` |
| Commit imported | **`34933bd3904a31e6e01d6ac969c473c7be2fff98`** (`main`, 2026-10-10) |
| Ported on top | `94da86e` — the world editor's `writeAtomic` takes a unique temp name per write (`services/worldeditor/store.mjs`, `store-atomic.test.mjs`) |
| | `4f45a7c` — every image pulls with policy `Always` (overpass and recon chart values, the OSM import Job, `runs.mjs`'s OSM import Job, `training.mjs`'s assert-code and gaussworks containers) |
| | `agent/docker` at `9ca9fb0` — `b75199e` (the Docker runner, `deploy/docker`, the design doc) and `9ca9fb0` (data beside the compose file, AI ports on 127.0.0.1 behind the keyed gateway, the core image's workflow, `pull_policy: always` everywhere). Its `ed371b6` is a cherry-pick of `4f45a7c` and its `d1689be` is `94da86e`, both already above. Renames in [the Docker lane's names](#the-docker-lanes-names) |
| | `agent/full-world` at `b1845aa` — a tiled network bake reads and rasterises the point cloud over its whole region; the streets stay the road band (`bake/piedmont_bake/{export,lidar,lidar_sources,network,network_tiles,shards}.py`, `bake/tests/test_full_world_lidar.py`, the "Superseded 2026-10-10" note in [PLAN-OPEN-WORLD.md](PLAN-OPEN-WORLD.md)) |
| | `9c250f2` — `fetch_site` no longer clobbers the spine with the flora summary. The same change as piedmont's own `100d2f8` (found here first, below), line for line; nothing further to port |
| History | not carried over: piedmont starts with one import commit (the files moved, contents unchanged), then the rename. `git log` in the arcade has the history of every file below. |

The engine packages are not copied: they are still the arcade's, and piedmont links them at a
pinned ref ([ARCADE.md](ARCADE.md)).

## Where each path went

| Arcade path | Piedmont path |
|---|---|
| `apps/<old>` (`@apex/<old>`) | `apps/game` (`@piedmont/game`) |
| `tools/<old>` (Python package `<old>`) | `bake/` (package `piedmont_bake`); its chart → `deploy/helm/bake` |
| `tools/worldeditor` | `services/worldeditor`; chart → `deploy/helm/worldeditor` |
| `tools/assetsvc` | `services/assetsvc`; chart → `deploy/helm/assetsvc` |
| `tools/overpass` | `services/overpass`; chart → `deploy/helm/overpass`, `values-{eu,na}.yaml` beside it |
| `tools/recon-service` | `services/recon`; chart → `deploy/helm/recon` |
| `tools/{assetlib,assetgen,blender,rigging,surfaces,sky,sounds}` | `pipelines/<same>` |
| `tools/sf2-probe/rigging/{rig_character.py,README.md}` | `pipelines/rigging/` (copied: the arcade's fighter keeps its own) |
| `tools/ci` | `scripts/checks` |
| `docs/<old>/*` | `docs/*` (`PLAN-SPLAT-…` → `PLAN-SPLAT-ROUTES.md`) |
| `docs/sessions/*` | `docs/history/*` (`2026-09-21-<old>.md` → `2026-09-21-poc.md`) |
| `docs/assets/HANDOFF-CAR-LIBRARY.md` | `docs/HANDOFF-CAR-LIBRARY.md` |
| `probes/<old>-*.mjs`, `*.py` | `probes/*` (prefix dropped; no name collided) |
| `probes/{editor,worldedit,worldeditor}-*`, `_spice-*` and the other game probes | `probes/*` (`_spice-*` → `spice-*`) |
| `scripts/{bridge,check-lockfile,ci-failures,deploy,devproxy,gen-program-types,heroicons}.mjs`, `ci-failures.test.mjs`, `build-agent-shell-vendor.sh`, `tunnel.sh`, `probe.mjs` | `scripts/` |
| `.apex-live.mjs` | `scripts/live.mjs` |
| `deploy/gh200-1/*`, `deploy/README.md` | `deploy/gh200-1/*`, `deploy/README.md` |
| `.github/workflows/<old>-image.yml` | `.github/workflows/bake-image.yml` |
| `.github/workflows/apex-core-image.yml` (branch `agent/docker`) | `.github/workflows/core-image.yml` |
| `deploy/docker/*`, `docs/<old>/DOCKER.md` (branch `agent/docker`) | `deploy/docker/*`, `docs/DOCKER.md` |
| `.github/workflows/{worldeditor,assetsvc,recon,blender}-image.yml` | same names |
| `.github/workflows/lint.yml` | `.github/workflows/ci.yml` (extended) |
| `.devcontainer/*` | `.devcontainer/*` (extended; see below) |
| root `tsconfig*.json`, `vitest.config.ts`, `.oxlintrc.json`, `.gitignore`, `justfile`, `package.json`, `package-lock.json`, `AGENTS.md`, `LICENSE`, `NOTICE`, `CREDITS.md`, `opencode.json`, `.vscode/` | the same files, rewritten for piedmont |

To port a later arcade change to one of these files: map its path through this table, apply the
diff, then the names in the next section (and run `node scripts/check-names.mjs`).

## The renames

| Arcade | Piedmont |
|---|---|
| `<old>` where it meant the band of land along the roads (the bake's polygon, `points_in_<old>`, `lidar_<old>`, `--prune-<old>`, `<old>.laz`, the `site.json` key) | `road_band` / `roadBand` / "road band" (`points_in_road_band`, `lidar_road_band`, `--prune-road-band`, `road_band.laz`) |
| `<old>` where it meant the project | "the game" in prose, `piedmont` in names |
| `<old>` as the route grouping in `intersections.py` (one named road across several OSM ways) | `route` |
| `python -m <old>`, `from <old> import` | `python -m piedmont_bake`, `from piedmont_bake import` |
| env `<OLD>_*` | `PIEDMONT_*` (`PIEDMONT_DATA`, `PIEDMONT_SITES`, `PIEDMONT_PORT`, …) |
| env `WORLDEDITOR`, `WORLDEDITOR_*` | `PIEDMONT_EDITOR`, `PIEDMONT_EDITOR_*` (the bake's working directory, `WORLDEDITOR_<OLD>`, is `PIEDMONT_EDITOR_BAKE_DIR`) |
| `window.<old>` | `window.piedmont` |
| storage keys `apex-<old>.*`, `apex-<old>-*`, `<old>.*` | `piedmont.*`, `piedmont-*` |
| MCP server `<old>-world-editor` | `piedmont-world-editor` |
| export kinds `<old>-worlds`, `<old>-presets`, `<old>-vehicle-presets`; bundle suffix `.<old>.json` | `piedmont-worlds`, `piedmont-presets`, `piedmont-vehicle-presets`; `.piedmont.json` |
| k8s Job names `<old>-bake-*`, `<old>-publish-*`; labels and annotations `<old>.run`, `<old>.capture`, … | `piedmont-bake-*`, `piedmont-publish-*`; `piedmont.run`, `piedmont.capture`, … |
| PVC `<old>-data`, Secret `<old>-r2`, R2 key prefix `<old>/` | `piedmont-data`, `piedmont-r2`, `piedmont/` |
| Helm chart `<old>` (the bake) | `piedmont-bake` (the others keep their names) |
| images `ghcr.io/hotspoons/{<old>,worldeditor,assetsvc,recon,blender}` | `ghcr.io/hotspoons/piedmont-{bake,worldeditor,assetsvc,recon,blender}` |
| internal proxy headers `x-<old>-*` | `x-piedmont-*` |
| just recipes `<old>-view`, `-remote`, `-tunnel`, `-{sites,fetch,export,report}` | `dev`, `remote`, `tunnel`, `bake-{sites,fetch,export,report}` |

### The Docker lane's names

The `agent/docker` branch introduced its own project names under the arcade's `apex` prefix. In
piedmont they follow the rest:

| Branch `agent/docker` | Piedmont |
|---|---|
| env `APEX_*` (`APEX_HOST_DIR`, `APEX_ROOT`, `APEX_CORE_IMAGE`, `APEX_PROFILES`, `APEX_SERVICES`, `APEX_IMAGE_MODEL_URL`, `APEX_AI_DIR`, …) | `PIEDMONT_*` (`PIEDMONT_HOST_DIR`, `PIEDMONT_ROOT`, …) |
| env `APEX_PORT`, `APEX_BIND` (the editor's port and address on the host) | `PIEDMONT_HOST_PORT`, `PIEDMONT_HOST_BIND` — not `PIEDMONT_PORT`, which is already the game's dev-server port and would be read from the shell by compose |
| env `WORLDEDITOR_DOCKER_*`, `WORLDEDITOR_RUNNER`, `WORLDEDITOR_IMAGE` | `PIEDMONT_EDITOR_DOCKER_*`, `PIEDMONT_EDITOR_RUNNER`, `PIEDMONT_EDITOR_IMAGE` |
| `/srv/apex`, `/run/apex`, `/opt/apex`, `/var/log/apex` | `/srv/piedmont`, `/run/piedmont`, `/opt/piedmont`, `/var/log/piedmont` |
| compose projects `apex-host`, `apex`, `apex-ai`; network `apex`; volume `apex-docker` | `piedmont-host`, `piedmont`, `piedmont-ai`; `piedmont`; `piedmont-docker` |
| image `ghcr.io/hotspoons/apex-core`, binary `/usr/local/bin/apex-core` | `ghcr.io/hotspoons/piedmont-core`, `/usr/local/bin/piedmont-core` |
| label `apex.restart-on-unhealthy` | `piedmont.restart-on-unhealthy` |
| default images `worldeditor`, `assetsvc`, `recon`, `<old>` | `piedmont-worldeditor`, `piedmont-assetsvc`, `piedmont-recon`, `piedmont-bake` |
| the publish claim and Secret defaults `<old>-data`, `<old>-r2` | `piedmont-data`, `piedmont-r2` |

The runner's own container labels, `worldeditor.docker/{managed,job,pod,stage}`, keep their names,
as the editor's Job labels `worldeditor/{run,kind}` did in the split.

**The capture envelope's file name.** gaussworks wrote each capture's envelope under its own word
for a capture's band of road, `<old>.json`, which the game read through a name assembled in one
place to keep it out of this repository. Rich chose to rename it in gaussworks (2026-10-10):
gaussworks now writes `envelope.json` (and still reads the old name itself), and the game reads
`envelope.json` only — `ENVELOPE_FILE` in `apps/game/src/visuals/splats.ts` and the synthetic world
writer `bake/splats/synth.mjs` are plain strings, and the names check has no special case.
**Captures made by the old deployment need gaussworks' `scripts/rename-envelope.py` before
piedmont reads them** ([PLAN-SPLAT-ROUTES.md](PLAN-SPLAT-ROUTES.md)).

### What does not carry over (a clean break)

Stored state under the old names is not migrated, as with the arcade's URL scheme change:

- browser storage (settings, tuning knobs, theme, camera poses) starts fresh;
- a presets file exported by the arcade's game has the old `kind` and is refused by the presets
  import; world bundles are not checked by kind, so the arcade editor's world exports import here;
- a bake made by the arcade's baker has `points_in_<old>` in its manifest (the info panel shows no
  lidar count) and `<old>.laz` / the old `site.json` key on disk (a resumed bake re-runs those
  stages); re-bake rather than reuse;
- training runs, Jobs and R2 deployments made by the arcade's editor carry the old labels and
  prefix, and the new editor does not list them.

Worlds, levels and assets move between deployments with the editor's own export and import (MCP
`world_export` / `world_import`), not by copying volumes.

## Left in the arcade, and why

| Arcade path | Why it stays |
|---|---|
| `packages/engine`, `packages/enginesim`, `packages/stunt-pieces` | shared with the arcade's other games; piedmont links them ([ARCADE.md](ARCADE.md)) |
| `apps/{arcade,coast,conduit,stuntin,fighter,drivin-redirect}` | the other games |
| `tools/photogrammetry`, `tools/sf2-probe`, `tools/t3-probe` | the fighter's 3D and ROM tooling (piedmont copied only `sf2-probe/rigging`'s character rigger, which the world editor runs) |
| `probes/enginesim-*.mjs` | measurements of the enginesim package itself |
| `scripts/` cabinet, fighter, ROM, arcade-smoke, smoke, editor-smoke (Turbo Radrun's), bake-atlas, model-*, roadside-check, flame-shot, flux-art, fetch-fonts, sync-arcade-assets, pack-frames, probe-mobile, `scripts/lib/` | other games' tooling (the game's fonts are committed; `fetch-fonts.mjs` fetched them) |
| `.github/workflows/deploy.yml`, `DEPLOY.md`, `.gitlab-ci.yml` | the arcade's own Cloudflare site and CI |
| `README.md`, `.version` | the arcade's |
| `docs/piedmont/SPLIT.md` | the plan, on the side that executes the removal |

Never in git in either repository: `tools/<old>/data` (now `$PIEDMONT_DATA`, 60+ GB of caches and
sites), `node_modules`, `dist`, heap snapshots, `shots/`, `.mcp.json`.

## Changed during the port (not in the arcade)

The port keeps behaviour. These are the places where the move itself, or the new dependency model,
needed code to change:

- **Paths that changed depth.** The bake moved from `tools/<old>/` to `bake/`, so its defaults for
  the data directory, the photos and the sites document, and `sitesdoc.py`'s repository root, gained
  or lost a `parent`; the services' relative imports of the pipelines (`../assetgen`,
  `../assetlib`) became `../../pipelines/...`; reads of the engine's files from the services, the
  bake's splat tools and probes go through `vendor/arcade/packages/...`.
- **`pipelines/assetlib`'s scripts** still resolved their library directory and imports as they had
  in `ext/assetlib/<subdir>/` before they were folded into the arcade (`LIB = HERE/..`), so in the
  arcade they pointed outside the repository. They now use their own directory.
- **The data directory** is `$PIEDMONT_DATA` (default `data/`) for the bake, the game's dev server
  (`apps/game/vite.config.ts`) and the dev container's bind mount.
- **Vite dedupes `three`, `postprocessing` and Rapier**, because the arcade packages are linked from
  outside `node_modules` and a checkout with its own `node_modules` would otherwise load two.
- **The world editor's image** fetches the arcade packages at the pinned ref in an `arcade` stage
  instead of copying `packages/` from the build context.
- **The namespace is a value**: `deploy/gh200-1/cluster.yaml` names it (`piedmont`), `deploy.mjs`
  creates it, the world editor's training routes fall back to the pod's own namespace rather than
  `default`, and the asset service is addressed as `http://assetsvc` rather than
  `assetsvc.default.svc`.
- **A bake bug found by the first local bake here**: `fetch_site` reused the name `sp` (the spine)
  for the flora summary line, so every single-road bake whose flora found canopy species died at the
  lidar step on `sp["segments"]`. Renamed to `mix`. The same code was in the arcade at 34933bd; the
  arcade then made the identical fix as `9c250f2`.
- **The Docker runner's pull-policy test** (`services/worldeditor/docker.test.mjs`, "every create
  pulls first") set a non-`Always` policy on its pinned Job in the arcade, to prove the runner pulls
  anyway. `scripts/check-pull-policy.mjs` bans those values in every tracked file, tests included,
  so the port leaves the policy unset — Kubernetes' default for a pinned tag or a digest, which
  likewise would not pull an image already present — and the test still asserts both were pulled.
- **`network_tiles.lidar_tiled`'s read area is `clip`.** In the arcade its third parameter was
  `<old>` (the streets, which the split renamed `road_band`), and `agent/full-world` made it the
  area READ — the whole region — and added a `road_band=` keyword for the streets. Both cannot be
  `road_band`, so the area read is `clip` here, the name `lidar.point_batches` already gives the
  same thing; its progress lines say "outside the area" / "pts in the area".
- **New checks**: `scripts/check-names.mjs`, `scripts/check-pull-policy.mjs`,
  `scripts/check-links.mjs` (all in the `checks` vitest project and CI), and
  `scripts/boot-check.mjs` (the headless boot).

## Branches ported after the import

Open against the arcade when the split began, and ported here rather than merged there (rows in
[The source](#the-source)): `agent/docker` (the compose stack, [deploy/docker](../deploy/docker/README.md),
[DOCKER.md](DOCKER.md)) and `agent/full-world` (the point cloud over the whole region). None are
left.
