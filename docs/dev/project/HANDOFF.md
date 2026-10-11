# Handoff: finishing the split

For an agent picking up piedmont after the split from siomporas-arcade. Read this, then
[AGENTS.md](../../../AGENTS.md), [DEVELOPING.md](../../../DEVELOPING.md) and
[ACCEPTANCE.md](ACCEPTANCE.md). State as of 2026-10-11.

## Where things stand

| Area | State |
|---|---|
| Repository | Pushed to `github.com/hotspoons/piedmont`, `main`. Imported from arcade `34933bd` ([ORIGIN.md](ORIGIN.md)), then renamed, documented and fixed. |
| Local gate | `npx tsc -b`, `npx vitest run` (993 tests, incl. service suites, oxlint, names, pull policy, links), bake `python -m unittest discover -s tests` (265), `npm run build`: all pass on Node 24. |
| CI | Green on `c7e22c4`. One service suite hung CI twice (anonymous timeout); it did not recur. The checks wrapper now kills a suite that outlives 165 s and fails **with the file name and its last output**, so the next occurrence identifies itself. |
| Images | All six published on ghcr as `latest`: `piedmont-bake`, `-worldeditor`, `-assetsvc`, `-recon`, `-blender`, `-core`. The core image's CI smoke ran its inner dockerd, a nested container and the world editor on the Docker runner, on amd64 and arm64. |
| Dev container | Fixed but **never built**: Debian trixie base needs `"moby": false`; Node 24; OpenChamber with opencode's PATH on the extension host. Rich's first build is its first test. |
| Cluster deployment | **Not done.** The new `piedmont` namespace on gh200-1 is the main open acceptance item. |
| Docker stack | Statically validated, plus the core image smoke above. No host has run `docker compose up` and baked a world. |

## Next, in order

Anything that changes the cluster, DNS, a remote repository other than piedmont, or the arcade
needs Rich's explicit approval first. Ask with the concrete diff in hand.

1. **Rich rebuilds the dev container.** If it fails, the error is the next task.
2. **Decide the deployment's open questions** (Rich's call; bring a recommendation):
   - **Hostnames.** `deploy/gh200-1/worldeditor.yaml` inherits the chart's ingress host
     `worldeditor.richard-siomporas.basedweights.com`, and `overpass.yaml` inherits
     `overpass.richard-siomporas.basedweights.com`. **Both are already served by the arcade's
     releases in `default`.** Installing as-is would put two ingresses on one host. Pick new hosts
     (e.g. `piedmont.…`, or disable the Overpass ingress — in-cluster readers use the Service).
   - **A new Maryland Overpass in `piedmont`?** `cluster.yaml` lists an `overpass` release. On a
     fresh volume it imports for hours. The editor already reads `overpass-eu` and `overpass-na`
     from `default` across namespaces (`worldeditor.yaml` `overpassUrl`); the Maryland one could be
     read the same way instead.
   - **Pin the images.** `just deploy-bump gh200-1` rewrites `tag: latest` to the current `sha-`
     builds for review and commit. Values say `latest` only until the first builds existed; they do now.
   - **The data volume starts empty.** The arcade's `worldeditor-data` PVC holds ~126 GB of lidar
     cache; a full dc-metro bake fetches ~180 GB. Fine to refetch, or copy the cache: Rich's call.
3. **Preview, then deploy.** `just deploy-check gh200-1` renders and validates against the API
   server and changes nothing. Show Rich the rendered diff (per release) before `just deploy gh200-1`.
   DNS for new hosts can take a while and a negative answer is cached ~30 min; verify with
   `curl --resolve <host>:443:<ingress IP>` rather than trusting a failed lookup.
4. **Walk the deployment's acceptance items** ([ACCEPTANCE.md](ACCEPTANCE.md), "Images and deploy"):
   draw a small world, bake it as one Job and sharded, publish, play it in a browser; an OSM region
   import; one asset generated through the asset service against the AI endpoints; a splat
   training run where a GPU is free. Record each with its command or link and tick the box.
5. **Docker stack on a host**: `docs/deploy/docker.md` has the commands and a smoke bake.
6. **Arcade side** (in the arcade repo, with Rich's approval): tag the commit `arcade.json` pins and
   bump the pin to the tag (`npm run arcade:bump <tag>`); then, only once every box is ticked, the one
   PR that removes the old copy from the arcade. The arcade's own `default`-namespace releases are
   retired after the new namespace serves everything.

## Known issues

- **World editor: Assets mode has no Traffic tab** (traffic sets are only editable from
  `/editor.html`'s Assets dialog or MCP). Looks like a bug.
- **Stage panel has no control for a level's `program` or traffic `set`**; the guide sends users to
  Shell mode or MCP `level_save`.
- **Geofabrik's published index can have empty region outlines** (11 regions on 2026-10-10,
  `virginia.poly` 0 bytes). Routing now refuses empty outlines and falls back to the volume's copy or
  the seed (`services/worldeditor/geofabrik.mjs`); an OSM import of Virginia may fail until Geofabrik
  fixes its files.
- **Lidar canopy includes roofs** where a vendor left buildings unclassified; the game masks OSM
  footprints out of tree planting. The perf panel's tree lines explain bare ground cell by cell.
- **Cloudflare deploy from a piedmont install is unproven** (the client is tested against a stand-in).
- dc-metro-take-2's last bake had 12 coarse pyramid tiles with no NAIP, painted the mean colour.

## Things that bite

- **Pushing:** the container pushes over SSH (its forwarded agent authenticates as `hotspoons`). A
  remote with only an `https` URL fails with "could not read Username"; set
  `git config remote.origin.pushurl git@github.com:hotspoons/<repo>.git`. Check `ssh -T git@github.com`
  before concluding a push is impossible.
- **Every image pull policy is `Always`**, in charts, Job specs and compose; CI rejects anything else.
- **The old project name may not appear anywhere** (`scripts/check-names.mjs`). This includes test
  fixtures; do not try to assemble the word to get past the check.
- **Vite reloads every attached tab when a file is saved.** Before a change to the start-up path
  reaches someone's live tab, boot it headlessly first (`scripts/boot-check.mjs`).
- **gh200-1 is arm64** (GH200s). Images must be multi-arch; the image workflows build each
  architecture on a native runner.
- **Never print secrets**: the MCP token in `.mcp.json`, kube configs, R2/Cloudflare credentials.
- **Perf claims come from a real GPU at speed** (the rig at 70 m/s or more), reported as percentiles.

## Where the history is

- [ORIGIN.md](ORIGIN.md): what was imported from where, what changed during the port, how to port a
  later arcade fix.
- [ACCEPTANCE.md](ACCEPTANCE.md): the criteria and the evidence for each.
- [../specs/](../specs/README.md): the design notes and plans the code was built from.
- [../history/](../history/): session logs from the arcade era.
