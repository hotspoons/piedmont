# worldeditor: the pod where a person turns OSM into a game world.
#
# TWO STAGES, AND THE FIRST ONE IS THE POINT. This service serves the built `apps/game` — all
# three pages, the viewer, the site editor and the world editor — from its own origin, because the
# editor's save path is a PUT to `/sites/<slug>/<file>.json` on the SAME origin and there is no
# Vite in a pod to answer it. Shipping the service without the app would mean a second host, CORS,
# and a page that knows two origins; the whole design is that the browser knows one.
#
# No CUDA and no weights. The bake runs in its own image (`ghcr.io/hotspoons/piedmont-bake`) as a Job
# this service creates; this one reads OSM, writes JSON and watches logs — and, since 2026-09-29,
# carries a headless Blender for the rigging pipeline, which is where the only Python in it lives.

# DECLARED BEFORE THE FIRST FROM, because it is used in one. An ARG between stages belongs to the
# stage above it, and `FROM ${BLENDER_IMAGE}` would then read it as empty and fail to resolve.
# Overridable so a local build can point at a Blender it built itself.
ARG BLENDER_IMAGE=ghcr.io/hotspoons/piedmont-blender:5.1.2

# ---- the arcade packages, at the pinned ref ----------------------------------------------------
# @apex/engine, @apex/enginesim and @apex/stunt-pieces live in siomporas-arcade and are npm
# workspaces here (docs/dev/arcade.md). On a laptop `vendor/arcade` is a symlink; an image wants real
# files, and it wants the ref arcade.json PINS — never whatever ext/siomporas-arcade happens to hold
# on the machine that ran `docker build`. So this stage fetches the pin itself (sparse: the three
# packages and the tsconfig they extend) and copies them out as plain directories.
FROM node:24-slim AS arcade
RUN apt-get update \
    && apt-get install -y --no-install-recommends git ca-certificates \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /src
COPY arcade.json package.json ./
COPY scripts/setup.mjs scripts/
RUN node scripts/setup.mjs --copy /arcade

# ---- build the three pages ---------------------------------------------------------------------
FROM node:24-slim AS app
WORKDIR /src
# The lockfile, every workspace manifest and the arcade packages first, so a change to a source
# file does not re-resolve the dependency tree. `npm ci` needs the WHOLE workspace layout, and it
# needs the packages' SOURCE, not just their manifests: it creates `node_modules/@apex/enginesim ->
# ../../vendor/arcade/packages/enginesim` from the LOCKFILE whether or not that directory exists,
# succeeds, and leaves `vite build` to fail on a dangling link (the arcade image went red exactly
# that way on 2026-09-27). The preinstall hook (`setup.mjs --check`) refuses an incomplete vendor/.
COPY package.json package-lock.json arcade.json ./
COPY scripts/setup.mjs scripts/
COPY apps/game/package.json apps/game/
COPY --from=arcade /arcade/ vendor/arcade/
RUN npm ci --no-audit --no-fund
COPY tsconfig.base.json tsconfig.json ./
# enginesim's `wasm/` is a COMMITTED artefact in the arcade, not build output: `src/catalog.ts`
# imports `../wasm/engines.json` at build time.
COPY apps/game/ apps/game/
# The building dressing kit, which `src/buildings.ts` imports AT BUILD TIME to know where a window
# goes. It lives with the asset library because that is what generates the parts, and the app reads
# the same file rather than a copy — a second copy of a spec is a spec that drifts. The image has to
# be told: a laptop build has the whole tree and never notices.
COPY pipelines/assetlib/specs/ pipelines/assetlib/specs/
RUN npm run build -w apps/game

# ---- Blender, from its own image ---------------------------------------------------------------
# Rich, 2026-09-29: "should include blender too in the pod for rigging pipeline work!! And make sure
# blender build step is not bundled with other steps in dockerfile so it caches."
#
# ITS OWN IMAGE, built by .github/workflows/blender-image.yml, and this is only the copy. The build
# is not here because it CANNOT be: gh200-1 is arm64, blender.org ships no arm64 5.x, and this
# image's workflow builds arm64 under QEMU, where compiling Blender runs past GitHub's six-hour job
# limit. Pinned by VERSION, so this line changes only when somebody means to change Blender.
FROM ${BLENDER_IMAGE} AS blender

