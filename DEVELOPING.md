# Developing piedmont

This is the guide for working on piedmont itself: the game, the editor, the bake and the services.
If you want to make and ship worlds with it, start with [README.md](README.md) instead.

The engine's internals (frames, streaming, rendering, physics, traffic, the bake, the services)
are documented in [docs/dev/](docs/dev/README.md). [AGENTS.md](AGENTS.md) has the rules for agents
and people working in this repository, including long tests against a real GPU.

## The repository

| Path | What it is |
|---|---|
| [`apps/game`](apps/game/README.md) | one Vite app, three pages: the game (`index.html`), the place editor (`editor.html`) and the world editor (`world.html`) |
| [`bake/`](bake/README.md) | the world baker, Python (`python -m piedmont_bake`) |
| [`services/worldeditor`](services/worldeditor/README.md) | the world editor's backend: worlds, bakes, levels, programs, deploys, and the MCP server ([MCP.md](services/worldeditor/MCP.md)) |
| [`services/assetsvc`](services/assetsvc/README.md) | the asset service: catalog and AI generation jobs |
| [`services/overpass`](services/overpass/README.md) | the Overpass (OpenStreetMap) instances and their region imports |
| [`services/recon`](services/recon/README.md) | TRELLIS.2 behind a small API, for GPU nodes |
| `pipelines/` | asset generation, the asset library, rigging, Blender, surfaces, sky, sounds |
| [`deploy/`](deploy/README.md) | Helm charts, per-cluster values, the Docker stack |
| `probes/` | headless browser probes that measure or check one behaviour each |
| `scripts/` | setup, the repository checks, the dev bridge, deploy, the boot check |
| `docs/` | the [user guide](docs/guide/README.md), [operator references](docs/deploy/README.md) and [developer docs](docs/dev/README.md) |
| `arcade.json` | the pinned ref of the shared engine packages (below) |

## Set up

**The dev container** is the supported environment. Clone the repository and open it in VS Code
(or any editor that speaks dev containers): *Reopen in Container*. It provides:

- Node 24 (the `typescript-node:24` image, Debian trixie) and `just`;
- Python 3 with GDAL for the bake (PDAL where Debian packages it; the bake does not need it);
- its own Docker daemon (Docker CE via docker-in-docker) for building the images and running the
  compose stack, plus `kubectl`, Helm and `cloudflared`;
- headless Chromium for the probes (`just browser` reinstalls it);
- a from-source Blender build for the rigging pipeline, run in the background on first create
  (`just blender-log` shows how far it got, `just blender` runs it in the foreground);
- opencode, and the OpenChamber extension (a VS Code UI for opencode), with opencode on the
  extension host's `PATH`, alongside the Claude Code extension;
- bind mounts from the host for `~/.kube`, `~/.claude`, opencode's config, data and state
  (`~/.config/opencode`, `~/.local/share/opencode`, `~/.local/state/opencode`), and
  `~/piedmont-data`, which becomes `data/` (`$PIEDMONT_DATA`) inside the container.

The forwarded ports are 5185 (the game), 5186 (the game against remote data), 5212 (the world
editor page), 8780 (the world editor service and MCP) and 8770 (the asset service). The post-create
step runs `npm run setup` for you.

Without the container you need Node 24, git, Python 3 with `venv`, and `gdal-bin`.

**Then, on a fresh clone:**

```bash
npm run setup
```

It links the shared engine packages, clones gaussworks into `ext/gaussworks`, makes the data
directory, runs `npm install`, and creates the bake's venv (`bake/.venv`). Run it instead of
`npm install`: on a fresh clone a plain `npm install` stops and tells you to. Flags:
`--no-python`, `--no-gaussworks`, `--fetch` (ignore a local arcade checkout), `--ci` (`npm ci`).

## Run it

```bash
just remote             # :5186  the game, with data from a deployed world editor (nothing to bake)
just dev                # :5185  the game, reading $PIEDMONT_DATA/sites straight off disk
just worldeditor-svc    # :8780  the world editor service: worlds, bakes, MCP (local runner)
just worldeditor-app    # :5212  the world editor page, proxying /api to :8780
```

- `just remote` defaults to the reference deployment; pass your own:
  `just remote https://<editor>`. Open `http://localhost:5186/#<world>` with any world in that
  deployment's `/sites/index.json`.
