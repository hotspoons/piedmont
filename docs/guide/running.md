# Running piedmont

Piedmont is a web app plus a few services. You need them running somewhere before you can bake a
world:

| Piece | What it does | Needed for |
|---|---|---|
| **world editor** | serves the editor (`/world.html`), the game (`/`) and the API; runs bakes and deploys | everything |
| **bake runner** | runs the Python baker as containers (Docker), Jobs (Kubernetes) or local processes | baking worlds |
| **Overpass** | your own OpenStreetMap query server, so bakes do not depend on the public mirrors | optional; bakes fall back to the public mirrors |
| **asset service** | the asset catalog and the queue that drives image and mesh generation | the Assets mode |
| **AI models** (FLUX.2, TRELLIS.2) | image generation and image-to-3D | AI asset generation only; reached by URL |

There are two supported ways to run it: one Docker host, or a Kubernetes cluster with Helm.

## Option A: one Docker host

The Docker install runs the whole backend inside one container (the "core") that has its own
Docker daemon. The core starts the services and runs each bake as a container of its own. All data
lives in one host directory.

> **Status:** the Docker stack is built and statically validated (compose files, Dockerfile,
> entrypoint, and the runner's test suite), but has not yet been run end to end on a real host.
> If something fails on first start, the operator reference below has the details to debug it.

**You need** Docker Engine 25+ (or Docker Desktop) with Compose 2.24+, about 100 GB of free disk
for a small install, and outbound HTTPS (the bake downloads public data).

```bash
git clone https://github.com/hotspoons/piedmont.git
cd piedmont/deploy/docker
cp .env.example .env          # edit if needed, see below
docker compose up -d          # pulls the core image, which pulls and starts everything else
docker compose logs -f core   # follow start-up
```

Then open **http://localhost:8780/world.html**. Check that the backend is ready:

```bash
curl -s localhost:8780/api/ready
```

The `runner` field should say `docker`.

**On first start** the bundled Overpass server imports its OpenStreetMap extract (Maryland by
default), which takes 20 to 40 minutes. Bakes run in the meantime; they use the public Overpass
mirrors until it is ready.

### Settings worth knowing (`deploy/docker/.env`)

| Setting | Default | What it is |
|---|---|---|
| `PIEDMONT_HOST_DIR` | `./data` | the one directory that holds everything: worlds, bakes, the OSM database, the asset catalog. Back this up |
| `PIEDMONT_HOST_PORT` | `8780` | the port the editor listens on |
| `GHCR_USER`, `GHCR_TOKEN` | empty | credentials, if the `ghcr.io/hotspoons/*` images are private |
| `PIEDMONT_PROFILES` | empty | extra services: `overpass-na` or `overpass-eu` (a whole continent: terabytes and a day to import), `minio` (an S3 bucket on the box) |
| `PIEDMONT_SERVICES` | empty (all) | start only some services, e.g. `worldeditor assetsvc` to skip the local Overpass |
| `OVERPASS_*` | Maryland | which Geofabrik extract the bundled Overpass imports |
| `PIEDMONT_EDITOR_DOCKER_MAX_PARALLEL` | `1` | bake containers at once; a large block can use over 100 GB of memory |
| `PIEDMONT_IMAGE_MODEL_URL`, `PIEDMONT_MESH_MODEL_URL` | empty | where the AI models are ([Generating assets](assets-ai.md)) |
| `CLOUDFLARE_API_TOKEN` | empty | the token the Deploy mode uses ([Deploying to Cloudflare](cloudflare.md)) |

Every setting is listed and explained in `.env.example`. After changing `.env`, run
`docker compose up -d` again.

**GPUs** are only needed for splat training. To pass the host's GPUs into the stack:

```bash
docker compose -f docker-compose.yml -f docker-compose.gpu.yml up -d
```

The AI models have their own compose file, `deploy/docker/ai/docker-compose.yml`, so they can run
on a different machine; see [Generating assets](assets-ai.md).

The operator reference, [docs/deploy/docker.md](../deploy/docker.md), covers the volume layout,
GPUs, upgrades, backup and restore, and how the core maps Kubernetes Jobs onto containers.

## Option B: Kubernetes with Helm

The charts are in `deploy/helm/`:

| Chart | What it installs |
|---|---|
| `worldeditor` | the world editor (it serves the game too), its volume, and a namespaced role that lets it start bake Jobs |
| `assetsvc` | the asset service and its catalog volume |
| `overpass` | one Overpass instance per extract (`values-na.yaml` and `values-eu.yaml` for whole continents) |
| `recon` | TRELLIS.2 image-to-3D, on a GPU node |
| `bake` | a one-off bake Job (normally the world editor starts its own) |

A cluster's install is a directory of values files, `deploy/<cluster>/`, applied with one command
from a checkout:

```bash
just deploy-check <cluster>   # render and validate against the cluster; changes nothing
just deploy <cluster>         # install or upgrade every release listed in deploy/<cluster>/cluster.yaml
```

Things to know before the first install:

- The world editor needs a **ReadWriteMany** volume: bake Jobs write the world while the editor
  serves it.
- The charts are off by default (`enabled: false`) and their example hostnames are the reference
  deployment's. Set `enabled`, your own ingress host and your Overpass URL in your values files.
- Credentials are never in values files. Create Secrets and name them: `publish.secretName` for an
  S3/R2 bucket, `cloudflare.secretName` for the Cloudflare token.

The operator reference, [docs/deploy/kubernetes.md](../deploy/kubernetes.md), walks through a values
directory, the secrets, the ingress and the image tags.

## After it is running

| URL | What |
|---|---|
| `/world.html` | the world editor |
| `/#<world>` | play a baked world (also `/index.html#<world>`) |
| `/editor.html#<world>` | the place editor on its own page (the same tool as the world editor's Place mode) |
| `/api/agent/mcp` | the MCP endpoint for AI agents ([guide](mcp.md)) |

Most service URLs (asset service, Overpass, place search, bake image, Docker runner limits) can
also be changed in the editor under **Settings → Services**, which overrides the environment and
takes effect without a restart. Each value says where it came from.

**Moving worlds between installs:** the world picker's menu can export a world (its definition and
levels) as a `.piedmont.json` bundle and import one. A baked world can be downloaded as an archive
from **World → Bake** and imported on the other install from **World → Define** (*Import a baked
world…*), so it does not have to be baked again.

Developing piedmont rather than running it? See [DEVELOPING.md](../../DEVELOPING.md).
