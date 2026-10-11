# The backend on Kubernetes

Operator reference for installing piedmont on a Kubernetes cluster with its Helm charts. The short
version is in the user guide, [Running piedmont](../guide/running.md); the repository's own notes
on the deploy directory are [deploy/README.md](../../deploy/README.md).

## The charts

| Chart | Installs | Off by default? |
|---|---|---|
| `deploy/helm/worldeditor` | the world editor (it serves the game too), a ReadWriteMany data volume, a ServiceAccount and a namespaced Role that can create and watch Jobs and read pod logs, a Service, and optionally an Ingress or HTTPRoute | yes |
| `deploy/helm/assetsvc` | the asset service, its catalog volume, and its model roster as a ConfigMap | yes |
| `deploy/helm/overpass` | one Overpass instance: an extract imported on first start, then kept current from Geofabrik's diffs; a `regions` sidecar that applies regions added later | |
| `deploy/helm/recon` | TRELLIS.2 image-to-3D on a GPU node | |
| `deploy/helm/bake` | a one-off bake Job (the world editor normally starts its own) | |

The world editor's Role is the smallest that works: Jobs and pods in its own namespace, nothing
cluster-scoped, no Secrets. Its bake Jobs mount the same volume the editor serves from. Splat
training can optionally read node GPU counts cluster-wide (`gpuVisibility: true`).

## A cluster is a directory of values files

```
deploy/<cluster>/cluster.yaml      the namespace, and the list of releases to apply
deploy/<cluster>/<release>.yaml    one release's values: the whole input to that install
```

`deploy/gh200-1/` is the reference cluster's. Copy it for your own and edit:

```yaml
# deploy/<cluster>/cluster.yaml
cluster:
  name: my-cluster
  namespace: piedmont
releases:
  - name: worldeditor
    chart: deploy/helm/worldeditor
  - name: assetsvc
    chart: deploy/helm/assetsvc
  - name: overpass
    chart: deploy/helm/overpass
```

Then, from a checkout with `kubectl` and `helm` pointed at the cluster:

```bash
just deploy-check <cluster>          # render and validate against the live API server; changes nothing
just deploy <cluster>                # helm upgrade --install every release into the namespace
just deploy <cluster> worldeditor    # one release
just deploy-bump <cluster>           # rewrite the image tags to the builds for the current commit
```

Each release is applied with `helm upgrade --install <name> <chart> -n <namespace>
--create-namespace -f deploy/<cluster>/<name>.yaml`; no values are reused from a previous install,
so the file is always the whole truth. The charts name no namespace and reach each other by short
service names, so moving the stack is changing the one `namespace:` line.

## What to set in the world editor's values

| Value | Why |
|---|---|
| `enabled: true` | the chart renders nothing without it |
| `ingress.enabled`, `ingress.hosts`, `ingress.tls` | the chart's example host is the reference deployment's; use your own. Turn on the Ingress **or** `httpRoute`, never both |
| `data.storageClass` | empty uses the cluster default, which must provide **ReadWriteMany** (a bake Job writes while the editor serves) |
| `overpassUrl`, `overpassRegions` | your Overpass instances and the Geofabrik regions each holds (for example `overpass=us/maryland`). The public mirrors are always appended. The chart's default URL is the reference deployment's |
| `assetsvcUrl` | the asset service; `http://assetsvc` in the same namespace |
| `bake.image`, `bake.resources` | the bake image and each bake Job's requests and limits |
| `cloudflare.secretName` | a Secret with `CLOUDFLARE_API_TOKEN`, so the Deploy mode's token survives restarts |
| `publish.bucket`, `publish.endpoint`, `publish.secretName` | an S3/R2 bucket for **World → Bake → Publish**, and the Secret with its keys |
| `image.tag` | pin a `sha-<commit>` build; `just deploy-bump` writes it |

The world editor's own settings (asset service, Overpass, place search, images, splat runner) can
also be changed at runtime in **Settings → Services**; a value set there overrides the environment
the chart sets. Its full list of environment variables is in
[services/worldeditor/README.md](../../services/worldeditor/README.md#configuration).

## Secrets

Nothing in `deploy/` contains a credential. Create Secrets in the namespace and name them in values:

```bash
# the Deploy mode's Cloudflare token
kubectl -n piedmont create secret generic cloudflare --from-literal=CLOUDFLARE_API_TOKEN=<token>

# the publish bucket's keys (an R2 API token's access key id and secret)
kubectl -n piedmont create secret generic piedmont-r2 \
  --from-literal=AWS_ACCESS_KEY_ID=<id> --from-literal=AWS_SECRET_ACCESS_KEY=<secret>

# a fixed MCP token, if you do not want the generated one
#   set PIEDMONT_EDITOR_MCP_TOKEN in the editor's environment from a Secret
```

## Images and pull policy

Images are `ghcr.io/hotspoons/piedmont-{worldeditor,assetsvc,bake,recon,blender}`, built by the
repository's GitHub Actions. Every chart, every Job the world editor creates, and every compose
service uses pull policy `Always`: with any other policy a node that once pulled a moving tag keeps
running its cached copy, and a fix never lands. Pin `sha-` tags for reproducible installs.

## Overpass

Each instance imports its extract on first start, which takes from about 20 minutes (one US state)
to more than a day (a continent, with terabytes of disk). `values-na.yaml` and `values-eu.yaml` are
the continent-sized values. Routing, coverage outlines and adding a region to a running instance are
described in [services/overpass/README.md](../../services/overpass/README.md).

## AI services

The asset service reaches the image and mesh models by URL, set in its `models` roster (or
`ASSETSVC_URL_<ID>`). They can be the `recon` chart and an image server on your cluster, the Docker
AI stack on another machine, or a hosted provider; see [Generating assets](../guide/assets-ai.md).

## Status

The charts are what the reference deployment runs. A fresh install of piedmont's own images into a
new namespace is an open item in [ACCEPTANCE.md](../dev/project/ACCEPTANCE.md).