- To bake locally, run the service and the page, then open `http://localhost:5212/world.html`, or
  use the API (see [Creating worlds](docs/guide/worlds.md#over-the-api)). Bakes run as local
  processes with the venv's Python and write `$PIEDMONT_DATA/sites/<slug>/`. Keep local worlds
  small (a radius of a kilometre or so).
- `just bake-fetch <slug>` runs the baker directly on an entry in `bake/sites.json`
  (`--skip lidar` for a quick pass); `just bake-export <slug>` rewrites the web layers without
  fetching again.
- The game's address is `/#<world>?key=value&flag`; the dev server opens in the developer view.
  The console surface is `window.piedmont`.

`just` lists every recipe. `just tunnel` exposes the dev server to a phone through a Cloudflare
quick tunnel.

## The gate

Run these before you call a change done, and gate on their exit status rather than on reading the
output:

```bash
npx tsc -b                                                # typecheck everything
npx vitest run                                            # see below
(cd bake && .venv/bin/python -m unittest discover -s tests)   # the bake's unit tests
npm run build                                             # typecheck + production bundle
```

`just check` runs the lockfile check, the typecheck, vitest and the bake tests in one go.

`npx vitest run` covers more than the game's tests:

| Project | What |
|---|---|
| `game` | `apps/game/test/*.test.ts` |
| `checks` | every service suite (`services/worldeditor/*.test.mjs`, `services/assetsvc/*.test.mjs`, `scripts/*.test.mjs`, each run with `node --test`), oxlint, and the repository checks below |

The repository checks also run alone:

| Check | Command | Fails on |
|---|---|---|
| names | `node scripts/check-names.mjs` | the project's former name anywhere in a tracked file or path, case-insensitive ([ORIGIN.md](docs/dev/project/ORIGIN.md)) |
| pull policy | `node scripts/check-pull-policy.mjs` | any image pull policy other than `Always`, anywhere |
| links | `node scripts/check-links.mjs` | a relative Markdown link that does not resolve, or one into `vendor/` or `ext/` |
| lockfile | `node scripts/check-lockfile.mjs` | a `package-lock.json` missing the native binaries of another platform (it must install on arm64 and x64 alike) |

**Before a change to the start-up path reaches a live tab**, boot the page headlessly:
`node scripts/boot-check.mjs http://localhost:5185/#<world>` must reach `window.piedmont.site` with
no page errors. Vite reloads every attached tab the moment a file is saved, and a start-up error
there kills a live session.

After changing the program API (`apps/game/src/game/session/program.ts` and the modules it
exposes), regenerate the declarations the editor type-checks against:
`node scripts/gen-program-types.mjs` (or `npm run program-types`).

## CI and images

| Workflow | What it does |
|---|---|
| `ci.yml` | on every push: typecheck, vitest, build (`node`); the names, pull-policy and link checks (`repo`); the bake's unit tests with GDAL (`bake`) |
| `bake-image.yml`, `assetsvc-image.yml`, `recon-image.yml`, `blender-image.yml`, `worldeditor-image.yml`, `core-image.yml` | build and push one image each to `ghcr.io/hotspoons/piedmont-*` when their paths change; tagged `latest` and `sha-<short>` |
| `images-all.yml` | builds every image in dependency order: bake, assetsvc and recon at once, then Blender → world editor → core, each waited for. Run it from the Actions tab, or change `.github/images-all.txt` and push |

The world editor's image copies Blender from `piedmont-blender`, and the core image's smoke test
starts the world editor's image, which is why the order matters.

## The shared engine (the arcade dependency)

`@apex/engine`, `@apex/enginesim` and `@apex/stunt-pieces` live in
[siomporas-arcade](https://github.com/hotspoons/siomporas-arcade), because the arcade's other games
use them too. They are consumed as TypeScript source, pinned by commit in `arcade.json`, and linked
into `vendor/arcade` by `npm run setup`:

- if `ext/siomporas-arcade` exists (your own checkout), `vendor/arcade` links to it, and edits there
  show up in the dev server, `tsc -b` and vitest with no reinstall;
- otherwise the pinned ref is fetched into `.cache/arcade/<ref>`.

Move the pin with:

```bash
npm run arcade:bump <sha|tag|branch>   # resolves to a full sha and writes arcade.json
npm run setup
npx tsc -b && npx vitest run
```

When and how to change the engine itself: [docs/dev/arcade.md](docs/dev/arcade.md).

## House rules

- **Name paths when you commit.** Never `git add -A`. Check `git status` for anything large or
  secret first: `.mcp.json`, kube configs, tokens and R2 or Cloudflare credentials never go in.
- **Names:** no trace of the former project name, anywhere (the names check enforces it).
- **Images pull with policy `Always`**, everywhere: charts, the Jobs the editor creates, compose
  files. A moving tag under any other policy leaves a node on a stale copy.
- **Deployments are files.** Every cluster install is `deploy/<cluster>/*.yaml` plus
  `just deploy <cluster>`; nothing is applied with `helm --set` from a shell.
- **Big data stays out of git.** `$PIEDMONT_DATA` (default `data/`) holds the caches and baked
  sites.

## Probes and the dev bridge

`probes/` holds headless checks driven with Playwright against a running dev server (for example
`PORT=5185 node probes/gamemode.mjs <world>`). Each measures or asserts one behaviour; a good probe
is also shown to fail when the behaviour breaks.

The agent box has no GPU, so frame times come from a real browser over the **dev bridge**: a dev
server started with `APEX_BRIDGE` set relays JavaScript posted to it into the live page and returns
the result.

```bash
APEX_BRIDGE=apex-dev just remote                      # or: just bridge-dev
just bridge 'apex.perfMeter.read()' 5186              # evaluate in the attached page
APEX_ORIGIN=http://localhost:5186 node scripts/bridge.mjs --file probe.js
```

Inside a probe, `apex` is the bridge context and `window.piedmont` the game's console surface. The
bridge cannot reach a production build. The test rig (`apex.rig.start(...)`), the screen wake lock
that long runs need, and how to measure are in [AGENTS.md](AGENTS.md) and
[docs/dev/performance.md](docs/dev/performance.md).

## Docs

- User-facing: [docs/guide](docs/guide/README.md). Keep it true of the code: when you change a UI
  label, a route or a setting, change the page.
- Engine and services: [docs/dev](docs/dev/README.md).
- Design notes, plans and handoffs from the project's history: [docs/dev/specs](docs/dev/specs/README.md).
  They record decisions and may be out of date.
