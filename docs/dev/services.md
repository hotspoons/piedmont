# The services

Four services stand behind the game. Each has a detailed README beside its code; this page is how
they fit together and what to know before changing one.

| Service | Code | Language | Port | Image |
|---|---|---|---|---|
| world editor + MCP | `services/worldeditor` | Node, no framework | 8780 | `piedmont-worldeditor` |
| asset service | `services/assetsvc` | Node | 8770 | `piedmont-assetsvc` |
| Overpass | `services/overpass` (scripts), `deploy/helm/overpass` | upstream `wiktorn/overpass-api` | 80 | upstream |
| recon (TRELLIS.2) | `services/recon` | Python, FastAPI, CUDA | 8000 | `piedmont-recon` |

**The browser knows one origin: the world editor.** It serves the built app, `/sites/**` (the
bakes), `/levels`, `/api/**`, the MCP endpoint, and proxies `/assetsvc/**` to the asset service, so
neither the browser nor an agent ever reaches the asset service or a GPU directly.

## The world editor (`services/worldeditor`)

[README](../../services/worldeditor/README.md) · [MCP reference](../../services/worldeditor/MCP.md)

| Module | Owns |
|---|---|
| `server.mjs` | the routes, the static app, the asset-service proxy, wiring |
| `store.mjs` | the volume: the `/sites/**` contract, world definitions, runs, levels, the merged catalog; atomic writes with a unique temp name per write |
| `worlds.mjs`, `geo.mjs` | a drawn boundary → a `sites.json` entry and what it will cost. Degrees only: the service never needs a site frame to interpret its own records |
| `runs.mjs` | bakes, publishes, OSM imports and splat runs, as Jobs or subprocesses, each with a record and a log on the volume (`runs/<id>.json`, `.log`), polled by byte offset |
| `k8s.mjs`, `docker.mjs` | the job backends: the few Kubernetes calls it makes, by hand; and the Docker runner, which answers the same calls with a Docker Engine (`PIEDMONT_EDITOR_RUNNER=docker`) |
| `overpass.mjs`, `coverage.mjs`, `geofabrik.mjs`, `layers.mjs`, `tiles.mjs`, `basemap.mjs`, `geocode.mjs` | the map: Overpass with upstream rotation and routing by extract outline, the zoom-banded layer stack on the geographic quadtree, Natural Earth borders, Nominatim search |
| `levels.mjs`, `vocab.mjs`, `programs.mjs`, `programrefs.mjs` | level validation and its vocabulary; programs on the volume, compiled on request; what a program can name in a world |
| `settings.mjs` | every setting, from the environment and overridable in Settings → Services, each saying where its value came from |
| `mcp.mjs`, `mcptools.mjs`, `mcpbridge.mjs`, `mcpauth.mjs` | the MCP server: server-side tools that go back through the service's own HTTP API (so an agent's writes are validated like a person's), and a websocket bridge to an attached page for the tools that only exist there |
| `deploy.mjs`, `cloudflare.mjs`, `deploy/worker.mjs` | the Cloudflare deploy (below) |
| `gitrepo.mjs` | the volume as a git repository with LFS; credentials server-side only |
| `blender.mjs`, `training.mjs`, `captures.mjs`, `platform.mjs`, `agentws.mjs` | the supervised headless Blender, splat training and captures, the external agent platform |

Design rules worth keeping:

- **A run is a file**, so a restart mid-bake loses nothing: `reconcile()` re-attaches to Jobs by
  name. A local subprocess cannot outlive its parent, so those are marked failed with that reason.
  Do not tail logs with `requestAnimationFrame` or EventSource: rAF does not fire in a background
  tab, and EventSource needs proxy buffering off and dies on a rollout.
- **A finished run stays finished**: only a terminal write may follow a terminal one, keyed by run
  id, not by the record object (two copies of one record were the bug).
- **`/api/ready` reports and does not gate**; probes use `/api/health`. The service can serve bakes
  and save documents while Overpass is down.
- **The save path is a whitelist** of authored documents (`SITE_DOCS` in `mcp.mjs`): a PUT over
  `manifest.json` would destroy a bake.
- **An empty answer is not cached unless corroborated**: a regional upstream, an overloaded one or a
  deadline mid-rotation can all return "nothing here" with a 200.

Tests: `services/worldeditor/*.test.mjs` (node:test), run by `npx vitest run`.
`node services/worldeditor/probe.mjs [--prove]` checks the geometry, guards and rotation offline,
and with `--api`/`--ui` the live service and page; `--prove` feeds every check an input that must
break it.

## The asset service (`services/assetsvc`)

[README](../../services/assetsvc/README.md)

