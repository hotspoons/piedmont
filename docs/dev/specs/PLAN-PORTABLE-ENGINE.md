# A portable engine: one simulation, many targets

**Status:** direction, 2026-10-11. Nothing here is built. This records what Rich asked for and the
shape it implies, so the work that follows is aimed rather than discovered.
**Audience:** whoever carves the simulation out of the browser next.
**Related:** [world scale](PLAN-WORLD-SCALE.md), [frames](../frames.md), [physics](PLAN-PHYSICS.md),
[monoliths](PLAN-MONOLITHS.md), [architecture](../architecture.md), [the arcade dependency](../arcade.md).

Rich, 2026-10-11:

> It is starting as a driving game but will evolve to other dynamics like actors and various modes
> of flying, boating, submarining, etc. The world is projected using geodesics on a spheroid so we
> can scale up to worldscale or larger. Think a lightweight engine for a grand theft auto or
> cyberpunk 2077-style experience in vast arenas with the least common denominator being the
> browser, but we may want to work on lower level stuff, like maybe serving the gaming loop out of
> a wasm with a well-defined host and guest API so you can target non-browser builds, like a Rust
> game host using SDL3 and Vulkan with a wasm host that can run the same engine simulator and
> physics engine as the browser, and provide a common API regardless of target. Would be lovely to
> go faster than TypeScript for the game loop.

And, on the arcade:

> The arcade app will from now on just be a javascript dependency for some stunts and some shared
> library code, that's it.

---

## 1. What the game is becoming

Three claims, and each one moves a different piece of today's design.

**More than driving.** Actors on foot, aircraft, boats and submarines are not four more vehicles.
They are four more *surface regimes* (ground contact, lift and stall, buoyancy and planing, ballast
and depth), and the thing they share is a body, an input seam and a camera. Today `apps/game` is
built around a car on a road band; the parts that are really about *a body in a world* are already
separated (`Vehicle`, `DriveProfile`, `Terrain`, `PhysicsWorld` in the engine), and those are the
parts an actor, a plane and a boat reuse.

**A spheroid, not a site.** [frames.md](../frames.md) already made WGS84 the authority and the baked
site metres a local ENU tangent frame about a geodetic anchor, with `Anchor.delta` and
`deltaRotation` written and tested but **uncalled**. That is exactly the machinery a continuous world
needs: the render stays local (float32 millimetres) and the rebase is a translation *and* a rotation
(~141 m over 60 km if the rotation is dropped). Worldscale is not a new coordinate system — it is
turning on the one that is already there and letting the tile grid move from site-local to the global
quadtree.

**The browser is the floor, not the ceiling.** The same world must run in a tab and, later, in a
native host on a real GPU with no browser in the path. That constraint is what decides where the
simulation lives.

## 2. Where the seam already is

The split this rests on is mostly drawn. What is missing is a *language* seam, not an architectural
one.

- **The engine knows nothing about piedmont** — that is the stated line in
  [arcade.md](../arcade.md). `@apex/engine` holds the renderer setup, the geodesy, the physics, input,
  menus and the loop; everything that knows about a baked world is in `apps/game`.
- **The heavy simulation is already compiled.** Rapier is Rust compiled to wasm
  (`@dimforge/rapier3d-compat`), and engine-sim ships committed wasm in `@apex/enginesim`. The wasm
  boundary is not a new idea here; it is how the two most expensive subsystems already run.
- **One height function, one owner.** "One surface, one height function" (`apps/game/README.md`)
  and the physics `Terrain` built from `site.groundAt` rather than a mesh ([physics](PLAN-PHYSICS.md)
  §2.1) are the same rule: the drawn surface and the simulated surface are one, by construction. A
  native host inherits that rule or it re-introduces the drift the browser already paid to remove.
- **The frame is settled.** GEODETIC → ECEF → local ENU, with the rebase defined. A native renderer
  gets the same frames, the same anchors and the same tile addressing (the global quadtree).

## 3. The proposal: a simulation guest, a platform host

Serve the **game loop** from a compiled core with a language-neutral boundary, and let the host own
everything platform-specific.

```
        guest (one implementation, many builds)
        ┌──────────────────────────────────────────────────────────┐
        │ sim core: fixed-step world, physics, gameplay systems,    │
        │ the coordinate frames, the terrain as a height function   │
        └───────────────┬──────────────────────────────────────────┘
                        │  host/guest ABI (versioned, language-neutral)
        ┌───────────────┴───────────────┬──────────────────────────┐
        │ browser host                  │ native host               │
        │ three.js / WebGL2 / WebGPU    │ Rust + SDL3 + Vulkan      │
        │ WebAudio, gamepad, fetch      │ audio, input, net, files  │
        └───────────────────────────────┴──────────────────────────┘
```

