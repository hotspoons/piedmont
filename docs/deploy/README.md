# Operator references

How piedmont's backend is installed and run. Start with the user guide's
[Running piedmont](../guide/running.md); these pages go into the detail.

- [docker.md](docker.md): the whole backend on one Docker host. The core container and its
  inner Docker daemon, how Jobs become containers, the shared volume, GPUs, the separate AI stack,
  upgrades, backup and restore.
- [kubernetes.md](kubernetes.md): the Helm charts, a cluster's values directory, secrets, image
  tags, Overpass and the AI endpoints.
- [Deploying to Cloudflare](../guide/cloudflare.md): publishing worlds to R2 and a Worker (a user
  guide page; it covers the account setup too).

Beside the code:

- [deploy/README.md](../../deploy/README.md): the `deploy/` directory and its rules.
- [deploy/docker/README.md](../../deploy/docker/README.md): the compose files.
- [services/worldeditor/README.md](../../services/worldeditor/README.md): the world editor's
  endpoints and environment.
- [services/assetsvc/README.md](../../services/assetsvc/README.md),
  [services/overpass/README.md](../../services/overpass/README.md),
  [services/recon/README.md](../../services/recon/README.md).
