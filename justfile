# piedmont — task recipes (https://just.systems)
#
#   apps/game              the game, the site editor (editor.html) and the world editor (world.html)   :5185
#   bake/                  the world baker (Python, `python -m piedmont_bake`)
#   services/worldeditor   the world editor's backend + MCP                                            :8780
#   services/assetsvc      AI asset generation (flux, TRELLIS) behind one API                         :8770
#   vendor/arcade          the shared engine packages, linked by `npm run setup` (docs/dev/arcade.md)
#
# First time on a machine: `npm run setup`. It links the arcade packages, clones gaussworks, and
# installs the Node and Python dependencies.

set shell := ["bash", "-euo", "pipefail", "-c"]

# the bake's interpreter: $PIEDMONT_VENV if set, else bake/.venv (made by `npm run setup`)
py := env_var_or_default("PIEDMONT_VENV", justfile_directory() + "/bake/.venv") + "/bin/python"

# list recipes
default:
    @just --list --unsorted

# --- setup ------------------------------------------------------------------

# link the arcade packages, clone gaussworks, install Node + Python dependencies
setup *args:
    node scripts/setup.mjs {{ args }}

# move the arcade pin (a sha, tag or branch), then run setup
arcade-bump ref:
    node scripts/arcade-bump.mjs {{ ref }} && node scripts/setup.mjs

# --- dev loop ---------------------------------------------------------------

# the game's dev server on :5185 (reads $PIEDMONT_DATA/sites straight off disk)
dev:
    npm run dev -w apps/game

# production build (typecheck + bundle) into apps/game/dist
build:
    npm run build

# serve the production build
preview:
    npm run build -w apps/game && npm run preview -w apps/game

# --- checks -----------------------------------------------------------------

# everything CI runs: lockfile, typecheck, vitest (game, service suites, oxlint, names, pull policy,
# links), the bake's unit tests
check:
    node scripts/check-lockfile.mjs
    npx tsc -b
    npx vitest run
    cd bake && {{ py }} -m unittest discover -s tests

typecheck:
    npx tsc -b

test:
    npx vitest run

# the bake's unit tests
bake-test:
    cd bake && {{ py }} -m unittest discover -s tests

# the repository checks on their own
names:
    node scripts/check-names.mjs
pull-policy:
    node scripts/check-pull-policy.mjs
links:
    node scripts/check-links.mjs

# --- dev operator shell (opt-in) --------------------------------------------
# A JS shell into the LIVE page: the dev server relays code you POST to the running app and returns
# a JSON-safe result — real browser, real GPU. OFF unless APEX_BRIDGE is set, and it cannot reach a
# production build at all. See vendor/arcade/packages/engine/src/dev/bridge-plugin.ts.

export APEX_BRIDGE := env_var_or_default("APEX_BRIDGE", "")

# dev server WITH the operator shell enabled (token: apex-dev, override with APEX_BRIDGE)
bridge-dev:
    APEX_BRIDGE="${APEX_BRIDGE:-apex-dev}" npm run dev -w apps/game

# evaluate JS in the attached page: `just bridge 'apex.perf()'` (port: the dev server's)
bridge code port="5185":
    APEX_BRIDGE="${APEX_BRIDGE:-apex-dev}" APEX_ORIGIN="http://localhost:{{ port }}" node scripts/bridge.mjs {{ quote(code) }}

# list the pages currently attached to the shell
bridge-clients port="5185":
    APEX_BRIDGE="${APEX_BRIDGE:-apex-dev}" APEX_ORIGIN="http://localhost:{{ port }}" node scripts/bridge.mjs --clients

# --- remote testing ---------------------------------------------------------

# a tunnel that survives dev-server restarts: devproxy on :5190 fronts the game, cloudflared fronts the proxy
tunnel:
    (node scripts/devproxy.mjs --listen 5190 --target 5185 &) && sleep 1 && PORT=5190 APP=game bash scripts/tunnel.sh

# headless screenshot probe against a dev server (see scripts/probe.mjs)
probe out="shots/probe.png" seconds="0" *keys:
    node scripts/probe.mjs {{ out }} {{ seconds }} {{ keys }}

