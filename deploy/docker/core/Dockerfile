# piedmont-core: Docker-in-Docker that runs the whole piedmont backend on one host.
#
# Build context is the REPOSITORY ROOT (deploy/docker/docker-compose.yml says so): the Overpass
# regions scripts are copied from deploy/helm/overpass/files, the same files the chart's ConfigMap
# is made from, so the two installs cannot drift.
#
# UBUNTU, NOT docker:dind. The official dind image is Alpine (musl), and the NVIDIA Container
# Toolkit — the hook dockerd calls to hand a GPU to a container — is built for glibc only. A GPU in
# a bake or splat container needs that hook inside THIS daemon, so the daemon comes from Docker's
# own apt repository on a glibc base instead. amd64 and arm64 (gh200-class hosts) both work.
FROM ubuntu:24.04

ARG DEBIAN_FRONTEND=noninteractive
# 0 leaves the toolkit out: a smaller image for a host that will never have a GPU
ARG WITH_NVIDIA=1

SHELL ["/bin/bash", "-o", "pipefail", "-c"]

# The daemon and its plugins, from Docker's repository; versions are whatever is current at build
# time, which is the point of rebuilding the core (DOCKER.md, "Upgrading").
# hadolint ignore=DL3008
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        ca-certificates curl gnupg iptables iproute2 kmod procps tini xz-utils pigz e2fsprogs \
    && install -m 0755 -d /etc/apt/keyrings \
    && curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu noble stable" \
        > /etc/apt/sources.list.d/docker.list \
    && apt-get update \
    && apt-get install -y --no-install-recommends docker-ce docker-ce-cli containerd.io docker-compose-plugin \
    && rm -rf /var/lib/apt/lists/*

# hadolint ignore=DL3008
RUN if [ "$WITH_NVIDIA" = "1" ]; then \
        curl -fsSL https://nvidia.github.io/libnvidia-container/gpgkey \
            | gpg --dearmor -o /usr/share/keyrings/nvidia-container-toolkit-keyring.gpg \
        && curl -fsSL https://nvidia.github.io/libnvidia-container/stable/deb/nvidia-container-toolkit.list \
            | sed 's#deb https://#deb [signed-by=/usr/share/keyrings/nvidia-container-toolkit-keyring.gpg] https://#g' \
            > /etc/apt/sources.list.d/nvidia-container-toolkit.list \
        && apt-get update \
        && apt-get install -y --no-install-recommends nvidia-container-toolkit \
        && rm -rf /var/lib/apt/lists/*; \
    fi

# The socket's group, by number, so the world editor (uid 10001 in its own image) can be given it
# with `group_add: ["2375"]` without knowing what Docker's package happened to pick.
RUN groupmod -g 2375 docker

COPY deploy/helm/overpass/files/ /opt/piedmont/overpass-regions/
COPY deploy/docker/core/stack.yml /opt/piedmont/stack.yml
COPY deploy/docker/core/assetsvc-models.json /opt/piedmont/assetsvc-models.json
COPY --chmod=0755 deploy/docker/core/entrypoint.sh /usr/local/bin/piedmont-core

# the inner daemon's images and containers: a named volume in the outer compose file, never the
# shared host directory (overlayfs on a bind of the host's own overlay is the classic DinD failure)
VOLUME /var/lib/docker
EXPOSE 8780

HEALTHCHECK --interval=30s --timeout=10s --start-period=5m --retries=3 \
    CMD curl -fsS -o /dev/null http://127.0.0.1:8780/api/health || exit 1

ENTRYPOINT ["/usr/bin/tini", "-g", "--", "/usr/local/bin/piedmont-core"]