# ---- the rigging toolkit: Rich's blender-agent fork, pinned by commit ---------------------------
# `ext/` is gitignored, so the checkout this image is built from does not have it. Cloned here at
# a SHA rather than a branch, so a push to the fork cannot change what an already-built tag
# contains — bump BLENDER_AGENT_SHA to take a new one. dd402c0 is the commit that makes the
# bridge honour BLENDER_MCP_PORT, which the supervisor in blender.mjs depends on.
FROM debian:trixie-slim AS blender-agent
ARG BLENDER_AGENT_SHA=dd402c0
RUN apt-get update \
    && apt-get install -y --no-install-recommends git ca-certificates \
    && rm -rf /var/lib/apt/lists/*
RUN git clone --filter=blob:none https://projects.blender.org/Rich-Siomporas/blender-agent.git /blender-agent \
    && git -C /blender-agent checkout --quiet "${BLENDER_AGENT_SHA}" \
    && rm -rf /blender-agent/.git

# ---- the service -------------------------------------------------------------------------------
# TRIXIE, not bookworm, and Blender is the reason: the arm64 build links against trixie's glibc
# (5.x needs GCC 14, which bookworm does not have), and a binary built there will not start on
# bookworm's older one. `node:24-slim` is bookworm.
FROM node:24-trixie-slim
WORKDIR /app
# ONE dependency, and it is named here because this stage has no `npm install` and never will:
# everything else is node builtins plus the files beside it — SigV4 by hand, the Kubernetes API by
# hand, no SDK.
#
# `ws` arrived with the agent tunnel relay (agentws.mjs). A browser's WebSocket cannot send the
# header the platform's tunnel wants, so the service holds the token and relays the bytes — and
# there is no WebSocket in node's standard library to do it with. Copied from the build stage
# rather than installed, so this stage still needs no network and no registry; it is pure
# JavaScript with no native build.
#
# The image went red once because this line was missing: the service threw on the import at
# startup, `/api/health` answered nothing, and the smoke test said "Unexpected end of JSON input".
# probes/worldeditor-imagefiles.mjs now checks every bare import against what is copied here.
# git AND git-lfs, because the editor pushes this volume to a remote (gitrepo.mjs) and the volume
# is HERE. The feature worked on a laptop and did nothing in the pod: `/api/git` reported
# `repo: false, lfs: false` and every action would have failed with ENOENT on a binary that was
# never in the image — which is the cluster, where the worlds actually live.
#
# The "no dependencies" note below is about node packages and SDKs. A git client needs git.
#
# AND BLENDER'S RUNTIME, in the same layer because both change about never. Mesa's EGL is the one
# that matters: Workbench renders through an offscreen GL context, and with no GPU in this pod that
# context is llvmpipe. Without it `render.render` fails with a GPU error that reads like a driver
# problem, and the rigging agent loses the renders it checks its own work with.
RUN apt-get update \
    && apt-get install -y --no-install-recommends git git-lfs ca-certificates \
        libx11-6 libxi6 libxxf86vm1 libxfixes3 libxrender1 libxkbcommon0 libsm6 \
        libgl1 libegl1 libegl-mesa0 libgl1-mesa-dri libgbm1 libwayland-client0 libdbus-1-3 \
    && rm -rf /var/lib/apt/lists/*

RUN useradd -u 10001 -m app && mkdir -p /data && chown app /data

# ---- the rigging pipeline, BEFORE the service's own files -------------------------------------
# Ordered for the cache: Blender and the addon change far less often than services/worldeditor, so
# they sit below it and a normal edit to the service rebuilds none of this.
COPY --from=blender /opt/blender /opt/blender
RUN ln -s /opt/blender/blender /usr/local/bin/blender && blender --version | head -n1
COPY --from=blender-agent --chown=10001 /blender-agent /app/ext/blender-agent
# The add-on's Python packages go into Blender's BUNDLED interpreter, which lives under /opt/blender
# and belongs to root — so this half runs as root. The extension itself installs into the USER's
# Blender config, so the other half runs as the user the pod runs as, or the pod's Blender has no
# add-on and `--command blender_mcp` is an unknown command.
RUN BLENDER_BIN=/opt/blender/blender /app/ext/blender-agent/scripts/install.sh --packages-only
USER 10001
RUN BLENDER_BIN=/opt/blender/blender /app/ext/blender-agent/scripts/install.sh --extension-only \
    && blender --background --factory-startup --python-expr "import addon_utils; print('mcp addon:', [m.__name__ for m in addon_utils.modules() if 'mcp' in m.__name__])" 2>&1 | grep 'mcp addon'
USER root
# pipelines/rigging holds both riggers: rig_vehicle.py and rig_character.py (blender.mjs runs them)
COPY pipelines/rigging/ pipelines/rigging/

COPY services/worldeditor/ services/worldeditor/
# The program API's declaration bundle: programs.mjs typechecks a level's program against it
# (program_check, and the viewer's own build route). The pod answered ENOENT for it on 2026-09-30 —
# transpiling worked, checking did not. And the engine-sound list the vocabulary tool reads.
COPY apps/game/src/generated/program-types.json apps/game/src/generated/program-types.json
COPY --from=app /src/vendor/arcade/packages/enginesim/wasm/engines.json vendor/arcade/packages/enginesim/wasm/engines.json
# `program_refs` (programrefs.mjs) builds its rows with the app's OWN worldthings.ts — imported as
# TypeScript, which this Node runs with the types stripped — so an agent is handed the snippets the
# Program pane inserts rather than a copy that drifts; classes.ts says what a library asset is. And
# the sound bank, which `level_vocab` and `program_refs` both list: vocab.mjs has read it from this
# path since the sounds landed, and without the copy the pod answered an empty list for both.
COPY apps/game/src/game/world/worldthings.ts apps/game/src/game/world/worldthings.ts
COPY apps/game/src/assets/classes.ts apps/game/src/assets/classes.ts
COPY apps/game/public/sounds/bank.json apps/game/public/sounds/bank.json
COPY --from=app /src/node_modules/ws/ node_modules/ws/
# TypeScript too: `programs.mjs` transpiles and typechecks a level's program on request (`?js=1`
# is what the viewer asks for when a level names one), and it `require('typescript')`s lazily —
# so the image built, the smoke test passed, and the first level with a program answered HTTP 500
# "Cannot find module 'typescript'" (Rich, 2026-09-30). Pure JavaScript, copied from the build
# stage like `ws`, for the same reason: this stage has no registry.
COPY --from=app /src/node_modules/typescript/ node_modules/typescript/
COPY --from=app /src/apps/game/dist/ apps/game/dist/
# The seed list is CARRIED but NOT ENABLED.
#
# This image used to set PIEDMONT_EDITOR_SEED_SITES to this file, so every fresh volume came up
# holding thirty-one Maryland road bands that belong to whoever baked them. server.mjs was changed
# to make seeding opt-in and the ENV below quietly defeated it — the comment said one thing and
# the image did another (Rich, 2026-09-27: "I want to reset the image so it ships with zero built
# in configs and we can start by importing crofton or crownsville or arrowhead").
#
# The file is still here so that turning the seed back on is `--set seedSites=/app/...` and not a
# rebuild. An empty editor is the default; a populated one is a choice.
COPY bake/sites.json bake/sites.json
# The placement catalog the editor reads, as the fallback under whatever the volume holds.
COPY apps/game/public/assets/catalog.json apps/game/public/assets/catalog.json

USER 10001

# Which commit this is, so /api/health and the editor_version tool can say. `dev` from a plain
# `docker build`; the workflow passes the sha.
ARG GIT_SHA=dev
ENV PIEDMONT_EDITOR_BUILD=${GIT_SHA} \
    PIEDMONT_EDITOR_DATA=/data \
    PIEDMONT_EDITOR_APP=/app/apps/game/dist \
    PIEDMONT_EDITOR_HOST=0.0.0.0 \
    PIEDMONT_EDITOR_PORT=8780 \
    PIEDMONT_EDITOR_REPO=/app \
    BLENDER_BIN=/opt/blender/blender \
    NODE_ENV=production
VOLUME /data
EXPOSE 8780

ENTRYPOINT ["node", "services/worldeditor/server.mjs"]
