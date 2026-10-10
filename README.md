# piedmont

An open-world driving game on real roads. A world is baked from the public record — OpenStreetMap,
the USGS 1 m DEM and lidar point clouds, NAIP imagery, LANDFIRE vegetation, geology — drawn in the
browser with three.js, dressed and scripted in its editors, and served by a world editor that bakes,
publishes and deploys worlds on a cluster.

| | |
|---|---|
| [`apps/game`](apps/game/README.md) | the game, the site editor (`/editor.html`) and the world editor page (`/world.html`) |
| [`bake/`](bake/README.md) | the world baker, Python (`python -m piedmont_bake`) |
| [`services/`](docs/ARCHITECTURE.md#services) | the world editor + MCP, the asset service, Overpass, the recon service |
| [`pipelines/`](docs/ARCHITECTURE.md#pipelines) | AI image and mesh generation, the asset library, rigging, surfaces, sky, sounds |
| [`deploy/`](deploy/README.md) | Helm charts, cluster values, the Docker stack |
| [`docs/`](docs/README.md) | design, plans, references |

The shared engine (`@apex/engine`, `@apex/enginesim`, `@apex/stunt-pieces`) comes from
[siomporas-arcade](https://github.com/hotspoons/siomporas-arcade) at a pinned ref — see
[docs/ARCADE.md](docs/ARCADE.md).

## Quick start

**1. Open the dev container.** Clone this repository and open it in VS Code (or any editor that
speaks dev containers): *Reopen in Container*. The container has Node 22, Python 3 with GDAL,
Docker (its own daemon), kubectl and Helm, and binds your `~/.kube`, `~/.claude`, opencode's state
and `~/piedmont-data` (the data directory, `$PIEDMONT_DATA`). Its post-create step runs step 2 for
you. Without the container you need Node 22, git, Python 3 with `venv`, and `gdal-bin`.

**2. Set up.**

```bash
npm run setup
```

This links the arcade packages (fetching the pinned ref, or using `ext/siomporas-arcade` if you have
it checked out), clones gaussworks into `ext/gaussworks`, runs `npm install`, and makes the bake's
venv (`bake/.venv`) with its requirements. Run it instead of `npm install`: on a fresh clone plain
`npm install` stops and tells you to.

**3. Check it.**

```bash
npx tsc -b && npx vitest run && (cd bake && .venv/bin/python -m unittest discover -s tests)
```

**4. Run the game against a deployed world** (nothing to bake yet):

```bash
just remote          # :5186, data from the deployed world editor
```

and open <http://localhost:5186/#crofton-triangle>. Any world in that deployment's `/sites/index.json`
works.

**5. Bake a small world and play it.** Start the world editor's service and page:

```bash
just worldeditor-svc   # :8780 — worlds, bakes, MCP
just worldeditor-app   # :5212 — open http://localhost:5212/world.html
```

Draw a world (a centre and a radius of a kilometre or so is small enough to bake on a laptop), or
import one:

```bash
curl -X POST -H 'content-type: application/json' localhost:8780/api/worlds/import \
  -d '{"kind":"piedmont-worlds","worlds":[{"slug":"my-world","lat":39.02,"lon":-76.68,"radius_m":900}]}'
curl -X POST -H 'content-type: application/json' localhost:8780/api/runs/bake -d '{"slug":"my-world"}'
```

The bake runs locally with the venv's Python and writes `$PIEDMONT_DATA/sites/my-world/`; its log is
`/api/runs/<id>/log` and the editor's Runs panel. When it finishes, play it:

```bash
just dev               # :5185
```

<http://localhost:5185/#my-world>.

## Working here

- [AGENTS.md](AGENTS.md) — the rules for agents and people: setup first, name paths when you commit,
  the checks, long tests against a real GPU over the dev bridge.
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — what lives where and how the pieces talk.
- [docs/ORIGIN.md](docs/ORIGIN.md) — where this came from, and how to port a later change from it.
- [docs/ACCEPTANCE.md](docs/ACCEPTANCE.md) — the criteria for the split, and what proves each one.

## Licence

Apache-2.0 — see [LICENSE](LICENSE), [NOTICE](NOTICE) and [CREDITS.md](CREDITS.md).
