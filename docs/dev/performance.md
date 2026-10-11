# Performance, and how to measure it

The target is a solid 60 fps on a large world with heavy traffic, at rally speed. Claims about
frame time come from a real browser on a real GPU, measured the same way before and after a change.

## Measuring

The agent box has no GPU. Frame times come from a real browser driven over the dev bridge
([DEVELOPING.md](../../DEVELOPING.md#probes-and-the-dev-bridge)):

```bash
APEX_BRIDGE=apex-dev just remote          # the app on :5186 against a deployed world editor
APEX_ORIGIN=http://localhost:5186 node scripts/bridge.mjs --timeout 80000 --file rigrun.js
```

**Before any extended run, turn the screen wake lock on.** The moment the display sleeps the tab is
hidden, `requestAnimationFrame` stops, and every number after that is a tab doing nothing:

```js
if (!piedmont.tune.get('SCREEN_WAKE_LOCK')) piedmont.tune.set('SCREEN_WAKE_LOCK', 1)
apex.wakeLock()   // { wanted, held, supported, error }: `held` must be true
```

**Use the test rig** so a worst case repeats exactly. It drives the world's spine by itself and
fires at the traffic: `apex.rig.start({ speed, fireEvery, lane })`, `apex.rig.stats()`,
`apex.rig.stop()` (defaults in the `RIG_*` knobs). The game must not be paused while it runs; while
it is on, the player's car is a ghost to traffic and props and excluded from blasts.

**What to read:**

| Surface | What it says |
|---|---|
| `apex.perfMeter.read()` | what the performance panel shows (F7, or `apex.perfHud.show(true)`): frame time percentiles, GPU time, draw calls, heap |
| `apex.framePerf` | the last frame's CPU by section: weapons, traffic, game, waypoint, physics, dents, sky, world, map, shading, render; `offFrame` is budgeted work that ran outside the frame callback |
| `piedmont.site.nearPerf` | the `world` section split by layer: trees (plant, near, far, shadow), grass, water, stream, pyramid, LOD, grading |
| `piedmont.physics.stats()` | step and build milliseconds, steps, bodies |
| `piedmont.site.grass.perf` | grass generation and assembly time, tiles made |
| `apex.governor` | the frame governor's scale and the last frame's CPU |
| `apex.sfx.stats()` | the sound bank: what loaded, voices live |

The JS Self-Profiling API (`new Profiler(...)`) works on the dev server when the bridge is on, and
`EXT_disjoint_timer_query_webgl2` gives GPU time per render call. For a 20 ms hitch, the sampling
profiler is too coarse: wrap the frame's calls in a probe and print, for every frame over 14 ms, what
it was made of.

**Rules:**

- Report **percentiles** (p50, p95, p99, frames over budget), never the average.
- Measure at **rally speed** (70 m/s or more). Streaming problems do not show at a cruise.
- Hold a change against **the same rig run** before and after.
- A/B while driving drifts with the scenery: alternate frames (odd with, even without) or stop the
  car. To hide a layer for a measurement, flip `userData.layerOn`, not `visible`, which
  `updateNear` restores every frame.
- A start-up change gets a headless boot check (`node scripts/boot-check.mjs <url>`) before it
  reaches a live tab.

## What has been done, and why

From the DC Beltway rig loop (a 60 km motorway ring with about 4,000 traffic cars, Detail = Low):
frame CPU went from p50 16.6 / p99 43 ms to p50 8.6 / p99 13 ms at 65 to 75 m/s.

1. **A frame governor** (`world/streamscale.ts`): budgeted builders (grass, tree planting, the
   grading pump, buildings) used to spend their whole budget every frame on top of a full frame.
   The frame now measures itself and scales their budgets toward `STREAM_TARGET_MS`.
2. **Work sliced, never whole:** physics heightfield tiles ahead of the car, grass tiles a cell at a
   time, tree index updates incrementally, the tree cache trim bounded per pump.
3. **Direction of travel:** builders rank by a focus `STREAM_LEAD_S` seconds ahead; a unit covering
   the eye always first, one behind counted triple.
4. **Meshes and dents:** simplified meshes compacted (they kept every vertex); a blast dents the
   nearest four cars, not every car in range; dents recompute only the moved vertices' normals.
5. **No mid-run shader compiles:** effect materials pooled, traffic models compiled in the
   background as they load.
6. **Ultra:** full-detail cars only near the camera, and the **reversed depth buffer**, which
   restored early-Z (GPU p50 18.4 → 7.6 ms at Ultra). See [rendering.md](rendering.md).
7. **Bake-side precomputes:** the graded ground raster (a physics tile is a copy, not thousands of
   samples) and KTX2 imagery twins (no JPEG decode or mipmap pass on the frame a tile arrives). See
   [terrain.md](terrain.md).

## What is left

Measured and not yet fixed, roughly by size: water merging a whole look-bucket when a cell arrives;
replanting a kilometre of woods dropping trees from the collision grid one at a time; render CPU from
hundreds of draw calls (traffic is a draw per part per car: instance it); the pyramid's update on a
tile landing; physics steps with thousands of bodies; `traffic.tick` visiting every car each frame.
Memory: nothing streamed is unloaded yet, and several files load whole
([specs/PLAN-MONOLITHS.md](specs/PLAN-MONOLITHS.md)).

The full log, with every measurement and the things that did not help, is
[specs/PERF-RIG.md](specs/PERF-RIG.md).
