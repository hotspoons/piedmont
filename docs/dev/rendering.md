# Rendering

three.js on WebGL 2, set up by the shared engine and dressed by `apps/game/src/visuals/` and
`apps/game/src/world/`. This page covers the renderer and depth, the look pipeline, the main
materials, and the traps that cost the most time.

## The renderer and depth

`createRenderer` in `@apex/engine/render/depth.ts` builds the renderer and chooses the depth buffer
(`apps/game/src/main.ts` calls it).

- **Reversed float depth is the default.** three's logarithmic depth buffer writes `gl_FragDepth`
  in every fragment shader, which turns early-Z off renderer-wide: every overdrawn fragment (leaf
  behind leaf, ground under road, car behind car) is shaded in full and then thrown away. A
  reversed float depth buffer (`reversedDepthBuffer` plus `EXT_clip_control`) keeps precision over
  60 km without writing depth in the shader. Measured at Ultra on a desktop GPU: GPU p50 18.4 →
  7.6 ms.
- **Fallback:** where `EXT_clip_control` is missing (old drivers, some software GL) the engine
  keeps the logarithmic path rather than a forward 24-bit buffer that would z-fight across the
  world. `#<world>?depth=log` (or `reversed`, `standard`) forces one for an A/B.
- **Under reversed depth three reverses the whole render list**, `renderOrder` included, so the
  engine installs sort comparators that undo it (otherwise the sky dome draws last and paints over
  the world). Polygon offsets and shadow biases flip sign; a sky shader writing
  `gl_Position = p.xyww` must write the near plane instead under `USE_REVERSED_DEPTH_BUFFER`.
- **Anti-aliasing** (`visuals/render.ts`) is chosen before the context exists, because MSAA is a
  context attribute: `auto`, `msaa`, `fxaa`, `smaa` or `off`, stored per browser, `?aa=0|1` for one
  load.

## The look pipeline

One object, a `SeasonLook`, is what the trees, grass, strips, terrain, horizon, water and sky read:

```
look = style(weather(siteLook(season)))
```

- `visuals/season.ts`: four seasonal palettes (leaf tint and density, grass ramp and height, ground
  tint, sky and fog). Summer is the default and matches the leaf-on NAIP imagery.
- `visuals/weather.ts`: what is falling (instanced particles positioned entirely in the vertex
  shader, wrapped to a world lattice so you drive through rain rather than carrying it), the wet
  road (roughness and darkening on the materials), and what has settled.
- `visuals/style.ts`: `realistic` (the identity) or `fantasy`, applied last, plus colours a season
  never touches (walls, roofs, water, paint) and how much of the air photo survives.

The sky (`visuals/sky.ts`) is a camera-following dome drawn first without depth: gradient, haze,
sun disc and procedural cumulus. At night `visuals/celestial.ts` turns the real star catalogue
(`pipelines/sky`) and the Milky Way for the observer's place and time.

## Materials worth knowing

- **Terrain and roads:** the strip's one ground material blends mown turf, rough grass and the air
  photo by edge distance (`world/strip.ts`); pavement uses stochastic hex tiling over a texture
  array (`visuals/hextile.ts`) with real-scale UVs per surface class. `visuals/roadcover.ts` draws
  the rendered pavement into a top-down mask so ground-level materials (grass, coarse terrain,
  trunks) discard fragments under the asphalt; canopies are deliberately not clipped.
- **Daylight relief** (`visuals/shading.ts`): a high sun washes out normal maps, so the mapped
  normal's lighting difference is turned up; the car gets a clearcoat and a cube probe at the car
  (`visuals/carProbe.ts`) so it reflects the trees around it.
- **Retroreflection** (`visuals/retro.ts`): signs and paint light up in the headlight cone at night.
- **Water** (`world/water.ts`): ribbons along the lidar's low line and flat ponds; the normal is a
  summed Gerstner wave field over world position and time, with foam over falls and rapids, one
  mesh per material. `visuals/waterReflect.ts` renders a planar mirror for large bodies.
- **Buildings** (`world/buildings.ts`, `world/facades.ts`): OSM footprints extruded to the lidar
  height as merged massing; each building draws one wall and one roof material from its class's
  pool (house, apartments, commercial, tower...) by a hash of the building, so it is stable across
  loads and tiles. A class also says how its walls take the light (metalness, roughness) and
  whether a material's glass mask makes panes.
- **Trees and grass:** see [flora.md](flora.md).
- **Splats** (`visuals/splats.ts`): a gaussworks capture placed where it was shot and streamed by
  locality, with a seam that hands over between splat and bake.

## Detail and the tuning panel

**Display ▸ Detail** (`game/session/detail.ts`) is one setting, Low to Ultra, that writes a set of
knobs: model LODs for traffic, the car and props, sun shadows, the hero's lights, reflections, the
near-tree radius, grass and render resolution. It resets the panel's overrides of those knobs.

Every live knob is an `export let` in `apps/game/src/tuning.ts`, grouped into the F6 panel's tabs.
Values persist per browser; **Copy JSON** in the panel gives the numbers back so the defaults in
`tuning.ts` can be edited. A world can override knobs in `sites/<slug>/tuning.json` (only
differences from the code defaults are stored); a level can apply a named preset.

## Traps

- **A custom `ShaderMaterial` must include three's log-depth chunks** (`common`,
  `logdepthbuf_pars_*`, `logdepthbuf_*`), or it silently fails every depth test on the fallback
  path. Fog on a `ShaderMaterial` is fixed at compile time: `scene.fog` must exist before the
  material is built.
- **A backtick inside a GLSL template literal's comment closes the template** and the dev server
  answers 500.
- **`onBeforeCompile` on an `InstancedMesh` must use `instanceMatrix`**, and a material's first use
  compiles a program; warm materials with `renderer.compileAsync` before they are needed, or pool
  them, or a burst of effects costs ~30 ms per new program mid-run.
- **`addUpdateRange` makes an upload partial.** Never clear ranges yourself, and never mix a full
  rewrite with a ranged write in the same frame.
- **Restore viewport and scissor** after rendering a sub-viewport, or the main view draws into a
  corner. `setViewport`/`setScissor` take CSS pixels and measure Y from the bottom.
- **Toggling a layer for measurement:** `updateNear` re-shows layers from `userData.layerOn` every
  frame; flip that flag, not `visible`.

## Further reading

- [performance.md](performance.md): the measurements behind the depth change and the Detail
  levels.
- [specs/STYLES-AND-GAMES.md](specs/STYLES-AND-GAMES.md),
  [specs/SPIKE-water-gerstner.md](specs/SPIKE-water-gerstner.md),
  [specs/PLAN-GRADE-SEPARATION-RENDER.md](specs/PLAN-GRADE-SEPARATION-RENDER.md),
  [specs/PLAN-SPLAT-ROUTES.md](specs/PLAN-SPLAT-ROUTES.md).
