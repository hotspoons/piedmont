# Working in this repository

This file is for agents (and people) working in piedmont, and above all for running long tests
against the game. Start with [README.md](README.md) (quick start) and
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) (what lives where). The design documents are under
[docs/](docs/); the game's own README is [apps/game/README.md](apps/game/README.md).

## Ground rules

- **`npm run setup` first** on a fresh clone. The arcade's engine packages are npm workspaces linked
  in by setup (`vendor/arcade`), so `npm install` alone fails and says so. See
  [docs/ARCADE.md](docs/ARCADE.md).
- **Name paths when you commit.** Never `git add -A`; check `git status` for anything large or secret
  first (`.mcp.json`, kube configs, tokens and R2/Cloudflare credentials never go in).
- **The names check is strict.** `scripts/check-names.mjs` fails on the project's old name anywhere
  (docs/ORIGIN.md); `scripts/check-pull-policy.mjs` fails on any image pull policy but `Always`.
  Both run in `npx vitest run`.
- **Gate claims on exit status.** `npx tsc -b`, `npx vitest run` and the bake's
  `python -m unittest discover -s tests` (from `bake/`) are the gates; read their summaries.
- **Big data stays out of git.** `$PIEDMONT_DATA` (default `data/`) holds the bake's caches and sites.

## Extended testing of the game

The agent box has no GPU. Frame-time numbers come from a real browser on a real card, driven over
the dev bridge (`scripts/bridge.mjs`; `APEX_BRIDGE=apex-dev just remote` serves the app on `:5186`
against a deployed world editor, then `APEX_ORIGIN=http://localhost:5186 node scripts/bridge.mjs
--file probe.js`). Inside a probe the app is `apex` (the bridge context) and `window.piedmont` (the
console surface).

**Turn the screen wake lock on before any extended test.** A soak run, a profile window, a leak
watch — all of it stops the moment the display sleeps: the tab is hidden, `requestAnimationFrame`
stops, and every number after that is a tab doing nothing. The knob is `SCREEN_WAKE_LOCK` (F6 →
view → *long sessions and the test rig*). From a probe:

```js
if (!piedmont.tune.get('SCREEN_WAKE_LOCK')) piedmont.tune.set('SCREEN_WAKE_LOCK', 1)
apex.wakeLock() // { wanted, held, supported, error } — `held` must be true, or the test is not safe
```

It persists per browser like every other knob, and the browser releases it whenever the tab is
hidden; the page asks again when the tab comes back. Leave it on for the whole session and turn it
off when the work is done (`piedmont.tune.set('SCREEN_WAKE_LOCK', 0)`).

**The test rig** drives the world's spine on its own and fires at the traffic, so a worst case can
be repeated exactly: `apex.rig.start({ speed: 28, fireEvery: 0.5, lane: 0 })`, `apex.rig.stats()`,
`apex.rig.stop()`. It drives whichever way the traffic beside it goes, keeps its lane with the same
`CarInput` the keys write, and while it is on the player's own car is excluded from missile blasts.
The knobs `RIG_SPEED_MPS`, `RIG_FIRE_EVERY_S`, `RIG_LANE_M` are its defaults. The game must not be
paused (Escape) while it runs.

**Measure, then change.** `apex.perfMeter.read()` is what the performance panel shows (open it with
`apex.perfHud.show(true)`); the JS Self-Profiling API works on the dev server when the bridge is on
(`new Profiler(...)`), and `EXT_disjoint_timer_query_webgl2` gives GPU time per render call. Hold a
change against the same rig run before and after, and report the percentiles, not the average.

**Before a change to the start-up path reaches a live tab**, boot the page headlessly (playwright,
`--use-gl=swiftshader`) and make sure it reaches `window.piedmont.site` with no page errors
(`node scripts/live.mjs` does this). Vite reloads every attached tab the moment the file is saved.
