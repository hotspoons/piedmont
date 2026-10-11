# Traffic, levels and the game layer

Everything that turns a drawn world into a game: the simulation (traffic, actors), levels and
their programs, races, game mode and its menus, the finish screen, and audio. All of it lives in
`apps/game/src/game/`.

## The simulation: one ECS world

`game/actors/actorworld.ts` is one **bitECS** world on a fixed 20 ms step, separate from the scene:
it is about what things are and do, and runs whether or not anything is drawn, so a probe can step
ten thousand vehicles headlessly. The renderer calls `tick(realSeconds)` and it runs as many steps
as that buys, capped. Programs reach it as `api.world` and `api.actors`.

## Traffic

| Module | Role |
|---|---|
| `game/world/zones.ts` | traffic zones: a polygon with a density (0 empty … 1 stationary, converted to vehicles per km per lane by `vehiclesPerKm`), an optional maximum to roll between, an obey rate and a speed factor. Separate from adjustment areas on purpose: a zone is a fact about a game, an adjustment about the world |
| `game/traffic/trafficplan.ts` | pure: road chains + zones in, car placements out. Even spacing (1000 / density metres), jittered, not a Poisson draw, which clumps at low density and never packs at high |
| `game/traffic/traffic.ts` | the driving: the **Intelligent Driver Model** (Treiber, Hennecke & Helbing) with a personality per driver drawn from a seed (desired speed, headway, compliance; 97% obey lights by default). A red light is a stationary virtual car at the stop line, so queues, shock waves and green-light platoons emerge |
| `game/traffic/signals-ecs.ts` | signal controllers as entities: a fixed cycle by default; minimum green, clearance intervals, actuation and coordination are the opt-in vocabulary |
| `game/traffic/trafficsets.ts` | which vehicle builds a jam is made of, and in what shares |
| `game/traffic/trafficlayer.ts` | the glue: per car an ECS entity (Transform, Vehicle, OnRoad, Driver), a position along a chain, a cloned model fitted to its chassis, and a kinematic body moved each frame so the player can hit it |

The ECS frame is the site's (x east, y north, metres, yaw anticlockwise from east); three's is
x east, y up, z south, so every sync line has a `−y`. Hits are graded (`api.traffic.hit`,
`onHit`), and a blast wakes every car in reach first so it can throw them. Far cars draw a
simplified model and are detached from the scene graph; model programs compile in the background
as they load (`TrafficLayer.warm`).

A level runs traffic when its `simulations` contains `{ kind: "traffic", set?, density?, max?, seed?, blind? }`
(blind drivers brake for nobody: a pile-up). The `TRAFFIC_DENSITY` knob runs traffic in the plain
viewer.

## Levels

A level document is defined and validated by `services/worldeditor/levels.mjs` (`LEVEL_KEYS`, `validate`)
and loaded by `game/world/level.ts`. Its keys: `id`, `world`, `name`, `mode`, `start` (a point id),
`player` (`{ vehicle, profile }`), `recoverRepairs`, `program`, `preset`, `defaults` (time,
weather, season), `order`, `home`, `launch`, `next`, `onFail`, `placements`, `splats`,
`simulations`, `scenario`. An unknown key is a warning, not an error.

A level **sets things on a world that is already loaded**; naming a different world is an error,
not a silent reload. The look resolves in three layers: the world's `tuning.json`, then the level's
preset, then its `defaults`. The validator's vocabulary for scenarios (facts a condition may read,
actions an event may take) is served by `GET /api/levels`, so the Stage panel shows exactly what the
validator accepts. `level_vocab` over MCP gives the same and more.

## Programs

A program is TypeScript under the editor's `programs/` (stored on the volume, not in this
repository), default-exporting `defineGame({ setup, update, teardown, finishScreen })`. The API is
`GameApi` in `game/session/program.ts`; the user-facing tour is
[docs/guide/programs.md](../guide/programs.md).

- **Compiling:** the Program pane compiles in a TypeScript worker; the world editor serves compiled
  JavaScript (`?js=1`), and a Cloudflare deploy ships it precompiled under `api/programs/`.
- **Loading** (`game/session/programload.ts`): every bare specifier the API allows
  (`@apex/program`, `@apex/races`, `@apex/zones`, `@apex/actors`, bitecs...) is rewritten to a blob
  module that re-exports the page's live module, so a program sees the same ECS the game runs, not
  a second copy.
- **Declarations** for the editor's type checking and the MCP `program_api` tool are generated:
  `node scripts/gen-program-types.mjs` writes `apps/game/src/generated/program-types.json`. Run it
  after changing the API, or the editor reports the new method as missing.
