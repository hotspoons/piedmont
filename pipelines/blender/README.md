# blender — the headless Blender image

`pipelines/blender/Dockerfile` builds Blender, pinned by [`.devcontainer/blender.env`](../../.devcontainer/blender.env),
as an image of its own: `ghcr.io/hotspoons/piedmont-blender:<version>` (both architectures, by
[.github/workflows/blender-image.yml](../../.github/workflows/blender-image.yml)). The world editor's
image copies `/opt/blender` out of it, so the rigging pipeline ([pipelines/rigging](../rigging/README.md))
runs in the pod.

Why a separate image rather than a stage of the world editor's: blender.org ships no arm64 build of
5.x, so arm64 means compiling Blender, which is far past GitHub's job limit under QEMU and would
re-run whenever a base image moved. This image builds on native runners, and only when the pinned
version changes. The Dockerfile's header has the details (what is switched off, and why OpenVDB is
not).

In the dev container the same version is installed by `.devcontainer/build-blender.sh` (official
binary on x86_64, a source build into a named volume on arm64); `just blender` runs it in the
foreground and `just blender-log` shows how far the background build got.
