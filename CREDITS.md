# Credits and third-party licences

This project is released under the [Apache License 2.0](LICENSE), Copyright 2026
Rich Siomporas. What follows is everything in the repository that someone else
made, what it is licensed under, and where it came from. The short version: the
third-party code is MIT, Zlib and Apache-2.0; the art and models are CC0; the
fonts are OFL or Apache-2.0. Nothing here is copyleft and nothing conflicts with
the Apache-2.0 release.

Machine-readable copies of the licence texts ship alongside the files they cover
and are served by the deployed site:

- `apps/game/public/fonts/LICENSES.txt` — the full text of every font licence
- `apps/game/public/sounds/CREDITS.md` — the provenance of every sound clip

The shared engine packages (`@apex/engine`, `@apex/enginesim`, `@apex/stunt-pieces`) come from
[siomporas-arcade](https://github.com/hotspoons/siomporas-arcade) under the same Apache-2.0 licence
and carry their own credits there.

## Software dependencies

A short list of third-party code reaches the browser. Everything else is build
tooling that never leaves this machine.

| Shipped to the browser | Licence | |
|---|---|---|
| [three.js](https://threejs.org) | MIT | the renderer, and most of the engine's maths |
| [postprocessing](https://github.com/pmndrs/postprocessing) | Zlib | bloom, SMAA and the effect composer behind the modern style |
| [ez-tree](https://github.com/dgreenheck/ez-tree) | MIT | the game's procedural near trees |
| [Heroicons](https://heroicons.com) | MIT | the game's interface icons. The package itself is dev-only; `scripts/heroicons.mjs` inlines the path data of the ~35 icons used into `apps/game/src/ui/icons.ts`, so what ships is that generated file, not the 1,300-icon package |
| [Engine Simulator](https://github.com/ange-yaghi/engine-sim) — with [piranha](https://github.com/ange-yaghi/piranha) and [simple-2d-constraint-solver](https://github.com/ange-yaghi/simple-2d-constraint-solver) | MIT | the engine you hear in the game. Compiled to WebAssembly and shipped as `vendor/arcade/packages/enginesim/wasm/enginesim.wasm` — see below |

| Build-time only | Licence | Reached via |
|---|---|---|
| [Vite](https://vite.dev), [Vitest](https://vitest.dev), [TypeScript](https://www.typescriptlang.org), [Playwright](https://playwright.dev), [ws](https://github.com/websockets/ws) | MIT / Apache-2.0 | direct dev dependencies |
| [oxlint](https://oxc.rs) | MIT | direct dev dependency |
| [Emscripten](https://emscripten.org), [CMake](https://cmake.org), [Flex](https://github.com/westes/flex), [GNU Bison](https://www.gnu.org/software/bison/) | MIT / BSD-3-Clause / GPL-2.0-or-later | only to rebuild the arcade's `vendor/arcade/packages/enginesim/wasm`, which is committed there. Bison is GPL but its **output** carries the [Bison exception](https://www.gnu.org/software/bison/manual/html_node/Conditions.html), so the generated Piranha parser does not become GPL |
| [lightningcss](https://lightningcss.dev) | MPL-2.0 | Vite's CSS minifier |
| [sharp](https://sharp.pixelplumbing.com) and its libvips binaries | Apache-2.0 / LGPL-3.0-or-later | direct dev dependency (the asset pipelines' image arithmetic) |

Two of those carry weak copyleft and neither is a problem. **lightningcss**
(MPL-2.0) is file-level copyleft on its own source; we neither modify nor
redistribute it, and minified CSS is output, not a derivative work.
**libvips** (LGPL-3.0-or-later) arrives as a prebuilt native binary inside a
dev-only dependency used by the asset pipelines and the asset service — it is never linked
into the game, and never present in a deployed bundle.

The built game contains our own code, three.js, postprocessing, ez-tree,
the inlined Heroicons path data, and the engine simulator's WebAssembly module.

### The engine simulator

The game's engine sound is a real combustion simulation rather than a sample
set: [Engine Simulator](https://github.com/ange-yaghi/engine-sim) by
**AngeTheGreat (Ange Yaghi), MIT, Copyright 2022**, compiled to WebAssembly and
driven from an audio worklet. `vendor/arcade/packages/enginesim/README.md` explains how and
why; what matters here is what is in the shipped binary.

`enginesim.wasm` is a single 1.28 MB artifact and everything inside it is MIT,
Copyright 2022 Ange Yaghi:

| Inside the wasm | What it is |
|---|---|
| `engine-sim` core | the simulation and the synthesiser |
| `simple-2d-constraint-solver` | the rigid-body solver underneath it |
| `piranha` | the scripting language the engine definitions are written in |
| `assets/engines/**.mr` | the twenty engine definitions in the picker |
| `assets/es/**` | the Piranha standard library and the impulse-response library (the `.wav` files the exhaust is convolved against) |

Two notes for anyone auditing this. First, we build against
[Open Engine Simulator](https://github.com/zabayone/open-engine-sim), the
community fork, because the original's browser support was never published as
source; the fork is MIT, preserves upstream's copyright notice, and is pinned by
commit in `vendor/arcade/packages/enginesim/scripts/build-wasm.mjs`. Second, `piranha` had no
`LICENSE` file at the commit the fork pins — it was added to that repository
later. The file now present on its default branch is MIT, Copyright 2022 Ange
Yaghi, and GitHub reports the repository as MIT; the same author released the
rest of the project under the same terms at the same time.

Our own code in `vendor/arcade/packages/enginesim` — the C API in `native/`, the worklet, the
gearbox, the bench — is Apache-2.0 like the rest of this repository. We do not
modify upstream's sources: the build fetches them and links against them.

### Water

The game's water shader is our own code, but three of its ideas are ported from
[tuxalin/water-shader](https://github.com/tuxalin/water-shader), **MIT,
Copyright (c) 2017 tuxalin**:

- the summed **Gerstner wave** normal (from GPU Gems 1 ch. 1, the same source
  tuxalin cites), which replaces the earlier scrolling value noise with waves
  that travel along a wind — or, for a stream, along the channel itself;
- **wavelength-dependent colour extinction** through the water column, so depth
  darkens and blues the surface per channel instead of flattening it to one
  albedo;
- **shore foam** placed by water depth behind an animated noisy edge.

No file, texture or shader source from that repository is used verbatim. The
waves are evaluated analytically in `apps/game/src/world/waterShader.ts`,
driven by a per-vertex `(depth, flow direction)` attribute road-band bakes at
build time in `water.ts`, so a stream's ripples travel along its channel. The
MIT notice travels in that file's header and in [NOTICE](NOTICE).

## Models and textures

The game draws its terrain, roads and buildings from public data (credited in the viewer's
attribution panel, `apps/game/src/attribution.ts`: OpenStreetMap under ODbL, Macrostrat CC BY 4.0,
USGS 3DEP, USDA NAIP, LANDFIRE, the Yale Bright Star Catalogue and the Milky Way isophotes from
d3-celestial, BSD 3-clause). Its props, vehicles and materials are generated by the asset pipelines
in `pipelines/` and stored by the asset service, not committed.

## Sounds

The game's effects — `apps/game/public/sounds/` — are cut by
`pipelines/sounds/build.py` from recordings that are all CC0 (public domain
dedication); the cuts are CC0 too. None of them requires attribution and it is
given anyway. The per-file provenance is generated into
`apps/game/public/sounds/CREDITS.md` from `pipelines/sounds/sources.json`.

| source | author | licence |
| --- | --- | --- |
| [Impact Sounds](https://kenney.nl/assets/impact-sounds), [Sci-fi Sounds](https://kenney.nl/assets/sci-fi-sounds) | Kenney | CC0 1.0 |
| [tire squeal #0500](https://bigsoundbank.com/tire-squeal-s0500.html), screeching tires #2368–2371, explosions #1023/#1806–1808, shots #0397/#0437/#0438/#0532 | Joseph Sardin, BigSoundBank | CC0 1.0 (marked per file) |
| [Gunshot sounds](https://opengameart.org/content/gunshot-sounds) | Tabasco | CC0 1.0 |
| [Impacts and guns SFX](https://opengameart.org/content/impactsgunsfx) | Eldritch Grim | CC0 1.0 |

## Fonts

The game bundles latin `woff2` subsets pulled from Google Fonts (the arcade's
`scripts/fetch-fonts.mjs` fetched them). Nothing is hotlinked; no request leaves the browser
for a font, or for anything else.

| Font | Licence | By | In |
|---|---|---|---|
| [IBM Plex Sans](https://fonts.google.com/specimen/IBM+Plex+Sans) | OFL 1.1 | IBM / Mike Abbink, Bold Monday | the game's interface |
| [IBM Plex Mono](https://fonts.google.com/specimen/IBM+Plex+Mono) | OFL 1.1 | IBM / Mike Abbink, Bold Monday | the game's interface |

The OFL's one real condition is that the licence text travel with the font, and
it does — `LICENSES.txt` sits in the same directory as the `woff2` files and is
served with them. No font is sold by itself or renamed.

## Made here

- **All game code**: the game, its editors, the bake, the services and the pipelines.
- **The engine sound** is synthesised (engine-sim, above); the effects are recordings — see
  **Sounds**.
- **Every road surface, sky and terrain texture the game draws** is procedural or derived from the
  public data above, written as shaders and bake steps.
