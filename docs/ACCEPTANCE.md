# Acceptance: the split from the arcade

The criteria from the arcade's `docs/piedmont/SPLIT.md`, each with the command or link that proves
it. A box is checked only where it was proved, and the note says where and when. The arcade keeps its
copy of the game until every box is checked.

Proof runs so far: in the arcade's dev container (aarch64, no GPU, no Docker daemon), in
`ext/piedmont`, on 2026-10-10, at the import + rename commits ([ORIGIN.md](ORIGIN.md)).

## Bootstrap and build

- [ ] **A fresh clone opened in the dev container reaches a working shell with Node, Python, GDAL,
      PDAL, Docker (DinD), kubectl and Helm, and the host bind mounts (`~/.kube`, `~/.claude`,
      opencode, the data volume) in place.**
      Prove: open the clone in VS Code → *Reopen in Container*, then
      `node -v && python3 -c 'import venv' && gdalinfo --version && docker info && kubectl version --client && helm version && ls ~/.kube ~/.claude ~/.config/opencode "$PIEDMONT_DATA"`
      (`pdal --version` where Debian packages PDAL — not on arm64; the bake does not use it).
      *Not proved:* needs a host with Docker to build the container. The configuration is
      [.devcontainer/devcontainer.json](../.devcontainer/devcontainer.json) and
      [post-create.sh](../.devcontainer/post-create.sh).
- [x] **`npm run setup` fetches the pinned arcade packages (no `ext/siomporas-arcade`), clones
      gaussworks into `ext/gaussworks`, and installs Node and Python dependencies, from nothing.**
      Prove: `rm -rf vendor .cache node_modules ext/gaussworks bake/.venv && npm run setup`.
      *Proved* (exit 0): sparse-fetched `34933bd` into `.cache/arcade/<ref>` (2.4 MB), linked
      `vendor/arcade`, cloned gaussworks, `npm install`, created the venv and installed
      `bake/requirements.txt`. A plain `npm install` before setup stops in `preinstall` with the
      instruction to run setup (checked).
- [x] **With `ext/siomporas-arcade` checked out, setup links it instead, and an edit to
      `packages/engine` shows up in piedmont's dev server without reinstalling.**
      Prove: `git clone https://github.com/hotspoons/siomporas-arcade ext/siomporas-arcade && npm run setup`
      (prints `linking vendor/arcade -> ext/siomporas-arcade`), start `npm run dev`, edit a file
      under `ext/siomporas-arcade/packages/`, reload.
      *Proved* with a temporary `git worktree` of the arcade at `34933bd`: setup linked it,
      `npx tsc -b` and `npx vitest run` passed against it, the game booted headlessly, and a line
      appended to `packages/stunt-pieces/src/geometry.ts` was served by the running Vite on the next
      request with no reinstall. The worktree was removed and setup relinked the pin.
