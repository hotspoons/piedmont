# Physics

Rapier (`@dimforge/rapier3d-compat`), wrapped by the shared engine and bound to a baked world by
the game. The engine's half is generic and tested headlessly; the game's half is small and is
mostly about standing on the same ground the renderer draws.

## The engine's half: `@apex/engine/physics/`

| File | What it is |
|---|---|
| `rapier.ts` | the only importer of Rapier. Lazy: the `-compat` build inlines its wasm (4.3 MB), so a session that never turns physics on never downloads it |
| `layers.ts` | who collides with what, as one table (debris ignores debris and your car; projectiles do not detonate each other) |
| `world.ts` | the world: fixed step, stall policy, render interpolation, and `Impact`, a contact with a point and an impulse |
| `profiles.ts` | the five handling profiles: `stunts`, `taxi`, `street`, `rush`, `sim` |
| `vehicle.ts` | a raycast vehicle and the assist layer that makes the profiles differ; it spends the friction circle itself, because Rapier's vehicle only traction-limits the side force |
| `terrain.ts` | heightfield tiles built from a height **function**, plus static shapes |
| `destruction.ts` | breakables (fixed until hit hard enough), `explode`, a budgeted debris pool |
| `deform.ts` | dents that accumulate and can be repaired |
| `ragdoll.ts` | limbs and joints from a pose |

**The one idea is `yawAssist`**, the arcade-to-simulator axis: 0 means the tyres decide how fast
the car rotates, 1 means the wheel does and the tyres only say how much. With `yawGripLimited`,
asking for more than grip allows makes the car turn *less*, never slide more, which is how the
1990-style `stunts` profile behaves. Read the header of `profiles.ts` before changing a number.

The engine's README (`vendor/arcade/packages/engine/src/physics/README.md` once setup has run)
lists the traps, all of which fail silently: a collider is invisible to queries until the next
`world.step`; nothing may be written from inside a query callback; `addForce` is persistent, not
per-step.

## The game's half

| Module | What |
|---|---|
| `game/world/physics.ts` | the physics world for a site. Its key line is `new Terrain(phys, site.groundAt)`: the wheels stand on the same height function the strip, grass and buildings use |
| `game/vehicle/rapiercar.ts` | the Rapier car behind the same `DrivableCar` interface as the hand-written one, so the camera, HUD, minimap and engine sound cannot tell which is underneath |
| `game/vehicle/car.ts` | the hand-written kinematic car (ported from stuntin): used when physics is off |
| `game/world/worldbodies.ts` | everything beside the road a car can hit (buildings, signs, signals, poles, placed props), catalogued once at load and streamed as colliders by proximity; signs and poles break away |
| `world/overpass.ts` | decks: an elevated carriageway gets a trimesh collider, because a heightfield has one height per column |
| `game/stunt/` | stunt fixtures (loops, corkscrews) as trimesh colliders |
| `game/vehicle/dents.ts` | the engine's deformer hung on whatever was hit; dents are flushed to the GPU once a frame and use the simplified mesh where one exists |
| `game/combat/missiles.ts`, `weapons.ts` | a missile is a point flown by hand with a ray cast over the ground it covered, then `physics.explode`; guns are rays |

**When physics runs.** `PHYS_ENABLED` (on by default) and, in order of precedence: `?phys=0|1` in
the address, the player's choice in the Escape menu (the world's default, on, off), then the world:
a world with stunts or a level with traffic needs physics and turns it on. With physics on, the
Rapier car is the default (`PHYS_CAR`; `?car=` overrides). Physics steps at `PHYS_HZ` (120 by
default).

**The car you drive** is the level's vehicle build (Assets → Vehicles: mass, engine, gearing,
handling profile) or the engine's built-in car. A stunt world with no profile chosen gets `stunts`,
because a loop is held by speed.

**Traffic cars** are kinematic bodies moved each frame, so the player hits a moving car rather than
a ghost; a car that is hit hard becomes dynamic and can be thrown (`traffic.hit`, `onHit`).

## Checking physics without a GPU

The engine's physics tests run headlessly in the arcade. In piedmont, probes exercise it in a
headless browser, for example `probes/physground.mjs` (does the physics ground agree with what is
drawn) and `probes/physcar.mjs`. Remember that `?phys=1` in a probe proves the physics path works,
not that a given world turns physics on by itself.

## Further reading

[specs/PLAN-PHYSICS.md](specs/PLAN-PHYSICS.md) (the design, and where it is deliberately not
physically accurate), [specs/PLAN-VEHICLES-ACTORS.md](specs/PLAN-VEHICLES-ACTORS.md) (vehicle,
actor and weapon documents), [specs/PLAN-EDITOR-IDE.md](specs/PLAN-EDITOR-IDE.md) (physics in the
editor and the program API).
