# deploy — what runs where, written down

| Path | What |
|---|---|
| [`helm/worldeditor`](helm/worldeditor/values.yaml) | the world editor (serves the game too) |
| [`helm/assetsvc`](helm/assetsvc/values.yaml) | the asset service |
| [`helm/overpass`](helm/overpass/values.yaml) | an Overpass instance (`values-eu.yaml`, `values-na.yaml`: the planet-scale ones) |
| [`helm/recon`](helm/recon/values.yaml) | TRELLIS.2 reconstruction (GPU) |
| [`helm/bake`](helm/bake/values.yaml) | a one-off bake Job (the world editor normally launches its own) |
| [`gh200-1/`](gh200-1/cluster.yaml) | the gh200-1 cluster: its namespace and the releases on it |
| [`docker/`](docker/README.md) | the Docker / DinD compose stack: everything on one host ([docs/DOCKER.md](../docs/DOCKER.md)) |

Every cluster install is a values file in here plus one command. Nothing is applied with
`helm --set` from somebody's shell, because a flag typed once is a deployment nobody else can
reproduce and nobody can review (Rich, 2026-09-28: "I don't want to run things deployed via click
ops and craft scripts, I want to run them using repeatable deployments").

```
just deploy gh200-1              # everything for that cluster, at the pinned image
just deploy gh200-1 worldeditor  # one release
just deploy gh200-1 --check      # render and diff against what is live; changes nothing
```

## The namespace is a value

`deploy/<cluster>/cluster.yaml` names the namespace every release goes into (`namespace:`), and
`scripts/deploy.mjs` passes it to `helm upgrade -n <namespace> --create-namespace`. The charts name
no namespace: the world editor reads its own from the release (`PIEDMONT_EDITOR_NAMESPACE` is
`.Release.Namespace`), creates its bake Jobs there, and reaches the asset service and Overpass by
their short service names. Moving the whole stack is changing that one line. Endpoints outside the
release — the AI inference (flux, TRELLIS) and, on gh200-1, the planet-scale Overpass instances in
`default` — are fully-qualified URLs in the values.

## Every image pulls with policy Always

Rich, 2026-10-10: *"Policy should be always, always."* Every chart's `image.pullPolicy` is
`Always`, and so is every Job and pod the world editor builds (bakes, shards, OSM imports, splat
containers) and every compose service (`pull_policy: always`). A tag like `latest` moves, and under
any other policy a node that has pulled it once keeps running its cached copy: the rollout restarts
the old image and the fix never lands, with nothing to say so. `scripts/check-pull-policy.mjs` fails
on any other policy, anywhere in the repository, and runs in CI and in `npx vitest run`.

## The layout

```
deploy/<cluster>/<release>.yaml    the values, reviewed like code
deploy/<cluster>/cluster.yaml      what is true of the cluster itself, not of a release
```

A release file is the WHOLE input to that install. `helm upgrade --reuse-values` is not used
anywhere: it keeps the values the previous release was installed with, so a chart that gains a
block renders it as nil and the upgrade fails — which happened here on 2026-09-28 — and, worse,
it means the live state depends on the order somebody ran commands in rather than on a file.

## Image tags are pinned, and that is the point

`image.tag` names a build. `latest` would make "what is deployed" a question about when the pod
last restarted, which is the thing this directory exists to stop. `just deploy <cluster> --bump`
rewrites the tags to the newest published image for the current commit and shows the diff; it is
a deliberate edit to a tracked file, not a side effect of deploying.

## What is NOT in here

Secrets. `publish.secretName` names a Secret the cluster already holds; nothing in this directory
contains a credential, and a values file that needed one would be the wrong shape.
