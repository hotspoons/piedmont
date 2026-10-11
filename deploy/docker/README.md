# deploy/docker — the whole backend on one Docker host

The world editor, the asset service, an Overpass instance and the bake runner on one host with one
`docker compose up`, plus a separate, optional stack for the AI inference (flux.2, TRELLIS.2)
reached by URL so it can run elsewhere or be outsourced. The design, the volume layout, GPUs,
upgrades, backups and the traps are in [docs/deploy/docker.md](../../docs/deploy/docker.md).

> **Status:** built and statically validated (`docker compose config` on every file and profile,
> hadolint, shellcheck, actionlint, the runner's node:test suite), **not yet run on a host** —
> see [ACCEPTANCE.md](../../docs/dev/project/ACCEPTANCE.md). The first run is the smoke test in DOCKER.md.

| File | What |
|---|---|
| [`docker-compose.yml`](docker-compose.yml) | the host: one privileged `core` container (`ghcr.io/hotspoons/piedmont-core`) and its volumes |
| [`docker-compose.gpu.yml`](docker-compose.gpu.yml) | an override that hands the host's GPUs to the core |
| [`.env.example`](.env.example) | every setting; copy to `.env` (gitignored) |
| [`core/Dockerfile`](core/Dockerfile) | the core image: Ubuntu, Docker Engine, the NVIDIA Container Toolkit |
| [`core/entrypoint.sh`](core/entrypoint.sh) | cgroups, the volume layout, dockerd, registry login, compose up, the watchdog |
| [`core/stack.yml`](core/stack.yml) | the long-running services, on the core's own daemon (project and network `piedmont`) |
| [`core/assetsvc-models.json`](core/assetsvc-models.json) | the asset service's model roster; the URLs come from `.env` |
| [`ai/docker-compose.yml`](ai/docker-compose.yml) | OPTIONAL, separate: flux.2 and TRELLIS.2, one GPU each, behind a keyed gateway |

The world editor runs its Jobs (bakes, shards, OSM imports, splat runs) as containers on the core's
daemon through [`services/worldeditor/docker.mjs`](../../services/worldeditor/docker.mjs)
(`PIEDMONT_EDITOR_RUNNER=docker`). The core image is published by
[`.github/workflows/core-image.yml`](../../.github/workflows/core-image.yml).

## Quick start

```bash
cd deploy/docker
cp .env.example .env            # GHCR_USER/GHCR_TOKEN if the packages are private; PIEDMONT_HOST_DIR to move the data
docker compose up -d            # pulls piedmont-core, which pulls and starts everything else
docker compose logs -f core     # dockerd, the stack, every service's log
open http://localhost:8780/world.html
```

From a checkout instead of the published core: `PIEDMONT_CORE_IMAGE=piedmont-core:local` in `.env`,
then `docker compose up -d --build`. With GPUs:
`docker compose -f docker-compose.yml -f docker-compose.gpu.yml up -d`.

Everything that must survive a restart is under one host directory, `PIEDMONT_HOST_DIR` (default
`./data` beside this file). The same rules as the charts apply: every image pulls with policy
`always` (`pull_policy: always`; `scripts/check-pull-policy.mjs` fails on anything else).