A spec or description in, a game-ready `.glb` or material out. Two interfaces in `adapters.mjs`
(`ImageModel`: prompt → PNG; `MeshModel`: views → GLB); nothing else names a vendor, so swapping a
model is a roster entry and a URL. Everything slow is a job, one at a time per lane (image, mesh),
held in memory because every result lands in the catalog on the volume before the job is marked
done. The catalog is a directory per item (`item.json` with provenance for every step, `views/`,
`mesh.glb`, `mesh.finished.glb`), and the state is derived from which files exist. Finishing shells
out to `pipelines/assetgen/finish.mjs` (meshoptimizer simplification, then Draco), so that
knowledge exists once.

## Overpass

[services/overpass/README.md](../../services/overpass/README.md) ·
[specs/OVERPASS-PLANET.md](specs/OVERPASS-PLANET.md)

Our own instances (one per Geofabrik extract; the reference deployment has Maryland, North America
and Europe), imported on first start and kept current from daily diffs. **Routing is by the
extract's real outline**: the editor keeps each instance's coverage in
`<data>/overpass/coverage.json`, seeded from `PIEDMONT_EDITOR_OVERPASS_REGIONS` and Geofabrik's
index (a seed copy ships with the service, outlines are checked region by region), and sends a
world's bake to the smallest instance that holds all of it; the bake is handed the same coverage
and refuses a query its instance does not hold. **Adding a region** to a running instance is an
`osm-import` run: a Job on the instance's node stages the extract as an osmChange and the
instance's `regions` sidecar applies it through the running dispatcher. **Building a DRAWN AREA**
is an `osm-build` run: the same Job and script, but the area is a polygon drawn in the editor
(`osmbuild.mjs` picks the smallest Geofabrik extract(s) covering it and `import.sh` clips them to
it with `osmium extract -p`). Because a drawn area follows no diff stream — the extract it is cut
from also covers ground outside the shape — it is applied once, as a snapshot. See
[specs/PLAN-OVERPASS-DRAWN.md](specs/PLAN-OVERPASS-DRAWN.md).

Two traps that shaped this: a regional instance answers an out-of-area box with HTTP 200 and zero
ways, and the importer writes `init_done` last, so a crash re-imports over a finished database.

## Recon (`services/recon`)

[README](../../services/recon/README.md)

TRELLIS.2 behind a small FastAPI: `POST /reconstruct` (multipart `images`, optional `seed`) starts a
job, `GET /jobs/<id>` polls it, `GET /jobs/<id>/asset` returns the GLB, `GET /readyz` is true only
once the weights are on the card. One GPU, one job at a time. Built for Grace-Hopper (aarch64,
CUDA 13) and amd64 by `recon-image.yml`. Send keyed cut-outs when you have them: an alpha channel
beats the model's own background removal.

## The Cloudflare deploy

`services/worldeditor/deploy.mjs` plans and runs it; `cloudflare.mjs` is the API client;
`deploy/worker.mjs` is the Worker. User guide: [docs/guide/cloudflare.md](../guide/cloudflare.md).

- **What is used is measured, not listed.** Every string in the bundled documents that is a catalog
  or build id is followed (a level's hero build to its model, a traffic set to its builds to their
  models, a fixture choice to its model) until nothing new appears. There is no table of "fields
  that hold asset ids".
- **Keys are the paths the game fetches** (`sites/…`, `levels/…`, `api/levels`, `api/programs/…`,
  `assetsvc/…`, `assets/catalog.json`) under a prefix, so the game deploys unchanged. Each deploy
  writes its own `deploy.json`, and the bucket keeps a ledger, `piedmont/deployments.json`, which
  pruning reads; nothing depends on listing the bucket.
- **The Worker** has three bindings: `ASSETS` (the built app), `DATA` (the bucket) and `PREFIX`.
  Data paths are bucket lookups cached at the edge (tiles immutable, documents for a minute);
  everything else is the app with SPA fallback; writes get a 405; unknown `/api/*` is a 404.
- **Large objects** (over 32 MiB, which the REST API's front refuses with an HTML 413) go to R2's S3
  endpoint as a multipart upload in 32 MiB parts read from the volume, with S3 credentials derived
  from the same token (access key = the token's id, secret = SHA-256 of the token). The signer is
  checked against AWS's published examples.
- `cloudflare.test.mjs` proves the client's side of every call against a stand-in;
  `deploy.test.mjs` proves the closure, keys, ledger and prune against a temp volume.

The design record is [specs/DEPLOY.md](specs/DEPLOY.md).

## Deploying the services

Charts in `deploy/helm/`, a cluster's values in `deploy/<cluster>/`, applied by
`just deploy <cluster>`; the Docker stack in `deploy/docker/`. Operator references:
[docs/deploy/kubernetes.md](../deploy/kubernetes.md) and [docs/deploy/docker.md](../deploy/docker.md).
Every image pulls with policy `Always`, enforced by `scripts/check-pull-policy.mjs`.

Planned next for the world editor: accounts, roles and per-user worlds
([specs/PLAN-AUTH.md](specs/PLAN-AUTH.md)).