- **Guest = the simulation.** The fixed-step world, the rigid bodies, the terrain, the traffic model,
  the driving/flying/boating controllers, and the authored state they read. Deterministic for a given
  build and input stream — [physics §4](PLAN-PHYSICS.md) already names determinism ("multiplayer
  would") as the reason to care.
- **Host = the platform.** Render, input, audio, network, time, storage, and the world data it feeds
  the guest. The host is where three.js or Vulkan lives, and the only difference between the two
  builds.
- **The boundary is a versioned ABI**, not an `import`. The guest exposes a `step(dt, input) → state`
  surface (commands in, a snapshot out, plus event batches), and the host drives it at a fixed rate
  and interpolates for display. The natural fit is the **WebAssembly Component Model** with WIT for
  the type surface; a hand-rolled C ABI with a struct of views is the fallback if the tooling is not
  ready. Either way the boundary is defined once, in its own file, and versioned.

The test of the design is narrow and can be stated now: **one guest binary, driven by two hosts, that
produces the same trajectory for the same input on both.** That is the physics probes
(`probes/physcar.mjs`) made into a cross-target assertion.

### Why not just keep it in TypeScript

The complaint and the answer are the same sentence: "it would be lovely to go faster than
TypeScript for the game loop." TypeScript is the right language for the renderer, the editors and the
world tooling — a large, GC'd, JIT'd runtime with a browser on the other side of `import`. It is the
wrong *destination* for a fixed-step loop that must run identically in a tab and under
`cargo run`. Compiling the loop to wasm and calling it from both hosts gets one implementation, a
deterministic step, and (Rust's) predictable cost — while the parts that are pleasant in TS stay TS.

## 4. What goes in the guest, in order

Carve the simulation out behind an interface; do not rewrite the game.

1. **Define the ABI first.** `step`, the snapshot, and the event stream, in one versioned file.
   Everything else is an implementation detail behind it. Without this the refactor has no target.
2. **The physics world and the terrain.** `PhysicsWorld` + `Terrain` are already WASM-backed and
   already take the height *function*. Move the owner (`apps/game/src/physics.ts`) behind the ABI
   first: smallest change, largest piece, and it is the piece every dynamic mode reuses.
3. **The bodies and their controllers.** `Vehicle`/`DriveProfile` first (driving, already the
   reference), then actors, then air/water/subsurface as new profiles or new body kinds behind the
   same interface.
4. **The frame and the origin.** Move the ENU anchor and the rebase (`Anchor.delta` /
   `deltaRotation`) into the guest so every host rebases identically, and turn on the global quadtree
   as the tile addressing (frames.md step 5, world scale item 5 "a graph, not a spine").
5. **The host, ported.** Stand up the native host (Rust + SDL3 + Vulkan) against the same guest.
   The browser host becomes a second implementation of the same trait.

Read that against [PLAN-WORLD-SCALE.md](PLAN-WORLD-SCALE.md) and [PLAN-MONOLITHS.md](PLAN-MONOLITHS.md):
the world work (sharding, streaming, residency ceilings, the global tile grid) is what gives the guest
a world to be in; the engine work is what lets the loop run outside a tab. They meet at the frame and
the tile grid, which is why those are on the critical path for both.

## 5. The arcade's new role

The arcade stopped being a deployment: no arcade container images, no arcade releases serving
piedmont. It is now three JavaScript dependencies —

- `@apex/stunt-pieces` — stunts as data,
- `@apex/engine` / `@apex/enginesim` — the shared library code (renderer setup, geodesy, input, menus,
  the bridge, the engine-sound wasm),

consumed as TypeScript source through the pin in `arcade.json`, exactly as [arcade.md](../arcade.md)
describes. Deployments come only from this repository's own images and charts
(`deploy/helm/*`, `deploy/<cluster>/*`). Anything from the arcade that is really *simulation* moves
into the guest over time; anything that is really *platform* stays in the host.

## 6. Open questions, for Rich

1. **The ABI's home and language.** WebAssembly Component Model + WIT (clean types, real tooling) vs a
   C ABI (works everywhere today, more by hand). And does the guest live in this repository, or a new
   one the native host can also depend on?
2. **How much of the world streams in the guest?** The guest needs ground under a body; whether tile
   fetch/decode is the host's job (hand the guest samplers) or the guest's own is a real fork.
3. **The first non-browser target.** A desktop host for real-GPU perf measurement, or the
   deterministic cross-target probe, or both as one thing.
4. **Where the loop splits from the renderer.** One guest step per frame with render interpolation,
   or a guest that owns its own clock and the host that follows?

## 7. What this is not

It is not a rewrite of the game, the bake or the editors. The bake stays Python, the world editor and
asset service stay Node, the editors stay TypeScript. This is about the **runtime loop** — the part
that must run fast, run the same everywhere, and grow from one dynamic to several.
