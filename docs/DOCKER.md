# The backend on Docker

Rich, 2026-10-10: *"design a docker version of the entire world baking, asset svc, world editor,
map API, etc — everything we use in the kube version — and make a core container with DinD that can
spawn and run the cadre of containers the kube version runs, then provide a docker compose to launch
the whole setup. It will need a shared volume mount from the host."* And then: *"For the AI services
(trellis and flux2) make those separate from the main docker setup so we can outsource those if
people don't have multiple GPUs."*

This document is for someone who knows Docker and not this repository. It describes what runs on
gh200-1 today, what each piece becomes on one Docker host, how the pieces talk, where the data
lives, and how to run, upgrade and back it up.

> **Status, 2026-10-10.** Everything here is validated statically only: `docker compose config`
> on every compose file and profile, hadolint on the Dockerfile, shellcheck on the entrypoint,
> actionlint on the core image's workflow, and node:test suites for the runner against a fake
> Docker Engine API (`services/worldeditor/docker.test.mjs`, in `npx vitest run`). The machines it
> was written and ported on have no Docker daemon, so **nothing has run end to end yet.** The first
> real run is the [smoke test](#bring-it-up-and-smoke-test-a-tiny-bake) below; it is the open
> criterion in [ACCEPTANCE.md](ACCEPTANCE.md).

```
deploy/docker/
  docker-compose.yml        the host: one privileged `core` container and its volumes
  docker-compose.gpu.yml    an override that gives the core the host's GPUs
  .env.example              every setting (copy to .env)
  core/Dockerfile           the core image: Ubuntu + Docker Engine + NVIDIA Container Toolkit
  core/entrypoint.sh        cgroups, volume layout, dockerd, registry login, compose up, watchdog
  core/stack.yml            the long-running services, run on the core's own daemon
  core/assetsvc-models.json assetsvc's model roster, with the model URLs left to the environment
  ai/docker-compose.yml     OPTIONAL and separate: flux.2 and TRELLIS.2, one GPU each
  ai/.env.example
services/worldeditor/docker.mjs        the Docker runner: the Kubernetes Job API, answered by Docker
services/worldeditor/docker.test.mjs   its tests, against a fake Engine on a unix socket
.github/workflows/core-image.yml   publishes the core image, amd64 + arm64, smoke-tested first
```

## What the cluster runs, and what each becomes

Everything below was read from `deploy/gh200-1/*.yaml`, the charts under `deploy/helm/*` and the
code that creates Jobs. Note that `cluster.yaml` lists only `worldeditor` and `assetsvc`;
the Overpass releases and `recon` were installed by hand with `helm upgrade`.

| On gh200-1 | What it is | On Docker |
|---|---|---|
| **worldeditor**: Deployment, Service, a 500 Gi RWX PVC (`worldeditor-data`), a Role over Jobs and pods | the editor, the static app, the map API, the run orchestrator | service `worldeditor` in `core/stack.yml`, with `PIEDMONT_EDITOR_RUNNER=docker` and the core's Docker socket. Its PVC is `${PIEDMONT_HOST_DIR}/data` |
| **assetsvc**: Deployment, a 100 Gi PVC, a models ConfigMap | the asset catalog and the generation queue | service `assetsvc`. Its PVC is `volumes/assetsvc-data`; its roster is `core/assetsvc-models.json` |
| **overpass** (Maryland): Deployment, a `regions` sidecar, an RWO PVC `overpass-db`, a ConfigMap `overpass-regions` | our own OSM query server | `overpass` + `overpass-regions`. They share `/dev/shm` through `ipc: shareable` / `ipc: service:overpass`, as the two containers of the pod did |
| **overpass-na**: the same, North America, 2 Ti | | profile `overpass-na` |
| **overpass-eu**: the same, Europe, 4 Ti, no regions sidecar | | profile `overpass-eu` |
| bake Jobs: `piedmont_bake fetch`, or `plan` → N × `shard` → `finalize`, and `publish`, all running `ghcr.io/hotspoons/piedmont-bake:latest` | the world bake | containers that the editor creates on the core's daemon. The Job spec is unchanged; `docker.mjs` translates it ([below](#the-docker-runner)) |
| osm-import Jobs: `wiktorn/overpass-api` pinned to the instance's node, mounting `<upstream>-db` and `<upstream>-regions` | adding a Geofabrik region to a running instance | the same, as a container. "The instance's pod" is found by the label `app=<upstream>` on the service container |
| splat training: a TrainingDeployment CRD, else a JobSet, else plain Jobs (a leader plus N workers sharing an RWX claim) | gaussian-splat training on GPUs | the plain-Jobs tier, as containers with GPUs. The claim becomes a directory |
| Blender (a supervised process inside the editor pod) | the rigging pipeline | unchanged: it is in the worldeditor image |
| **recon** (TRELLIS.2): GPU Deployment, hand-installed | image to 3D | the **separate** AI stack, `ai/docker-compose.yml`, or any URL ([below](#the-ai-services)) |
| **high-brine** (flux.2-dev): a platform InferenceDeployment (`vllm/vllm-omni:v0.28.0`) | image generation and editing | the **separate** AI stack, or any URL |
| **zt-qwen**: a platform InferenceDeployment | text model; the editor only lists it at `/api/models` | out of scope. Set `PIEDMONT_TEXT_MODEL_URL` if you have one |
| Cloudflare R2 (publish) | where a baked world is mirrored for the public viewer | stays external (`PIEDMONT_EDITOR_S3_*`), or profile `minio` for a bucket on the box |
| ingress-nginx, external-dns, cert-manager | the front door | out of scope: the editor is plain HTTP on `PIEDMONT_HOST_PORT`. Put your own TLS proxy in front |

**"The map API"** is the world editor itself: `/api/osm/*` (the roads, the tiled layer stack,
the coverage routing, `/api/osm/regions`) and `/api/places` and search. Behind it are our Overpass
instances, the Natural Earth basemap (fetched once from GitHub and cached on the volume) and
Nominatim (`nominatim.openstreetmap.org`, rate-limited and cached). The editor serves all of it,
so on Docker it is the `worldeditor` service plus the `overpass*` services. Nominatim and the
public Overpass mirrors stay external, as they are in the cluster.

**S3 is optional.** assetsvc uses a bucket only for `/sync/push|pull`, and returns 400 without
one. The bake needs one only for `publish`. Nothing needs S3 to start, so MinIO is a profile and
not a default.

## Topology and networking

```
 host ─────────────────────────────────────────────────────────────────────────────────────────
  :8780 ──► core (privileged; its own dockerd; /srv/piedmont = ${PIEDMONT_HOST_DIR}; /var/lib/docker = named volume)
             │
             │  inner network "piedmont" (a user-defined bridge, so names resolve)
             ├── worldeditor :8780 ──(published on the core)──► the browser, MCP agents
             │      │  /var/run/docker.sock (the core's daemon)
             │      └─ creates ─► piedmont-bake-…-0, piedmont-shard-…, osm-import-…, splat-…-leader-0 …
             │                     (also on "piedmont", so http://overpass/api/interpreter resolves)
             ├── assetsvc :8770 ─────────────────────────────► PIEDMONT_IMAGE_MODEL_URL, PIEDMONT_MESH_MODEL_URL
             ├── overpass :80  + overpass-regions (shared IPC, shared /db)
             ├── overpass-na / overpass-eu        (profiles)
             └── minio :9000 (+ console :9001 on 127.0.0.1)   (profile)

 another machine, or the same one ─────────────────────────────────────────────────────────────
  ai/docker-compose.yml:  gateway :8443 (bearer key) ─► flux 127.0.0.1:18090 (GPU 0), trellis 127.0.0.1:8500 (GPU 1)
```

- **Names match the cluster's Services.** The editor's defaults (`http://overpass/api/interpreter`,
  the `overpassRegions` names, `INTERPRETER=http://<upstream>/api/interpreter` in an osm-import) work
  unchanged, because every inner container sits on the network `piedmont` under its service name. Bake
  containers join the same network (`PIEDMONT_EDITOR_DOCKER_NETWORK`).
- **Only the editor is published.** The browser knows one origin, as in the cluster: assetsvc is
  reached through the editor's `/assetsvc/…` proxy. Overpass is internal. If you want it from the
  host, add a `ports:` line in `core/stack.yml` and publish it on the core too.
- **The editor reaches the daemon through its socket.** The socket is bound into the editor's
  container, and its group (gid 2375) is the editor's supplementary group. This is the one
  privilege the cluster's Role granted: create, read and delete Jobs. It is broader on Docker,
  because the socket can do anything to the inner daemon, but the inner daemon owns nothing except
  this stack.
- **The AI services are outside the core.** From inside the core, `localhost` is the core itself,
  and the AI stack's direct ports listen on the AI host's 127.0.0.1 only. So the main stack reaches
  them through the AI stack's keyed gateway, at the AI host's LAN address, whether that is this
  machine or another.

## The shared volume

One host directory, `PIEDMONT_HOST_DIR`, is mounted at `/srv/piedmont` in the core and **at that same
path** in the editor. The editor names bind sources to the daemon, and the daemon resolves them in
the core's filesystem, so the two views have to agree. `/srv/piedmont` is internal to the core; on the
host the directory is wherever `PIEDMONT_HOST_DIR` says:

- **Default: `deploy/docker/data/`**, beside the compose file. It needs no sudo, it is inside Docker
  Desktop's default file sharing on a Mac, and it is gitignored.
- **Any absolute path**, such as a large disk, by setting `PIEDMONT_HOST_DIR=/srv/piedmont` (or wherever)
  in `.env`.

The services write as their own users (the editor and bakes as uid 10001, Overpass as its image's
user), so on a Linux host some of the files under it are not yours; read them with sudo for a
backup.

```
${PIEDMONT_HOST_DIR}/
  data/                    THE bake volume (the cluster's worldeditor-data claim; Jobs here name it
                           PIEDMONT_EDITOR_CLAIM=editor-data and the runner maps that name to this path)
                           sites/, worlds/, runs/ (records + logs), cache/ (Overpass, tiles),
                           settings.json, agent/, captures/ … — owned by uid 10001
  jobs/                    the Docker runner's Job records: the queue, which survives a restart
  volumes/<claim>/         every other claim, by its Kubernetes name:
    assetsvc-data/           the asset catalog
    overpass-db/             Maryland's database (overpass-na-db/, overpass-eu-db/ with the profiles)
    splat-<capture>-out/     a splat run's shared output (made on demand, like the PVC it replaces)
    minio/                   the bucket store (profile minio)
  configmaps/<name>/       ConfigMaps a Job mounts: overpass-regions/ (import.sh, regions-agent.sh,
                           defer_deletes.py), refreshed from the core image on every start
  secrets/<name>.env       Secrets a Job's envFrom names, as KEY=VALUE lines (mode 0600, dir 0700)
                           publish-s3.env (PIEDMONT_EDITOR_S3_SECRET) is written from PUBLISH_S3_* when set
```

The inner daemon's own storage (`/var/lib/docker`: images and container layers) is the named volume
`piedmont-docker`, not under `PIEDMONT_HOST_DIR`. It can be rebuilt by pulling again, and putting overlayfs
on a bind of the host's overlay is the classic way DinD breaks.

**Sizing.** A Maryland-only install with a few small worlds needs about 100 GB. Each continent
profile needs terabytes (`overpass-na` used 2 Ti on gh200-1; Europe settled at 254 GB of database
after a 33-hour import, from a 4 Ti claim). A large sharded bake writes tens of GB of rasters per
world into `data/`.

## The Docker runner

`services/worldeditor/docker.mjs`, selected with `PIEDMONT_EDITOR_RUNNER=docker`. It is a class with the
methods of `k8s.mjs` (`createJob`, `getJob`, `deleteJob`, `podsFor`, `podsByLabel`, `logStream`,
`raw`, `permitted`), answering in the Kubernetes API's shapes. `runs.mjs`, `training.mjs` and
`models.mjs` take it in place of the Kubernetes client and do not branch on it. Run records say
`runner: "docker"`. Kubernetes remains the default whenever a service-account token is mounted.
Docker is never chosen by detecting a socket: a laptop with Docker Desktop keeps running its bakes
as subprocesses unless told otherwise.

It speaks the Docker Engine API over the unix socket with `node:http`, so it needs no docker CLI.

### How a Job spec becomes containers

| Kubernetes | Docker Engine |
|---|---|
| a Job with `completions`/`parallelism` N | N pods, named `<job>-<i>`; each pod is one container per stage |
| `initContainers` | containers `<pod>-init-<k>`, run first and in order; the main one is created only when they exit 0 |
| `image`, `command`, `args`, `workingDir` | `Image`, `Entrypoint`, `Cmd` (`$(VAR)` expanded as the kubelet does), `WorkingDir` |
| `env`, `valueFrom.fieldRef metadata.name`, `secretKeyRef` | `Env`; a secret key is read from `secrets/<name>.env` |
| `envFrom.secretRef` | every line of `secrets/<name>.env` (optional ones may be missing) |
| `resources.limits.cpu` | `NanoCpus`, **clamped to the host's CPU count**. 64 CPUs on a 16-core box is a cap, not an error |
| `resources.limits.memory` / `requests.memory` | `Memory` (a hard cap; an OOM kill is reported as one) / `MemoryReservation` |
| `resources.limits["nvidia.com/gpu"]` (any `*/gpu`) | `DeviceRequests`: the device ids the runner allocated, or `Count` when no GPUs are configured |
| volume `persistentVolumeClaim` | a bind of `volumes/<claim>`. The data claim (`PIEDMONT_EDITOR_CLAIM`) is the editor's data dir; `PIEDMONT_EDITOR_DOCKER_CLAIMS` overrides any claim |
| volume `configMap` / `secret` / `hostPath` | a read-only bind of `configmaps/<name>` / `secrets/<name>`; the path itself |
| volume `emptyDir` (`medium: Memory`) | a per-pod named volume (removed with the Job), or a tmpfs |
| `restartPolicy: Never`, `backoffLimit: 0` | `RestartPolicy: no`. A failed pod fails the Job, and its siblings are stopped |
| `metadata.labels`, template labels | `Labels`, plus `job-name` and the runner's own `worldeditor.docker/*` |
| any `imagePullPolicy`, any tag or digest | a pull before every container create ("always, always"), at most once a minute per image so simultaneous shards pull once |
| `activeDeadlineSeconds`, `ttlSecondsAfterFinished` | enforced by the runner's pump: a stop, then later a removal |
| `nodeSelector`, `affinity`, `topologySpreadConstraints` | ignored: there is one node |
| pod log with `timestamps=true` and `sinceTime` | `GET /containers/{id}/logs?timestamps=1&since=<unix>`, de-multiplexed, with each stamp padded to nine digits so the runner's string comparison is a time comparison |

### What the scheduler did, and who does it now

**Queueing.** Kubernetes holds a pod Pending until a node can take it. One host cannot take 25
dc-metro shards at once (a shard peaked near 139 GiB). So the Job is a record in
`${PIEDMONT_HOST_DIR}/jobs/`, and its pod containers are created only when there is a slot:

- At most `docker.maxParallel` bake pods run at once. This is a setting, editable in the editor
  under Settings → Docker runner or set with `PIEDMONT_EDITOR_DOCKER_MAX_PARALLEL`; the default is 1.
- Other Job kinds (publish, osm-import, splat) do not count against it.
- A queued pod is Pending, the Job is not active, and the run says "queued", which is true.
- The queue is on the volume, so an editor restart resumes it.

**GPUs.** Docker gives `--gpus 1` to every container as GPU 0. With `PIEDMONT_EDITOR_DOCKER_GPUS` set
(a count, or ids such as `0,2`):

- Each pod is handed distinct device ids, and they are free again when it ends.
- A pod waits until enough are free.
- A pod asking for more GPUs than the host has fails with that sentence, instead of staying
  Pending for ever.

`/api/v1/nodes` and `/api/v1/pods` are answered from the same accounting, so the editor's
"free GPUs" (`training.freeGpus`) works unchanged.

**Pulls.** Rich, 2026-10-10: *"Policy should be always, always."*
- Every container create pulls first, whatever the tag, digest or the spec's `imagePullPolicy`.
  The only throttle is once per image per minute, so 25 shards starting together pull once.
- A failed pull with no copy on the host fails the pod.
- The pull reply is HTTP 200 even when the pull fails: the error is a JSON line partway down the
  stream. The runner reads the whole stream; a test checks this.
- If the image is already on the host, a failed pull runs the local copy, so an offline host still
  bakes; Kubernetes would have sat in ImagePullBackOff instead. It is not quiet about it: the
  warning (`[docker] WARNING: could not pull … running the copy already on this host, which may be
  stale`) is an event on the pod. The pod's log stream opens with it, so it is the first line of
  that container's output in the run's own log.
- Credentials come from the core's `docker login` (`GHCR_USER`/`GHCR_TOKEN`), passed per registry
  as `X-Registry-Auth`.

### What does not carry over

- **The splat tiers.** Only the plain-Jobs tier exists: there is no TrainingDeployment and no
  JobSet, and `raw('GET', …)` answers 404 for them, which `training.plan` reads as "not installed".
  Multi-node NCCL training (TrainingDeployment's `nccl`) does not exist on one host. The batch tier
  needs none: its workers coordinate through the shared output directory.
- **Model discovery through CRDs.** `models.mjs` finds no InferenceDeployments and no Services, so
  it uses the environment (`MODEL_URL_*`, which the core sets from `PIEDMONT_*_MODEL_URL`).
- **Retries.** `backoffLimit` is treated as 0, which is what every Job here asks for anyway.
- **A run started under the other backend.** A run started on Kubernetes cannot be followed by an
  editor running on Docker, or the other way round. On restart it is marked failed with that
  sentence rather than "gone".

## GPUs

GPUs are optional. Without them everything except splat training runs, and a job that asks for a
GPU fails with the reason.

1. **On the host:** the NVIDIA driver and the NVIDIA Container Toolkit, with
   `sudo nvidia-ctk runtime configure --runtime=docker && sudo systemctl restart docker`.
   `docker run --rm --gpus all ubuntu nvidia-smi` must work before going further.
2. **Into the core:** `docker compose -f docker-compose.yml -f docker-compose.gpu.yml up -d`. The
   override reserves the GPUs for the core (`count: all`; replace it with `device_ids` to keep
   some for the AI stack on the same machine).
3. **Into the jobs:** the core image carries the NVIDIA Container Toolkit too, because the inner
   dockerd hands a GPU to a container through the toolkit's hook. The image is built on Ubuntu, not
   the Alpine `docker:dind`, for exactly this reason: the toolkit is glibc-only. On start the
   entrypoint runs `nvidia-ctk runtime configure` for the inner daemon and logs what `nvidia-smi`
   sees.
4. **To the runner:** `PIEDMONT_EDITOR_DOCKER_GPUS=<count or ids>` in `.env`, so pods get distinct GPUs.

Nested GPU passthrough (host → privileged DinD → container) is known to work with the toolkit
installed at both levels, but **it is the least verified part of this design**. The first GPU run
should be `docker compose exec core docker run --rm --gpus all ubuntu nvidia-smi`.

## The AI services

**They are separate on purpose.** flux.2-dev wants an 80 GB-class GPU and TRELLIS.2 wants another,
and most people running the main stack will not have two spare. So the main stack runs neither. It
only holds two URLs, and the models can be:

- the optional stack in `deploy/docker/ai`, on this machine or another;
- the cluster's own endpoints;
- someone's hosted service;
- nothing. Then asset drawing and meshing say "no url configured", and nothing else changes: the
  map, the bakes and the editor do not depend on them.

### The settings (main stack's `.env`)

| Variable | Goes to | Speaks |
|---|---|---|
| `PIEDMONT_IMAGE_MODEL_URL` | assetsvc `ASSETSVC_URL_FLUX2_DEV`; editor `MODEL_URL_IMAGE` | **OpenAI images API.** `GET /v1/models` (an entry with id `flux.2-dev`); `POST /v1/images/generations` with JSON `{model, prompt, negative_prompt, true_cfg_scale, size: "WxH", num_inference_steps, seed, response_format: "b64_json"}`; `POST /v1/images/edits` as multipart (`model`, `prompt`, `size`, `num_inference_steps`, `response_format=b64_json`, optional `seed`/`negative_prompt`/`true_cfg_scale`, and the source PNGs under the field `image`). Both answer `{data: [{b64_json}]}`. Generation runs about 12 s and an edit about 24 s on a GH200; the client allows 300 s |
| `PIEDMONT_IMAGE_MODEL_KEY` | assetsvc `FLUX_API_KEY` | sent as `Authorization: Bearer <key>` on every image call, when set |
| `PIEDMONT_MESH_MODEL_URL` | assetsvc `ASSETSVC_URL_TRELLIS2`; editor `MODEL_URL_MESH` | **recon-service API** (`services/recon`). `GET /readyz` (or `/healthz`, `/health`); `POST /reconstruct` as multipart, with repeated `images` files and `seed`, answering `202 {job, views, poll}`; `GET /jobs/<id>` until `state` is `done` or `failed` (plus `detail`, `asset`, `vertices`, `faces`, `textured`); `GET /jobs/<id>/asset` for the GLB. A reconstruction takes 90–120 s; the client allows 30 min |
| `PIEDMONT_MESH_MODEL_KEY` | assetsvc `TRELLIS_API_KEY` | the same Bearer header, on every mesh call |
| `PIEDMONT_TEXT_MODEL_URL` | editor `MODEL_URL_TEXT` | an OpenAI chat API; listed only, nothing calls it |

**For a hosted provider or a proxy:** anything that speaks these two shapes can stand in. A hosted
OpenAI-compatible image endpoint needs to accept `model: flux.2-dev`, or the assetsvc roster entry's
`model` must be changed to its id. The edit field is `image` for flux.2-dev and `image[]` for
klein, which is what the roster's `field` sets. The mesh API is this repository's own shape, so a
different reconstructor needs a thin adapter in front of it.

### The optional AI stack: `deploy/docker/ai`

```bash
cd deploy/docker/ai && cp .env.example .env    # HF_TOKEN, FLUX_GPU, TRELLIS_GPU
docker compose up -d                            # flux on 127.0.0.1:18090, trellis on 127.0.0.1:8500
docker compose --profile gateway up -d          # :8443 on all interfaces, AI_API_KEY in front of both
```

**flux.** `vllm/vllm-omni:v0.28.0`, the public release the cluster's `high-brine` runs.
- It serves `black-forest-labs/FLUX.2-dev` as `flux.2-dev`.
- The model is gated: accept its licence on Hugging Face and set `HF_TOKEN`.
- About 64 GB of weights are cached under `${PIEDMONT_AI_DIR}/flux`.
- Pinned to `FLUX_GPU` through `device_ids`.
- `FLUX_ARGS` replaces everything after `vllm serve`, for a smaller model on a smaller card.
- **Not verified here:** the exact `vllm serve … --omni` arguments the platform's
  InferenceDeployment passes are not in this repository, so the default is the documented
  vllm-omni form. Confirm with `curl :18090/v1/models` and a generation.

**trellis.** `ghcr.io/hotspoons/piedmont-recon:latest`, built by `.github/workflows/recon-image.yml` from
`services/recon`, for amd64 and arm64.
- If the package is private or unreachable, build it from the repository under a local name, so
  that the pull on every start does not replace it: `TRELLIS_IMAGE=recon:local`, then
  `docker compose build trellis && docker compose up -d`. That takes an hour or more, because it
  compiles TRELLIS.2's CUDA extensions; set `TRELLIS_CUDA_ARCH` to your card's compute capability.
- Weights (TRELLIS.2-4B) are cached under `${PIEDMONT_AI_DIR}/trellis/weights`.
- Pinned to `TRELLIS_GPU`.
- Without `HF_TOKEN` it uses ungated mirrors of two gated helper models and logs a licence warning,
  exactly as in the cluster.

**The ports.** The direct ports (18090, 8500) have **no authentication**, so by default they listen
on 127.0.0.1: for `curl` on the AI host, and nothing else. Two settings expose them:

- **The gateway (profile `gateway`), the intended way in.** nginx on `GATEWAY_PORT` (8443), on
  all interfaces.
  - `/flux/…` goes to flux and `/trellis/…` to trellis.
  - Every request needs `Authorization: Bearer $AI_API_KEY`, and the gateway refuses to start
    without a key.
  - It is plain HTTP: put TLS in front before it crosses a network you do not trust.
- **`AI_BIND=0.0.0.0`**, which opens the direct, unauthenticated ports. Use it on a trusted
  network only.

**How the main stack reaches them**, on another machine or on the same one (the core cannot reach
the AI host's 127.0.0.1 either way). On the AI host:

```bash
cd deploy/docker/ai
# in .env: AI_API_KEY=<a long random string>
docker compose --profile gateway up -d
curl -s -H "Authorization: Bearer $KEY" http://localhost:8443/flux/v1/models    # 200 with flux.2-dev
curl -s -o /dev/null -w '%{http_code}\n' http://localhost:8443/flux/v1/models    # 401 without the key
```

Then in the main stack's `deploy/docker/.env` (followed by `docker compose up -d`, which recreates
the core with the new settings):

```bash
PIEDMONT_IMAGE_MODEL_URL=http://<AI host LAN address>:8443/flux
PIEDMONT_MESH_MODEL_URL=http://<AI host LAN address>:8443/trellis
PIEDMONT_IMAGE_MODEL_KEY=<the same key>
PIEDMONT_MESH_MODEL_KEY=<the same key>
```

## What stays external or out of scope

- **The platform's CRDs:** TrainingDeployment, InferenceDeployment and JobSet. Inference becomes
  configured URLs. Training becomes the plain-Jobs tier.
- **The public internet the bake reads:** USGS/TNM lidar and DEMs, NAIP (Planetary Computer), AWS
  open data, Macrostrat, Geofabrik, the public Overpass mirrors, Nominatim and Natural Earth. These
  are the same as in the cluster. The host needs outbound HTTPS.
- **R2 / Cloudflare deploy:** external as before (`PIEDMONT_EDITOR_S3_*`, `CLOUDFLARE_API_TOKEN`), or
  MinIO for a bucket on the box.
- **TLS, DNS, auth in front of the editor:** yours. The editor's MCP endpoint has its own token,
  minted on first start.
- **qwen:** a URL if you have one.
- **The Patapsco agent platform** (`platform.mjs`, `agentws.mjs`): unchanged. Its URL and token are
  entered in the editor.

## Bring it up and smoke-test a tiny bake

On a host with Docker Engine 25+ (or Docker Desktop) and Compose 2.24+, and ~100 GB free:

```bash
git clone <repo> && cd <repo>/deploy/docker
cp .env.example .env
#   edit .env if needed: GHCR_USER / GHCR_TOKEN if the ghcr.io/hotspoons packages are private
#   (a token with read:packages); PIEDMONT_HOST_DIR to keep the data somewhere other than ./data

docker compose up -d                    # pulls ghcr.io/hotspoons/piedmont-core, which pulls and starts the stack
#   or, from this checkout: PIEDMONT_CORE_IMAGE=piedmont-core:local in .env, then docker compose up -d --build
docker compose logs -f core             # dockerd, the stack, and every service's log, prefixed
#   expect: "dockerd up", "starting the stack", then worldeditor/assetsvc/overpass lines.
#   Overpass imports Maryland on first start: 20-40 min with nothing listening; that is normal.

# what is running inside the core
docker compose exec core docker compose -p piedmont ps
curl -s localhost:8780/api/health
curl -s localhost:8780/api/ready | jq '{runner, jobs, overpass: .overpass.ok}'
#   runner must be "docker", jobs.available true

# a small world: 600 m half-width around Crofton, MD (inside the Maryland extract)
curl -s -X POST localhost:8780/api/worlds -H 'Content-Type: application/json' \
  -d '{"name":"docker-smoke","centre":{"lat":39.004,"lon":-76.683},"radius_m":600,"primary":"Crofton Parkway","all_streets":true}'
RUN=$(curl -s -X POST localhost:8780/api/runs/bake -H 'Content-Type: application/json' \
  -d '{"slug":"docker-smoke","sharded":false}' | jq -r .run.id)
echo "$RUN"

# watch it: the run, its container, its log
curl -s localhost:8780/api/runs/$RUN | jq '.run | {state, runner, job, pod, detail}'
docker compose exec core docker ps --filter label=worldeditor.docker/managed=true
curl -s "localhost:8780/api/runs/$RUN/log?offset=0" | jq -r .text | tail -30
#   done when state is "done"; the world is then at ${PIEDMONT_HOST_DIR}/data/sites/docker-smoke/
ls data/data/sites/docker-smoke/        # with the default PIEDMONT_HOST_DIR=./data

# the sharded path, on the same small world (plan -> shards -> finalize, maxParallel at a time)
curl -s -X POST localhost:8780/api/runs/bake -H 'Content-Type: application/json' \
  -d '{"slug":"docker-smoke","sharded":true}' | jq -r .run.id

# open the editor: http://<host>:8780/world.html   (the viewer: http://<host>:8780/#docker-smoke)
```

GPU check, when the GPU override is in use:

```bash
docker compose -f docker-compose.yml -f docker-compose.gpu.yml up -d
docker compose exec core nvidia-smi -L
docker compose exec core docker run --rm --gpus all ubuntu nvidia-smi -L
```

If Overpass is still importing, the bake falls through to the public mirrors. That is what
`osm.py` does, and the run's log says which upstream it used. If the Overpass routing should be
tested too, wait for `docker compose exec core docker compose -p piedmont ps overpass` to say
`healthy`.

## Upgrading

- **Every image is pulled on every start**, as every image in the cluster is: the core
  (`pull_policy: always` in `docker-compose.yml`), every service in `core/stack.yml` and
  `ai/docker-compose.yml`, and every bake or job container (the runner).
  - Restarting the core pulls the service images again: `docker compose restart core`.
  - To roll one service without a restart:
    `docker compose exec core docker compose -p piedmont up -d worldeditor`.
- **Pinning:** set `PIEDMONT_EDITOR_IMAGE=ghcr.io/hotspoons/piedmont-worldeditor:sha-<commit>`, and the same for
  the others, in `.env`. This is the reproducible choice, and it is what `deploy/gh200-1/*.yaml`
  does for the cluster.
- **The core** (Docker Engine, the stack file, the Overpass scripts) is published by
  `.github/workflows/core-image.yml` as `ghcr.io/hotspoons/piedmont-core`, for amd64 and arm64,
  tagged `latest` and `sha-<short>`. The workflow builds each architecture on its own runner and
  smoke-tests it before pushing: the inner dockerd comes up, it runs a nested container, and the
  editor answers with `runner: docker`.
  - To take a new core: `docker compose up -d`, which pulls it.
  - From a checkout: set `PIEDMONT_CORE_IMAGE=piedmont-core:local` (a name no registry has, so it is built
    rather than pulled), then `git pull && docker compose up -d --build`.
  - Either way, the inner daemon's images survive in the `piedmont-docker` volume, and the data is on
    `PIEDMONT_HOST_DIR`.
- **Overpass** updates itself from the daily diffs. Changing the extract means wiping
  `volumes/overpass-db/`, because the image re-imports only when `/db/init_done` is missing (and
  imports on top of a failed one's leftovers; wipe `db/` first).

## Backup and restore

Everything that matters is in `PIEDMONT_HOST_DIR`. In order of how much it would hurt to lose:

| Path | What | Back up |
|---|---|---|
| `data/worlds/`, `data/sites/*/{adjustments,placements,structures,dead_ends,tuning}.json`, `data/settings.json`, `data/agent/`, `data/levels/`, `data/programs/` | what people authored | **always**: small, and irreplaceable |
| `volumes/assetsvc-data/` | generated assets (GPU-minutes each) | yes |
| `data/sites/*/` (everything else) | baked worlds | yes, or re-bake (hours each, and it costs other people's bandwidth) |
| `data/captures/` | uploaded splat footage | yes |
| `volumes/overpass*-db/` | the OSM databases | optional: rebuilt from Geofabrik in 20 min (Maryland) to a day or more (a continent) |
| `data/cache/` | Overpass and tile caches | no |
| `jobs/` | the runner's queue | no (stop the core first if you want it consistent) |
| `secrets/` | publish keys | keep them in your password manager, not in a backup |

```bash
docker compose stop core                 # services stop cleanly, then the inner daemon
# PIEDMONT_HOST_DIR (./data by default); sudo because the services' files belong to their own users
sudo tar -C ./data --exclude=./data/cache --exclude='./volumes/overpass*' -czf piedmont-$(date +%F).tgz .
docker compose start core
```

To restore, untar into a fresh `PIEDMONT_HOST_DIR` and run `docker compose up -d`. The editor reconciles
its runs on start. Runs that were live at backup time are marked failed, because their containers
belong to the old daemon.

## Where this came from

The stack was built on the arcade's `agent/docker` branch and ported here rather than merged there
([ORIGIN.md](ORIGIN.md)). Everything Docker-specific is under `deploy/docker/`, plus
`services/worldeditor/docker.mjs` and its test; the core image's build reads
`deploy/helm/overpass/files/` and nothing else from the tree, so the Overpass scripts the chart's
ConfigMap carries and the ones the core lays out cannot drift.

## Traps, written down before anyone steps in them

- **An empty variable is not an unset one.** The editor reads `Number(env.X ?? default)`, and
  `Number('')` is 0, so a blank `PIEDMONT_EDITOR_SHARD_ABOVE_M=` in an env file would turn sharding off.
  The core therefore writes the editor's and assetsvc's env files with only the variables that are
  set (`/run/piedmont/*.env`). Do not replace that with a plain `environment:` list of `${VAR:-}`.
- **The pull reply says 200 when the pull failed.** See the runner section above. This is the
  silent-success family again.
- **Two saves of one run in the same tick corrupted it.** `Store.writeAtomic` used one tmp name per
  process, and a sharded bake's log followers save the record concurrently. Two writers interleaved
  inside one tmp file, and the survivor was a JSON document with the tail of another after it.
  Found by this runner's sharded test, which is fast enough to hit it, and fixed for Kubernetes too
  (`store-atomic.test.mjs`).
- **A CPU limit above the host is a create error on Docker**, where Kubernetes would have treated it
  as a cap. The runner clamps the CPU limit. Memory limits are passed through and are hard caps;
  `PIEDMONT_EDITOR_BAKE_RESOURCES` in `.env.example` is sized for a workstation, not a GH200.
- **`localhost` inside the core is the core.** AI URLs on the same machine need its LAN address.
- **Docker restarts a service that exits, not one that is unhealthy.** The core's watchdog restarts
  containers labelled `piedmont.restart-on-unhealthy=true` after `PIEDMONT_UNHEALTHY_RESTART_MIN` minutes.
  Overpass is deliberately not labelled, because its first start is an import with nothing
  listening.