- [x] **`npx tsc -b`, `npx vitest run` (including the services' suites, oxlint and the names check),
      the bake's unit tests and `npm run build` all pass locally and in CI.**
      Prove: `npx tsc -b && npx vitest run && (cd bake && python -m unittest discover -s tests) && npm run build`;
      CI: [.github/workflows/ci.yml](../.github/workflows/ci.yml).
      *Proved locally* (each exit 0; vitest 76 files / 991 tests: the game, 33 node:test suites,
      oxlint, names, pull policy, links; bake 249 tests). *CI:* runs on the first push.
- [x] **`scripts/check-names.mjs` reports zero references to the old name in tracked files.**
      Prove: `node scripts/check-names.mjs` → `check-names: 0 references`.
      *Proved*; also proved to FAIL (exit 1) on a planted reference in a file's text and in a path.

## Runs locally

- [x] **The game's dev server serves a baked world, which boots headlessly (`--use-gl=swiftshader`)
      with no page errors and reaches `window.piedmont.site`.**
      Prove: `just remote` (or `just dev` with a local bake), then
      `node scripts/boot-check.mjs http://localhost:5186/#crofton-triangle`.
      *Proved* against the deployed world editor's data (`crofton-triangle`): `boot-check: OK` in
      18 s, no page errors; the only 404s are the optional authored files a world may not have.
      The site editor (`/editor.html#crofton-triangle`) boots the same way. boot-check is proved to
      fail (exit 1) on a world that does not exist.
- [ ] **The editor opens that world; the world editor service starts and lists worlds; its MCP
      endpoint answers `tools/list` under the new server name.**
      Prove: `just worldeditor-svc`, then `curl localhost:8780/api/worlds`, and an MCP
      `initialize` + `tools/list` on `/api/agent/mcp` with the token from
      `/api/agent/mcp/config`.
      *Proved locally* for the service: it started on an empty volume, listed 0 worlds, imported a
      `piedmont-worlds` bundle and listed it; MCP answered `initialize` as
      `piedmont-world-editor` and `tools/list` with 112 tools; `/world.html` served, and the site
      editor booted on a world (above). *Open:* the world editor page driving a bake end to end in a
      browser, rather than over its API.
- [ ] **A small world bakes with the local runner, publishes, and plays.**
      Prove: import a ~900 m world, `POST /api/runs/bake {"slug": …}`, then
      `node scripts/boot-check.mjs http://localhost:8780/index.html#<slug>`; publish needs a bucket
      (`PIEDMONT_EDITOR_S3_*`, `PIEDMONT_S3_*`).
      *Bakes and plays: proved.* The local service baked `smoke-world` (39.02, −76.68, r 900 m) with
      the local runner — OSM from Overpass (routed to the public mirrors: the fresh volume's Geofabrik index was the
      outline-less seed, so the Maryland instance was not credited with the area; a first attempt
      minutes earlier had failed on the mirrors' 504s),
      3DEP DEM, NOAA lidar (10.3 M points), NAIP, flora, geology, water — in 27 s on a warm cache,
      and the production build served by that service booted it headlessly
      (`boot-check: OK … smoke-world`). The first attempt found a bake bug that is also in the arcade
      ([ORIGIN.md](ORIGIN.md#changed-during-the-port-not-in-the-arcade)); fixed. *Publish: not
      proved* — no bucket was used.

## Images and deploy

- [ ] **CI builds and pushes every image under its new name.** `piedmont-bake`,
      `piedmont-worldeditor`, `piedmont-assetsvc`, `piedmont-recon`, `piedmont-blender` —
      [.github/workflows](../.github/workflows). *Waits on the first push* (no Docker daemon where
      the port was made).
- [ ] **A fresh deployment in a NEW namespace on the cluster (Helm, Rich runs or approves it) brings
      up the world editor, asset service and at least one Overpass instance, all healthy.**
      Prove: `just deploy-check gh200-1` then `just deploy gh200-1` (namespace `piedmont`,
      [deploy/gh200-1/cluster.yaml](../deploy/gh200-1/cluster.yaml)), then
      `kubectl -n piedmont get pods` and `curl <editor>/api/health`. *Waits on the images and on
      Rich.* Before it: `just deploy-bump gh200-1` to pin the first `sha-` tags.
- [ ] **From that deployment: draw a small world, bake it (single Job, and sharded), publish it, play
      it in a browser; run an OSM region import; generate one asset through the asset service
      against the configured AI endpoints; start a splat training run where a GPU is available.**
      *Waits on the deployment.*
- [ ] **The Docker/DinD compose stack comes up on a host with one `docker compose up` and bakes a
      small world.** *Built and statically validated, awaiting a host run.* Ported from the arcade's
      `agent/docker` ([ORIGIN.md](ORIGIN.md)) into [deploy/docker](../deploy/docker/README.md),
      `services/worldeditor/docker.mjs` and [DOCKER.md](DOCKER.md); on 2026-10-10, with docker
      28.5.1 and compose v2.40.0 static binaries and no daemon: `docker compose config -q` passed on
      `docker-compose.yml`, `+ docker-compose.gpu.yml`, `core/stack.yml` with no profile, each of
      `overpass-na`, `overpass-eu`, `minio` and all three, and `ai/docker-compose.yml` with and
      without the `gateway` profile; `hadolint deploy/docker/core/Dockerfile`,
      `shellcheck deploy/docker/core/entrypoint.sh` and `actionlint .github/workflows/core-image.yml`
      reported nothing; the runner's suite (`docker.test.mjs`, 18 tests against a fake Engine on a
      unix socket) passes in `npx vitest run`.
      Prove: on a host with Docker, the smoke test in [DOCKER.md](DOCKER.md#bring-it-up-and-smoke-test-a-tiny-bake)
      (`docker compose up -d`, `/api/ready` says `runner: docker`, a 600 m world bakes single and
      sharded). The core image itself is first published by `core-image.yml` on the first push.

## Docs

- [ ] **README quick start works as written on a fresh machine.** Steps 2–4 of
      [README.md](../README.md) were run here (setup, the checks, the game against deployed data);
      step 1 (the container) and step 5 on a fresh machine are not yet proved.
- [x] **Every service, pipeline and deploy path has its page; the link check passes; no page names
      the old name or points into the arcade for anything piedmont now owns.**
      Pages: [ARCHITECTURE.md](ARCHITECTURE.md) links one per service and pipeline,
      [deploy/README.md](../deploy/README.md), [deploy/docker](../deploy/docker/README.md), the MCP
      reference [services/worldeditor/MCP.md](../services/worldeditor/MCP.md).
      Prove: `node scripts/check-links.mjs && node scripts/check-names.mjs`. *Proved*; the link
      check also refuses links into `vendor/` and `ext/` and was proved to fail on a planted broken
      link. Links that remain into the arcade are for what the arcade still owns (the engine
      packages, the fighter's photogrammetry, Turbo Radrun's car).

## Arcade side (closes the split)

- [ ] **The arcade tag piedmont pins exists and piedmont builds against it.** `arcade.json` pins
      the commit `34933bd`; the tag (e.g. `engine-v2026.10.10`) is the arcade's to create, then
      `npm run arcade:bump engine-v2026.10.10 && npx tsc -b && npx vitest run`.
- [ ] **The removal PR is green in the arcade and merged only after every box above is checked.**

## Run notes

- The compatibility situation while the deployed editor still runs the arcade's build: it speaks
  the same HTTP API (`/sites`, `/levels`, `/api/...`) under the old environment and MCP names, so
  `just remote` against it works unchanged; its bakes carry the old manifest field for the lidar
  point count (the info panel shows none) and its world exports import here
  ([ORIGIN.md](ORIGIN.md#what-does-not-carry-over-a-clean-break)). Only a deployment of piedmont's
  own images answers as `piedmont-world-editor`.
