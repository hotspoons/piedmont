# Playing a world

A baked world plays in any modern desktop browser with WebGL 2. Open it by its address:

```
https://<your install>/#<world>
https://<your install>/#<world>?level=<level-id>
```

From the world editor, the globe button beside the world picker (or **Open in the viewer** in
**World → Bake**) opens the selected world. A world deployed to Cloudflare opens on its launch
level ([Deploying to Cloudflare](cloudflare.md)).

## Two views: game and developer

The same page has two interfaces:

- **Game view**: no top bar; a dashboard, the current objective and a waypoint arrow in the lower
  left; settings in the **Escape** menu. A deployed world, or any production build, opens this way.
- **Developer view**: a top bar with a world picker, place search, a readout and buttons, plus the
  F6 tuning panel. The development server opens this way.

Switch with **Developer view** in the Escape menu, or force one in the address with `?ui=game` or
`?ui=dev`. The choice is remembered. A level's program can hide the developer view; `?ui=dev` in
the address still gets you there.

## The Escape menu

Escape pauses the world (the car, the traffic, the physics and the level's clock stop) and opens
the menu:

- **Resume**, **Restart** (back to the start point, the level from the beginning), **Abandon the
  race** while one is on.
- **Drive / Leave the car**, **Physics** (the world's default, on or off; applies when the world
  next loads), **Mute**, **Full screen**.
- **Levels**: the world's other stages, when it has more than one.
- **Settings**: Display (season, style, relief, trees, weather, detail, anti-aliasing, performance
  stats, units, theme), Layers (show or hide each part of the world), Audio (master, engine and
  interface volume) and Controls (below).
- **Tuning panel** (F6): every live setting of the renderer and the simulation, for when you want
  to tinker.

Arrows or WASD move through the menu, Enter, Space or the A button select, Backspace or B go back,
and Start pauses.

## Controls

These are the defaults. Every one can be rebound, keyboard and gamepad separately, in **Settings →
Controls** (tap a key to set it, hold it to add a second).

| Action | Keyboard | Gamepad |
|---|---|---|
| Accelerate | W, ↑ | right trigger |
| Brake / reverse | S, ↓ | left trigger |
| Steer | A / D, ← / → | left stick |
| Handbrake | Left Shift | A |
| Recover the car (put it back on the road) | R | Y |
| Headlights | L | X |
| Chase / cockpit view | C | View (left centre button) |
| Fire a missile | Left Ctrl | RB |
| Machine gun (hold) | Space | LB |
| Full-screen map | N | left stick click |
| Previous / next objective | Q / E | D-pad ◀ / ▶ |
| Hide the interface | M | |
| Get in / out of the car | Tab | |
| Next craft (Shift: previous) | V | |
| On foot / fly | B | |
| Pause menu | Escape | Start |

The right stick looks around the car. The gamepad's B button is "back" in menus and is left free
while driving.

**The map.** The inset map shows where you are and the next waypoint. Double-click it to drop the
car on the nearest road at that spot, facing along it (a level can turn this off). The full-screen
map is off until you turn on **Expand the map** in Settings → Controls; **Map follows heading**
keeps ahead at the top.

**Out of the car** you fly a free camera over the world. A level decides which ways of getting
about are allowed; some levels put you on foot or in an aircraft instead.

**Gamepads** use the standard layout, including pads a browser reports in a non-standard way. Turn
the pad on or off and set **Rumble** strength in Settings → Controls. Rumble responds to bumps,
grass and your own collisions.

**Phones and tablets** get a lighter build automatically (less terrain detail, smaller imagery,
fewer nearby trees), an on-screen move pad and driving buttons. Add `?lite` to the address to get
the light build on a desktop.

## Levels, races and the finish screen

A **level** is a world with something to do: a car to drive, a time of day, traffic, objectives,
races. The objective and score are in the lower-left widget. Driving into a race's start ring
starts it; the gates, laps and time appear while it runs.

When a level ends you get a finish screen: your car on a turntable, the result, the winnings or
score counting up with its breakdown, and the buttons **Next stage** (when the level names one),
**Restart** and **Exit to menu**.

## Address options

Options go after the world, inside the hash, as `#<world>?key=value&flag`:

| Option | Effect |
|---|---|
| `level=<id>` | open on a level |
| `season=winter`, `spring`, `summer`, `autumn` | the season |
| `style=realistic`, `fantasy` | the visual style |
| `ui=game`, `ui=dev` | the interface (above) |
| `phys=0`, `phys=1` | physics off or on for this load |
| `lite` | the light build |
| `aa=0`, `aa=1` | anti-aliasing off or MSAA for this load |

## If it runs slowly

- **Settings → Display → Detail** sets how much geometry is drawn: start at Low and raise it.
- **Performance stats** (or F7) shows the frame rate, frame-time percentiles, draw calls and memory.
- Layers you do not need (grass, trees, buildings) can be hidden in **Settings → Layers**.
