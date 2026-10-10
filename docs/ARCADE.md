# The arcade dependency

Three packages piedmont builds on live in [siomporas-arcade](https://github.com/hotspoons/siomporas-arcade),
because the arcade's other games use them too:

| Package | What piedmont uses it for |
|---|---|
| `@apex/engine` | the renderer setup, presentation styles, input, menus, maths, the geodetic frame (`geo/wgs84.ts`), physics (Rapier), the dev bridge Vite plugin |
| `@apex/enginesim` | the engine sound: engine-sim as a Web Audio node, and its committed wasm |
| `@apex/stunt-pieces` | loops, corkscrews and banked turns as data, stood on real roads by the game's stunts |

They keep their `@apex/*` names (they are the arcade's) and are consumed exactly as the arcade's own
games consume them: as **TypeScript source**, through `"exports": {"./*": "./src/*.ts"}`. No build
step, no registry, no token.

## How they get here

[`arcade.json`](../arcade.json) pins them:

```json
{ "repo": "https://github.com/hotspoons/siomporas-arcade.git", "ref": "<full sha>", "packages": ["engine", "enginesim", "stunt-pieces"] }
```

`npm run setup` ([`scripts/setup.mjs`](../scripts/setup.mjs)) makes `vendor/arcade` (gitignored) a
link to one of two places:

1. **`ext/siomporas-arcade`, if it exists** — a checkout of the arcade you made yourself, to edit both
   repositories at once. `vendor/arcade` points at it, so an edit to
   `ext/siomporas-arcade/packages/engine/src/...` is in piedmont's dev server on the next reload, and
   in `tsc -b` and `vitest` on the next run, with no reinstall.
2. **otherwise `.cache/arcade/<ref>`** — the pinned ref, shallow-fetched once with a sparse checkout
   (just the three packages and the `tsconfig.base.json` they extend; about 2.5 MB).

The root `package.json` lists `vendor/arcade/packages/{engine,enginesim,stunt-pieces}` as npm
workspaces, so `node_modules/@apex/*` link to them and `tsc -b`, vitest and Vite resolve them as in
the arcade. Because workspaces must exist before npm resolves the tree, setup runs `npm install`
itself, and a plain `npm install` on a fresh clone stops in its `preinstall` hook
(`setup.mjs --check`) with an instruction to run setup. CI runs
`node scripts/setup.mjs --ci --no-gaussworks --no-python` (which ends in `npm ci`).

Setup prints which source it linked. To switch, add or remove `ext/siomporas-arcade` and run
`npm run setup` again; `--fetch` forces the pinned ref even when the checkout exists.

### Two copies of three

If `ext/siomporas-arcade` has a `node_modules` of its own (you ran `npm install` in the arcade), the
engine's imports resolve there first and `three` could load twice. The game's Vite config dedupes
`three`, `postprocessing` and Rapier for the browser; setup warns, and if `tsc` reports two
incompatible `@types/three`, delete that `node_modules`.

## Moving the pin

```bash
npm run arcade:bump <sha|tag|branch>   # resolves to a full sha and writes arcade.json
npm run setup                          # fetch and link it
npx tsc -b && npx vitest run           # does piedmont still build against it?
```

`arcade:bump` resolves a branch or tag to the commit it names *now* — a pin that moves by itself is
not a pin. A short sha needs `ext/siomporas-arcade` to expand it.

The arcade side of the contract (docs/piedmont/SPLIT.md there): it tags the commit piedmont pins
(`engine-vYYYY.MM.DD`), keeps the packages' public surface stable across tags and notes breaking
engine changes in a changelog.

## In the images

`docker build` must not depend on a laptop's `ext/`: the world editor's Dockerfile has its own
`arcade` stage that runs `setup.mjs --copy /arcade`, which fetches the pinned ref and copies the
packages out as plain files into `vendor/arcade` for `npm ci`.

## gaussworks

The splat trainer, [hotspoons/gaussworks](https://github.com/hotspoons/gaussworks), stays its own
repository. `npm run setup` clones it into `ext/gaussworks` when absent, so it is at hand to read
and edit; piedmont runs it by image (the world editor's splat runs), not by import.
