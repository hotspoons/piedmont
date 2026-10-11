# The editor

The world editor (`/world.html`) is where a world becomes a game. Its top bar is the pipeline, left
to right, and each mode has a number key:

| Key | Mode | What it is for |
|---|---|---|
| 1 | **World** | find a place, draw it, bake it ([Creating worlds](worlds.md)) |
| 2 | **Place** | dress a baked world: corrections, props, traffic, stunts, points, races, textures |
| 3 | **Stage** | levels: a world with a car, conditions, traffic and something to do |
| 4 | **Assets** | the library of models, materials, vehicles, actors, weapons, sounds and building textures |
| 5 | **Program** | a level's game logic in TypeScript ([Writing a game program](programs.md)) |
| 6 | **Shell** | a command line over the editor's documents |
| 7 | **Splats** | captured 360° video turned into gaussian-splat scenery (needs GPUs) |
| 8 | **Deploy** | publish worlds to Cloudflare ([Deploying to Cloudflare](cloudflare.md)) |

The world picker at the left of the bar selects the world every mode works on. The gear button
opens **Settings**; the menu button opens the drawer, with **Settings** and **OSM data**. An
"unsaved" mark in the bar names anything not yet saved.

Everything you make is stored on the install's data volume, beside the baked world, and can be
committed to git from Settings (below).

## Place: dressing a world

Place mode is a 3D view of the baked world from above, with its own seven modes along the left
rail. The same tool is available on its own page at `/editor.html#<world>`.

| Key | Place mode | What you make | Saved as |
|---|---|---|---|
| 1 | **Areas** | polygons that correct the bake: tree height and density, grass, ground height, road surface, tree species, road markings, crops | `adjustments.json` |
| 2 | **Place** | props from the library, placed, rotated and scaled; the **Grow** tab generates them from the bake's buildings and points of interest | `placements.json` |
| 3 | **Structures** | intervals along the road: a bridge over it, a stretch to flatten, a detection to ignore | `structures.json` |
| 4 | **Traffic** | traffic zones: a polygon painted with a density, from free-flowing green to jammed maroon | `zones.json` |
| 5 | **Stunts** | loops, corkscrews, banked turns and jumps stood on the road, linked back to it at both ends | `stunts.json` |
| 6 | **Points** | named places: the world's **home**, level **start** and **finish**, **checkpoints**, **spots**; the **Courses** tab lays out race gates | `points.json`, `courses.json` |
| 7 | **World** | the world's textures: road surface by class, mown and rough grass, a pool of building walls and roofs | `surfaces.json` |

Every mode's things stay visible in every other mode; the active mode's are drawn bolder and win
a click. Clicking the same spot again picks the next thing under it.

**Save** with `Ctrl+S`. **Preview** (`V`) saves, rebuilds the world and shows it from the driver's
seat in a window: W/S/A/D drive, Space handbrake, Tab fly, Esc close.

**Moving around:** drag to grab the ground, the wheel zooms toward the cursor, right-drag zooms
about a point, middle-drag or Shift+drag orbits. W/A/S/D or the arrows slide, Q/E turn, R/F rise
and drop, `T` frames the whole world, `C` flies to the selection, Home points north.

Some details per mode:

- **Areas:** `N` starts a polygon; click to add points; click the first point or press Enter to
  close. Every setting in an area defaults to "as baked"; set only what is wrong. Where areas
  overlap, the smaller one wins.
- **Place:** pick a library item in the palette, then click the ground. Drag to move, `Q`/`E` or
  Shift+wheel to rotate, `[` and `]` to scale, Delete to remove. Only items marked *placeable in
  worlds* in Assets appear in the palette.
- **Grow:** `G` fills the world with placements chosen from the bake's buildings, land use and
  points of interest. Anything you touch afterwards is locked, and anything you delete stays
  deleted the next time you grow.
- **Structures:** `N`, then click the road twice (start and end). A bridge uses a library model of
  category `bridge`, spans the road at the clearance you set, and stands on abutments.
- **Traffic zones** set density from 0 (empty) to 1 (stationary); a zone can also have a maximum
  (the level rolls between the two each time it loads), how many drivers obey red lights, and a
  speed factor. Zones do nothing until a level runs traffic (Stage, below).
- **Points:** pick a kind, then click the ground; the point takes the heading of the nearest road.
  Each point says how you are there: driving, walking or flying.
- **Courses:** click the road to drop a gate across it at the road's width; gates show which way
  they are crossed, and a button turns one round. A course is a **circuit** (laps) or a **stage**
  (point to point). Driving into its start ring in the game starts the race.

## Stage: levels

A **level** is a baked world dressed and given something to do. **New level**, then:

