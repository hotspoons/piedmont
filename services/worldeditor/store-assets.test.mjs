// Store.publicFile: `/assets/<file>` and `/surfaces/<file>` on the volume, the shipped kit's
// override contract.
//
// The models and surface textures the build ships live in the app image; the volume is where an
// operator drops a replacement. This resolver is the traversal guard for that route, so it gets
// its own test beside the other store unit.
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { Store } from './store.mjs'

test('publicFile resolves the override roots and refuses traversal and other paths', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'store-assets-'))
  try {
    const store = new Store(root)
    await store.init()

    assert.equal(store.publicFile('/assets/barn-01.glb'), path.join(root, 'assets', 'barn-01.glb'))
    assert.equal(store.publicFile('/assets/surfaces/x.json'), path.join(root, 'assets', 'surfaces', 'x.json'))
    assert.equal(store.publicFile('/surfaces/asphalt_new/albedo.jpg'), path.join(root, 'surfaces', 'asphalt_new', 'albedo.jpg'))

    // a traversal cannot escape, spelled plainly or percent-encoded
    assert.equal(store.publicFile('/assets/../sites/acceptance-crofton/manifest.json'), null)
    assert.equal(store.publicFile('/assets/..%2Fsites%2Facceptance-crofton'), null)
    assert.equal(store.publicFile('/assets/a/../../secrets'), null)

    // anything outside the override roots is the app's business, not the volume's
    assert.equal(store.publicFile('/index.html'), null)
    assert.equal(store.publicFile('/basis/ktx2.wasm'), null)
    assert.equal(store.publicFile('/assets'), null)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('the volume assets override the shipped catalog, and only when present', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'store-assets-'))
  const seed = await mkdtemp(path.join(tmpdir(), 'store-seed-'))
  try {
    const store = new Store(root)
    await store.init()
    store.catalogSeed = path.join(seed, 'catalog.json')
    await writeFile(store.catalogSeed, JSON.stringify({ assets: [{ id: 'barn-01', glb: 'assets/barn-01.glb' }] }))

    // nothing on the volume: the seed is served
    assert.deepEqual((await store.catalog()).assets.map((a) => a.id), ['barn-01'])

    // a volume catalog wins
    await mkdir(path.join(root, 'assets'), { recursive: true })
    await writeFile(path.join(root, 'assets', 'catalog.json'), JSON.stringify({ assets: [{ id: 'custom-01', glb: 'assets/custom-01.glb' }] }))
    assert.deepEqual((await store.catalog()).assets.map((a) => a.id), ['custom-01'])
  } finally {
    await rm(root, { recursive: true, force: true })
    await rm(seed, { recursive: true, force: true })
  }
})
