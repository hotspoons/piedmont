# Deploying to Cloudflare

The **Deploy** mode (key `8`) publishes one or more baked worlds as a public website: the game runs
as a Cloudflare **Worker**, and the worlds' data sits in an **R2** bucket. Players need nothing but
a browser, and the page opens in game view.

Several worlds can share one address; the player switches between them in the game. Each deploy
copies only what the chosen worlds use: their bake, their authored documents, their levels and
programs, and the library models and vehicle builds those actually name, not the whole library.

> **Status:** the deploy client is covered by tests against a stand-in for Cloudflare's API. A
> deploy from a piedmont install of its own has not been proved yet; the run's log names the exact
> call Cloudflare refused, if any.

## 1. Prepare the Cloudflare account (once)

| Needed | Where in the dashboard | Notes |
|---|---|---|
| **Workers** | Workers & Pages | the free plan is enough (100,000 requests a day; static assets are free). The paid plan lifts the request cap |
| **R2** | R2 Object Storage → *Purchase R2* | R2 must be added to the account before a bucket can exist. It asks for a payment method, but the free tier (10 GB stored, 10 million reads and 1 million writes a month, free egress) covers a few worlds |
| **a workers.dev subdomain** | Workers & Pages → Overview → *Change* (right column) | set once per account; every Worker then gets `<name>.<subdomain>.workers.dev` |
| **a zone** (optional) | *Add a domain* | only for a custom hostname such as `play.example.com`. The domain's nameservers must point at Cloudflare |

## 2. Make an API token

Dashboard → **My Profile → API Tokens → Create Token → Custom token** (a user token), or **Manage
Account → API Tokens** (an account-owned token). Either works. Give it:

| Scope | Permission | Level | Why |
|---|---|---|---|
| Account | Workers Scripts | Edit | publish the Worker and upload the game |
| Account | Workers R2 Storage | Edit | list and create buckets; write and delete objects |
| Account | Account Settings | Read | list accounts and the workers.dev subdomain |
| Zone | Zone | Read | list zones (custom hostname only) |
| Zone | Workers Routes | Edit | attach the Worker to the hostname (custom hostname only) |
| Zone | DNS | Edit | Cloudflare writes the hostname's DNS record (custom hostname only) |

Account resources: your account. Zone resources: all zones of the account, or the one zone. Copy the
token when it is shown; Cloudflare does not show it again.

**Where the editor keeps it.** Either type it into the Deploy panel, or set `CLOUDFLARE_API_TOKEN`
in the editor's environment:

- A **typed** token is verified, then held only in the editor's memory: never written to disk,
  never returned by the API, never logged. **Forget it** clears it, and **restarting the editor
  forgets it**; the panel checks before every deploy.
- From the **environment** it survives restarts. On Docker, put it in `deploy/docker/.env`. On
  Kubernetes, create a Secret and name it in the world editor's values:

  ```bash
  kubectl -n <namespace> create secret generic cloudflare --from-literal=CLOUDFLARE_API_TOKEN=<token>
  ```

  ```yaml
  cloudflare:
    secretName: cloudflare
  ```

## 3. Deploy

The Deploy panel, top to bottom:

1. **Cloudflare token**: paste it and **Use this token**, or it says "from the environment".
2. **Worlds**: tick one or several baked worlds. They all go to one address.
3. **Cloudflare**: **Query Cloudflare** lists your accounts, zones, buckets and workers.dev
   subdomain. Pick the **Account**.
4. **Where it goes**:
   - **Worker name** (lower case, digits and dashes);
   - **serve at `<name>.<subdomain>.workers.dev`** on or off;
   - optionally a **Zone** and a **Hostname** in it (`play` for `play.example.com`); Cloudflare
     writes the DNS record and issues the certificate;
   - the **Bucket**, or **a new one…** (created on the first deploy);
   - the **Prefix** under which every object of this deploy lives (default
     `piedmont/<world>-<stamp>`);
   - **delete older copies of these worlds from the bucket afterwards**.
5. **Deploy**: **Plan (dry run)** first. It lists how many objects and bytes go up, by group (bake,
   documents, levels, assets), which levels, models and builds are included, and every warning.
   Then **Deploy**. The deploy is a run like a bake: it appears with a live log, and the log's last
   line is the URL.

**Past deployments** at the top of the panel lists earlier deploys of worlds on this install:
**Load** puts one back in the form, **Redeploy** replaces that copy with the current bake,
**Open** visits it, and **Delete** removes its objects from R2.

To change what a deployed game opens on, mark a level **launch into this** in the Stage mode and
redeploy.

## What is uploaded

The game itself (the built app, a few hundred files) is uploaded as the Worker's static assets;
only files Cloudflare does not already have are sent. Into the bucket, under the prefix, go exactly
the paths the game fetches:

- `sites/index.json` (only the chosen worlds) and, per world, its baked tiles (`web/`), its manifest
  and every authored document;
- `levels/…` and `api/levels`, the levels set in those worlds, and `api/programs/…`, their programs
  already compiled to JavaScript;
- the catalog entries, finished models and vehicle, traffic and other builds the worlds use, found
  by following every id in those documents, plus any custom sounds those builds name.

Not uploaded: the lidar, the source rasters (unless you tick *include bake sources*), and every
model nothing in the worlds names. Objects over 32 MiB go up in parts through R2's S3 endpoint
using credentials derived from the same token, so there is nothing extra to configure.

The bucket needs no public access and no custom domain: the Worker reads it through a binding.
The deployed game is read-only; edits happen in the world editor and are redeployed.

## Keeping reads free

R2 bills reads after 10 million a month. The Worker caches every object it reads in Cloudflare's
edge cache (tiles for a year, documents for a minute), so a tile is read from the bucket roughly
once per data centre. Two optional dashboard switches, for a custom hostname:

1. **Caching → Tiered Cache → Smart Tiered Cache** (free): data centres fetch from a regional
   tier instead of each going to R2.
2. **Caching → Cache Reserve** (paid): keeps cached objects for a month however rarely they are
   hit; worth it only for a world many people play a little.

## Limits to know

| What | Limit |
|---|---|
| Worker static assets | 20,000 files, 25 MiB each |
| Worker script | 3 MiB compressed on the free plan (the deploy's Worker is a few KB) |
| Requests | 100,000 a day on the free Workers plan, counting every tile |
| Bucket name | 3 to 63 characters: lower-case letters, digits and dashes |

## Over the API

```
GET    /api/deploy/status                 whether a token is present, and from where; baked worlds
POST   /api/deploy/token      {token}     hold a token in memory (verified first); DELETE forgets it
GET    /api/deploy/cloudflare[?account=]  accounts, zones, buckets, workers.dev subdomain
POST   /api/deploy/bucket     {account, name}
POST   /api/deploy/plan       {worlds}    the dry run
POST   /api/deploy/start      {worlds, account, bucket, prefix?, worker: {name, workersDev?, hostname?, zoneId?}, prune?, dryRun?}
GET    /api/deploy/history                every deploy started from this editor
GET    /api/deploy/revisions?account=&bucket=   the deploys recorded in a bucket
```

The MCP tools `deploy_status`, `deploy_plan`, `deploy_start`, `deploy_history`, `deploy_delete` and
`deploy_cloudflare` do the same for an agent.