- **The level:** its id, the world it uses, the mode you start in (drive, fly or walk) and the
  point it **starts at** (a point from the world's Points tab; the world's home if none).
- **Where it sits in the game:** the **order** among the world's stages, whether it is the **home
  stage**, whether a deployed game **launches into** it, and which level comes **after a win** and
  **after a loss**.
- **What you drive:** a vehicle from the library (or the built-in car) and its **handling**
  profile: `stunts`, `taxi`, `street`, `rush` or `sim`.
- **What it opens like:** time of day, weather and season.
- **Running in it:** **Add traffic** adds a traffic simulation (rush-hour density, with a seed so
  every run is the same).
- **Something to do:** **Add a scenario** writes simple rules without code: when a condition holds
  (for example `score >= 100`), show a message or take an action. The panel lists the conditions
  and actions the server accepts, and refuses anything else with the reason.

The panel validates as you type: errors block saving, warnings do not. **Play** opens the level in
the game.

Two level settings have no control in the Stage panel yet: the **program** (the TypeScript game
logic) and the traffic simulation's **set** (which vehicles the traffic is made of). Set them in
the level's JSON, either in Shell mode (`levels/<id>.json`) or with the MCP `level_save` tool:

```json
{
  "id": "rush-hour",
  "world": "my-world",
  "program": "rush-hour.ts",
  "simulations": [{ "kind": "traffic", "set": "commuters", "density": "rush", "seed": 42 }]
}
```

## Assets: the library

The Assets mode fills the screen with the library, in tabs:

| Tab | What it holds |
|---|---|
| **Catalog** | every model: generate one with AI (*describe, draw, pick a view, mesh*), or **Import a model** (a `.glb`). Set its class, size and orientation, and tick **placeable in worlds** to put it in Place mode's palette |
| **Materials** | tileable textures (albedo, normal, roughness) at a real-world scale, generated or uploaded; new ones arrive as a draft you accept or discard |
| **Service** | which AI models the asset service can reach, and syncing the catalog to a bucket |
| **Blender** | a headless Blender the editor runs for rigging: every render and export it made |
| **Vehicles** | a vehicle build: a model plus its handling, engine and gearing, engine sound, sounds, and weapons |
| **Actors** | characters and creatures: a model plus their configuration |
| **Weapons** | weapon builds a vehicle or actor can carry |
| **Fixtures** | which model the selected world uses for each kind of built-in object: signs, signals, poles, gates, markers |
| **Sounds** | the sound bank, slot by slot (tyres, crashes, explosions, guns), with a sound board for trimming and saving clips |
| **Buildings** | which materials each class of building (house, apartments, commercial, tower) draws its walls and roofs from |

AI generation needs the asset service and the model endpoints: see
[Generating assets](assets-ai.md).

**Sounds per vehicle or actor:** a vehicle's **Sounds** tab (and an actor's Sounds group) lists every
sound slot with what it resolves to. **Edit** a slot to pick bank clips, alias another slot, paste a
URL, upload a file, or make it silent. **Board** opens the clip in the sound board.

**Traffic sets** (which vehicle builds a jam is made of, and in what shares) are edited in the
**Traffic** tab of the place editor's asset library (`/editor.html`, drawer → **Assets**) or with
the MCP `traffic_set_*` tools; the world editor's Assets mode does not show that tab.

## Program

A level's game logic, in TypeScript, edited with type checking and completion against the real
game API. See [Writing a game program](programs.md).

## Shell

A real command line (coreutils, Python and JavaScript, compiled to WebAssembly) that runs inside the
browser tab. The editor's documents appear as files:

```
worlds/<slug>.json          world definitions
levels/<id>.json            levels
programs/<path>             programs
sites/<slug>/tuning.json    per-world setting overrides, and presets.json beside it
out/                        scratch space; nothing here is saved
```

Writing one of those files saves it to the editor immediately; there is no undo. The baked rasters
are not in the shell.

## Splats

Turns 360° video of a place into gaussian-splat scenery that the game blends into the baked world
where it was captured. Upload a capture, split it into chapters, and start a training run. Training
needs GPUs and the gaussworks training image; on Docker only the single-host batch mode exists.

## Settings

- **Git and LFS:** the data volume as a git repository. By default it commits what people made
  (worlds, levels, programs, presets, tuning and the asset library), not the bake output, which is
  opt-in and goes through Git LFS. Set a remote and a credential (stored on the server, never shown
  again), commit, push and pull.
- **Agent:** connect an AI agent platform, and the MCP connection details for outside agents
  ([MCP guide](mcp.md)).
- **Appearance:** dark or light theme.
- **Services:** what the editor can reach right now, and every service setting (asset service,
  Overpass, place search, bake image, the Docker runner, splats, Blender). A value set here
  overrides the environment.
