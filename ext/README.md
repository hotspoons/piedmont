# ext/

Other repositories checked out beside this one. Everything here except this file is gitignored.

| Directory | What | How it gets here |
|---|---|---|
| `ext/gaussworks` | the gaussian-splat trainer ([hotspoons/gaussworks](https://github.com/hotspoons/gaussworks)) | `npm run setup` clones it if absent |
| `ext/siomporas-arcade` | the shared engine packages' home ([hotspoons/siomporas-arcade](https://github.com/hotspoons/siomporas-arcade)) | optional: clone it yourself to edit both repos at once |

With `ext/siomporas-arcade` present, `npm run setup` links `vendor/arcade` to it instead of to the
ref pinned in `arcade.json`, so an edit to `ext/siomporas-arcade/packages/engine` shows up in the
dev server without a reinstall. Remove it (and re-run setup) to go back to the pin. See
[docs/ARCADE.md](../docs/ARCADE.md).
