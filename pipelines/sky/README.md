# sky — the datasets the night sky draws

`ingest.mjs` fetches, caches, parses and writes every dataset the game's sky uses — the Yale Bright
Star Catalogue for the stars and the d3-celestial Milky Way isophotes — into
`apps/game/public/assets/sky/`, records where each came from, and checks each result against
something true independently of the parser.

```bash
node pipelines/sky/ingest.mjs                 # everything missing or stale
node pipelines/sky/ingest.mjs --only stars    # one source
node pipelines/sky/ingest.mjs --refresh       # re-fetch even if cached
node pipelines/sky/ingest.mjs --verify        # check the built assets, fetch nothing
node pipelines/sky/ingest.mjs --prove         # the checks, against deliberately broken input
```

Downloads are cached under `ext/sky-cache`. Adding a dataset is a new entry in `SOURCES`, not a new
script. The datasets' licences are credited in the game's attribution panel and in
[CREDITS.md](../../CREDITS.md).