- **Dry run:** the same loader, against a stub host, for five seconds; every call is inert where
  there is no host (no audio, no screen), so a program can be checked headlessly.
- Every restriction a program makes (`api.ui.*`) ends when it stops (`policy.reset()`).

## Races and stunts

`game/race/races.ts` holds the model: gates as oriented lines crossed from right to left of
`a→b`, ordered into circuits (laps) and stages, with penalties and wrong-way detection;
`racerun.ts` tracks a run and `raceworld.ts` draws the rings and gates. A race starts when the player
drives into its ring. Stunt fixtures (`game/stunt/`) import the piece definitions from
`@apex/stunt-pieces` and add the one thing they lack: standing them anywhere, at any angle, on real
ground, linked back to the road by Bézier ramps, with the road under them hidden.

## Game mode

The page has two interfaces over one settings store, one input map and one policy
(`game/session/gamepolicy.ts`):

- **Which view:** `ui=game|dev` in the address, else the player's remembered choice, else a
  production build is a game and the dev server is a workbench (`resolveUiMode`).
- **The Escape menu** (`ui/gamemenu.ts`) is built on the engine's `MenuStack`; screens are data,
  and `main.ts` implements the host over the viewer's real state. The menu pauses the car, the
  traffic, the physics and the program's clock; the renderer and sky keep going.
- **Settings** (`game/session/gamesettings.ts`): audio levels, key and pad bindings by action
  (`ACTIONS`, `DEFAULT_KEYS`, `DEFAULT_PAD`), gamepad, rumble, units, the view, physics. Setting ids
  that a program may hide are a closed list (`SETTING_TABS`, `SETTING_CONTROLS`), so a typo is an
  error, not a control that quietly stays.
- **Input** (`game/move/gameinput.ts`): hotkeys arrive by DOM event through `input.actionOf(code)`,
  so rebinding changes what the switch does; pedals, sticks and menu edges are polled once a frame.
- **Transport** (`game/move/transport.ts`): drive, walk, walk-third, fly and the craft
  (helicopter, omnicopter, ornithopter, plane, jet, UFO) are controllers over one camera and world.

**The finish screen** (`ui/finishscreen.ts`) holds the world still, draws the last frame once into
a small blurred texture, and then renders only that quad and a turntable of the car as it is (paint,
dents) or a stand-in figure. Its shader programs compile with `compileAsync` before the swap, so
opening it is not a hitch. `probes/finish.mjs` checks it end to end.

From a console or the bridge, `piedmont.chrome` (mode, policy, settings, input, menu, HUD, pause,
teleport) and `piedmont.finish` expose all of this.

## Audio

- **The engine sound** is `@apex/enginesim` (engine-sim as a Web Audio node) on its own bus:
  `ENGINE_MASTER` × the player's master × engine volume.
- **Effects** (`game/audio/sfx.ts`): one `AudioContext` made on the first user gesture, one bus,
  placed one-shots with equal-power panners, at most 28 voices. The player's mute is combined with
  the tab-hidden mute, never replaced by it.
- **The bank** (`apps/game/public/sounds/`, built by `pipelines/sounds/build.py` from CC0 sources
  plus the project's own tyre recordings) is organised by **slot**, named for what the game wants to
  say (`tire.squeal.loop`, `crash.heavy`, `gun.fire`...); `SOUND_SLOTS` in
  `game/audio/soundbank.ts`, and a test checks the shipped bank has every one.
- **Which clip:** `SoundBank.resolve(slot, scopes)` walks the thing's own document (a vehicle's or
  actor's `sounds`), then the world's overrides (`api.audio.override`), then the bank; the first
  scope that mentions a slot wins, an empty list meaning silence. An entry is a bank clip, another
  `slot:`, an `asset:<id>/<file>` upload, or a URL.
- Not wired yet: `crash.soft` and `gun.hit.glass` have clips and no trigger.

## Further reading

[specs/GAME-MODE.md](specs/GAME-MODE.md), [specs/SOUNDS.md](specs/SOUNDS.md),
[specs/PLAN-RACES-TRAFFIC.md](specs/PLAN-RACES-TRAFFIC.md),
[specs/PLAN-TRAFFIC-AND-RAGE.md](specs/PLAN-TRAFFIC-AND-RAGE.md),
[specs/PLAN-GAME-PIPELINE.md](specs/PLAN-GAME-PIPELINE.md),
[specs/PLAN-VEHICLES-ACTORS.md](specs/PLAN-VEHICLES-ACTORS.md).