# (re)install the headless Chromium the probes drive
browser:
    sudo npx playwright install-deps chromium && npx playwright install chromium

# --- the bake: real-road worlds ---------------------------------------------
# bake/ pulls a road network and everything the public record knows about it: OSM spine and
# features, 1 m DEM, 30 cm NAIP, the classified lidar point cloud (bridge decks, canopy, cut/fill)
# and the geology under it, into $PIEDMONT_DATA/sites/<slug>/. See bake/README.md.

# photos in ext/ref-driving -> bake/sites.json
bake-sites:
    {{ py }} -m piedmont_bake sites

# build $PIEDMONT_DATA/sites/<slug>/ (slug or `all`); e.g. `just bake-fetch south-mountain-i70 --skip lidar`
bake-fetch slug="all" *args:
    cd bake && {{ py }} -u -m piedmont_bake fetch {{ slug }} {{ args }}

# rewrite the web/ layers + sites/index.json without re-fetching
bake-export slug="all":
    cd bake && {{ py }} -m piedmont_bake export {{ slug }}

# one line per fetched site
bake-report:
    cd bake && {{ py }} -m piedmont_bake report

# --- world editor: draw a world on a map, bake it, publish it ------------------
# services/worldeditor is the pod's backend and apps/game/world.html is its page. Two processes in
# development, one image in the cluster; see services/worldeditor/README.md. Run the service, then
# the app; the app reaches the service through a Vite proxy, so every fetch in the page is relative,
# exactly as it is in the pod.

# the world editor's backend, on :8780 (OSM, worlds, bakes, the editor's save path, MCP)
worldeditor-svc:
    PIEDMONT_EDITOR_PYTHON="{{ py }}" node services/worldeditor/server.mjs --port 8780 --data "${PIEDMONT_DATA:-data}"

# the world editor page, on :5212 -> http://localhost:5212/world.html
worldeditor-app:
    PIEDMONT_PORT=5212 PIEDMONT_EDITOR=http://localhost:8780 npm run dev -w apps/game

# the local game against a REMOTE deployment's data, on :5186: the bake (/sites), levels, photos,
# splats and the asset service come from there; the page comes from this tree. The way to profile
# a deployed world with local tooling. Operator shell: `APEX_BRIDGE=apex-dev just remote`, then
# `just bridge 'apex.perf()' 5186`.
remote url="https://worldeditor.richard-siomporas.basedweights.com" port="5186":
    PIEDMONT_EDITOR_REMOTE={{ url }} PIEDMONT_PORT={{ port }} APEX_BRIDGE="${APEX_BRIDGE}" npm run dev -w apps/game

# the world editor's probe; `just worldeditor-probe prove` runs the negatives (each check fed something
# that must break it, which is the only reason to believe the rest)
worldeditor-probe mode="":
    #!/usr/bin/env bash
    set -euo pipefail
    if [ "{{ mode }}" = "prove" ]; then
      node services/worldeditor/probe.mjs --prove
    else
      node services/worldeditor/probe.mjs --api http://localhost:8780 --ui http://localhost:5212/world.html
    fi

# --- deployment -------------------------------------------------------------
# Every cluster install is deploy/<cluster>/*.yaml plus this (deploy/README.md). Nothing is
# applied with `helm --set` from a shell: a flag typed once is a deployment nobody can review.

# apply a cluster's releases, or one of them
deploy cluster release="":
    node scripts/deploy.mjs {{ cluster }} {{ release }}

# render and validate against the live API server; changes nothing
deploy-check cluster:
    node scripts/deploy.mjs {{ cluster }} --check

# rewrite the pinned image tags to the current commit, for review and commit
deploy-bump cluster:
    node scripts/deploy.mjs {{ cluster }} --bump

# --- housekeeping -----------------------------------------------------------

# install or build the pinned Blender in the foreground (post-create does it in the background)
blender:
    bash .devcontainer/build-blender.sh

# how far the background Blender build got
blender-log:
    @tail -n 40 ~/.cache/blender-build.log 2>/dev/null || echo "no build log yet"

clean:
    rm -rf apps/*/dist node_modules/.tmp node_modules/.vite apps/*/node_modules/.vite shots
