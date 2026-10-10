# deploy/docker — the Docker / Docker-in-Docker stack (to be ported)

**Not here yet.** The compose stack — the world editor, the asset service, an Overpass instance and
a bake runner on one host with `docker compose up`, plus a separate stack for the AI inference
(flux, TRELLIS) reached by URL so it can be outsourced — is being built on the arcade's
`agent/docker` branch. It lands here, ported into piedmont's names and layout, rather than in the
arcade (docs/ORIGIN.md, "Branches still to port").

Until then:

- the images build with `docker build` inside the dev container (it has its own Docker daemon):
  `docker build -f services/worldeditor/Dockerfile .`, `docker build bake`,
  `docker build -f services/assetsvc/Dockerfile .`, `docker build services/recon`,
  `docker build pipelines/blender`;
- the cluster deployment is Helm: [deploy/README.md](../README.md).

When the stack arrives it follows the same rules as the charts: every image pulls with policy
`always` (`pull_policy: always` in compose; `scripts/check-pull-policy.mjs` fails on anything else),
the data directory is `$PIEDMONT_DATA`, and its smoke test bakes a small world end to end.
