#!/usr/bin/env bash
# piedmont-core: a Docker daemon, the long-running services on it, and a watchdog.
#
# The core is to the Docker install what the cluster is to the Kubernetes one. It starts its own
# dockerd (Docker-in-Docker, so the host only needs Docker and one privileged container), lays out
# the shared volume, starts the services in /opt/piedmont/stack.yml on that daemon, and then keeps
# them up. The world editor, one of those services, creates the bake containers on the same daemon
# through its socket. See docs/DOCKER.md.
#
# Order matters, and each step says why:
#   1. cgroups and securityfs     what dockerd needs to run nested (moby's hack/dind does the same)
#   2. the GPU runtime            only if a GPU was passed into this container
#   3. the volume layout          before any container binds a path under it
#   4. dockerd                    and wait for it to answer, not merely to start
#   5. registry login             so `pull_policy: always` and the editor's pulls can reach ghcr.io
#   6. env files                  only the variables that are SET (an empty one is a value, not unset)
#   7. compose up                 the services, with the profiles asked for
#   8. watch                      logs to stdout; restart what stays unhealthy; stop cleanly on TERM
set -euo pipefail

ROOT=${PIEDMONT_ROOT:-/srv/piedmont}
STACK=${PIEDMONT_STACK:-/opt/piedmont/stack.yml}
PROJECT=piedmont
APP_UID=10001
log() { printf '[piedmont-core %s] %s\n' "$(date -u +%FT%TZ)" "$*"; }

# ---- 1. nesting ----------------------------------------------------------------------------------
# On cgroup v2 a process may not sit in a cgroup that also has controllers enabled for children, and
# dockerd needs to enable them. Move everything already here into a leaf, then delegate.
if [ -f /sys/fs/cgroup/cgroup.controllers ]; then
  mkdir -p /sys/fs/cgroup/init
  xargs -rn1 < /sys/fs/cgroup/cgroup.procs > /sys/fs/cgroup/init/cgroup.procs 2>/dev/null || :
  sed -e 's/ / +/g' -e 's/^/+/' < /sys/fs/cgroup/cgroup.controllers > /sys/fs/cgroup/cgroup.subtree_control 2>/dev/null || :
fi
if [ -d /sys/kernel/security ] && ! mountpoint -q /sys/kernel/security; then
  mount -t securityfs none /sys/kernel/security 2>/dev/null || log "could not mount securityfs (AppArmor profiles will be off inside)"
fi
# Some hosts' kernels have no nf_tables for a nested netns; the legacy backend works on both.
if ! iptables -nL >/dev/null 2>&1 && command -v iptables-legacy >/dev/null; then
  log "iptables (nft) does not work here; switching to iptables-legacy"
  update-alternatives --set iptables /usr/sbin/iptables-legacy >/dev/null
  update-alternatives --set ip6tables /usr/sbin/ip6tables-legacy >/dev/null
fi

# ---- 2. the GPU ----------------------------------------------------------------------------------
# A GPU reaches the bake/splat containers only if it reached THIS container first (the gpu override
# file), and then only through the NVIDIA Container Toolkit's hook, which this image carries. With
# no GPU this is skipped and DeviceRequests fail loudly on the one job that asks for a GPU.
if [ -e /dev/nvidiactl ] && command -v nvidia-ctk >/dev/null; then
  nvidia-ctk runtime configure --runtime=docker --config=/etc/docker/daemon.json >/dev/null 2>&1 || log "nvidia-ctk runtime configure failed"
  if command -v nvidia-smi >/dev/null && nvidia-smi -L >/tmp/gpus 2>&1; then
    log "GPUs visible to the core: $(wc -l </tmp/gpus) ($(head -1 /tmp/gpus))"
  else
    log "a GPU device is present but nvidia-smi cannot read it — is the host's driver loaded and the gpu override applied?"
  fi
else
  log "no GPU passed in; jobs that ask for one will fail with a reason"
fi

# ---- 3. the shared volume ------------------------------------------------------------------------
# One host directory, laid out the way the cluster's volumes were. The editor runs as 10001, so the
# parts it writes are its own; Overpass databases belong to the overpass image's own user and are
# left to it.
mkdir -p "$ROOT"/{data,jobs,volumes,configmaps,secrets} "$ROOT/volumes/assetsvc-data"
chown "$APP_UID:$APP_UID" "$ROOT/data" "$ROOT/jobs" "$ROOT/volumes" "$ROOT/volumes/assetsvc-data" "$ROOT/secrets"
chmod 700 "$ROOT/secrets"
for inst in overpass overpass-na overpass-eu; do
  mkdir -p "$ROOT/volumes/$inst-db"
  # what the chart's `<instance>-regions` ConfigMap held: the scripts an osm-import Job and the
  # regions sidecar run. Refreshed from the image on every start, like a ConfigMap on an upgrade.
  mkdir -p "$ROOT/configmaps/$inst-regions"
  cp /opt/piedmont/overpass-regions/* "$ROOT/configmaps/$inst-regions/"
  chmod 755 "$ROOT/configmaps/$inst-regions" "$ROOT/configmaps/$inst-regions"/*
done
# The bake's publish credentials, as the Secret the Job's envFrom names (PIEDMONT_EDITOR_S3_SECRET;
# stack.yml gives the editor the same default): KEY=VALUE lines the Docker runner reads. Written
# only when given.
secret_name=${PIEDMONT_EDITOR_S3_SECRET:-publish-s3}
if [ -n "${PUBLISH_S3_ACCESS_KEY_ID:-}" ] && [ -n "${PUBLISH_S3_SECRET_ACCESS_KEY:-}" ]; then
  umask 077
  printf 'AWS_ACCESS_KEY_ID=%s\nAWS_SECRET_ACCESS_KEY=%s\n' "$PUBLISH_S3_ACCESS_KEY_ID" "$PUBLISH_S3_SECRET_ACCESS_KEY" > "$ROOT/secrets/$secret_name.env"
  chown "$APP_UID:$APP_UID" "$ROOT/secrets/$secret_name.env"
  umask 022
  log "publish credentials written to secrets/$secret_name.env"
fi

# ---- 4. dockerd ----------------------------------------------------------------------------------
mkdir -p /run/piedmont /var/log/piedmont
read -ra extra <<< "${PIEDMONT_DOCKERD_ARGS:-}"
# group `docker` is gid 2375 in this image (Dockerfile), the id the world editor is given
dockerd --host=unix:///var/run/docker.sock --group docker "${extra[@]}" >/var/log/piedmont/dockerd.log 2>&1 &
DOCKERD=$!
for _ in $(seq 1 90); do
  if docker info >/dev/null 2>&1; then break; fi
  if ! kill -0 "$DOCKERD" 2>/dev/null; then
    log "dockerd exited while starting — last lines of its log:"
    tail -n 40 /var/log/piedmont/dockerd.log
    exit 1
  fi
  sleep 1
done
docker info >/dev/null 2>&1 || { log "dockerd did not answer in 90 s"; tail -n 40 /var/log/piedmont/dockerd.log; exit 1; }
log "dockerd up: $(docker version --format '{{.Server.Version}}') on $(docker info --format '{{.Driver}}')"

# ---- 5. registries -------------------------------------------------------------------------------
# ghcr.io/hotspoons/* may be private. The token never goes on the command line or into a log.
if [ -n "${GHCR_USER:-}" ] && [ -n "${GHCR_TOKEN:-}" ]; then
  printf '%s' "$GHCR_TOKEN" | docker login ghcr.io -u "$GHCR_USER" --password-stdin >/dev/null && log "logged in to ghcr.io as $GHCR_USER"
fi
# the editor's pulls (docker.mjs) read the same credentials from a copy only it can read
if [ -f /root/.docker/config.json ]; then cp /root/.docker/config.json /run/piedmont/docker-config.json; else echo '{}' > /run/piedmont/docker-config.json; fi
chown "$APP_UID" /run/piedmont/docker-config.json
chmod 600 /run/piedmont/docker-config.json

# ---- 6. env files --------------------------------------------------------------------------------
# Only what is set. `env` prints one line per variable; values here are single-line by contract.
keep() { env | grep -E "$1" | grep -Ev '^[A-Za-z_][A-Za-z0-9_]*=$' || true; }
{
  keep '^(PIEDMONT_EDITOR_|BLENDER_|CLOUDFLARE_API_TOKEN=|MODEL_SERVICE_)'
  [ -n "${PIEDMONT_IMAGE_MODEL_URL:-}" ] && echo "MODEL_URL_IMAGE=$PIEDMONT_IMAGE_MODEL_URL"
  [ -n "${PIEDMONT_MESH_MODEL_URL:-}" ] && echo "MODEL_URL_MESH=$PIEDMONT_MESH_MODEL_URL"
  [ -n "${PIEDMONT_TEXT_MODEL_URL:-}" ] && echo "MODEL_URL_TEXT=$PIEDMONT_TEXT_MODEL_URL"
  true
} | grep -Ev '^(PIEDMONT_EDITOR_RUNNER|PIEDMONT_EDITOR_DATA|PIEDMONT_EDITOR_DOCKER_ROOT|PIEDMONT_EDITOR_DOCKER_NETWORK|PIEDMONT_EDITOR_DOCKER_AUTH|PIEDMONT_EDITOR_ASSETSVC|PIEDMONT_EDITOR_CLAIM|PIEDMONT_EDITOR_S3_SECRET)=' > /run/piedmont/worldeditor.env || true
{
  keep '^ASSETSVC_(CORS|S3_BUCKET|S3_ENDPOINT|S3_REGION|S3_PREFIX|IMAGE_MODEL|MESH_MODEL)='
  [ -n "${ASSETSVC_S3_ACCESS_KEY_ID:-}" ] && echo "AWS_ACCESS_KEY_ID=$ASSETSVC_S3_ACCESS_KEY_ID"
  [ -n "${ASSETSVC_S3_SECRET_ACCESS_KEY:-}" ] && echo "AWS_SECRET_ACCESS_KEY=$ASSETSVC_S3_SECRET_ACCESS_KEY"
  [ -n "${PIEDMONT_IMAGE_MODEL_URL:-}" ] && echo "ASSETSVC_URL_FLUX2_DEV=$PIEDMONT_IMAGE_MODEL_URL"
  [ -n "${PIEDMONT_MESH_MODEL_URL:-}" ] && echo "ASSETSVC_URL_TRELLIS2=$PIEDMONT_MESH_MODEL_URL"
  [ -n "${PIEDMONT_IMAGE_MODEL_KEY:-}" ] && echo "FLUX_API_KEY=$PIEDMONT_IMAGE_MODEL_KEY"
  [ -n "${PIEDMONT_MESH_MODEL_KEY:-}" ] && echo "TRELLIS_API_KEY=$PIEDMONT_MESH_MODEL_KEY"
  true
} > /run/piedmont/assetsvc.env
chmod 600 /run/piedmont/worldeditor.env /run/piedmont/assetsvc.env
[ -n "${PIEDMONT_IMAGE_MODEL_URL:-}" ] || log "no image model (PIEDMONT_IMAGE_MODEL_URL): asset drawing is off"
[ -n "${PIEDMONT_MESH_MODEL_URL:-}" ] || log "no mesh model (PIEDMONT_MESH_MODEL_URL): asset meshing is off"

# ---- 7. the services -----------------------------------------------------------------------------
export COMPOSE_PROFILES=${PIEDMONT_PROFILES:-}
export PIEDMONT_ROOT=$ROOT
compose() { docker compose -p "$PROJECT" -f "$STACK" "$@"; }
read -ra only <<< "${PIEDMONT_SERVICES:-}"
log "starting the stack (profiles: ${COMPOSE_PROFILES:-none}; services: ${PIEDMONT_SERVICES:-all})"
until compose up -d --remove-orphans "${only[@]}"; do
  log "compose up failed; retrying in 30 s (a pull, most likely — every image is pulled on every start; check the network and the registry login)"
  sleep 30
done

# ---- 8. watch ------------------------------------------------------------------------------------
stopping=0
shutdown() {
  stopping=1
  log "stopping: services first (60 s grace), then dockerd. Bake containers are left to the daemon's own stop."
  compose stop -t 60 || true
  kill -TERM "$DOCKERD" 2>/dev/null || true
  wait "$DOCKERD" 2>/dev/null || true
  exit 0
}
trap shutdown TERM INT

# every service's log on this container's stdout, so `docker compose logs core` on the host shows them
( while [ "$stopping" = 0 ]; do compose logs -f --no-color --since 1s 2>/dev/null || true; sleep 5; done ) &

# Docker restarts a container that EXITS; nothing restarts one that is up and unhealthy. Three
# consecutive unhealthy checks (the healthcheck's own `retries`) and then this many minutes more.
grace=${PIEDMONT_UNHEALTHY_RESTART_MIN:-5}
declare -A since
while [ "$stopping" = 0 ]; do
  kill -0 "$DOCKERD" 2>/dev/null || { log "dockerd died — exiting so the host restarts the core"; tail -n 40 /var/log/piedmont/dockerd.log; exit 1; }
  for c in $(docker ps --filter "label=piedmont.restart-on-unhealthy=true" --filter health=unhealthy --format '{{.Names}}'); do
    now=$(date +%s)
    since[$c]=${since[$c]:-$now}
    first=${since[$c]}
    if [ $(( now - first )) -ge $(( grace * 60 )) ]; then
      log "$c has been unhealthy for ${grace} min; restarting it"
      docker restart -t 30 "$c" >/dev/null || true
      unset "since[$c]"
    fi
  done
  for c in "${!since[@]}"; do
    docker ps --filter "name=^${c}\$" --filter health=unhealthy -q | grep -q . || unset "since[$c]"
  done
  sleep 30 &
  wait $! || true
done
