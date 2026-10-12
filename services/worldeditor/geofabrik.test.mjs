// The Geofabrik catalogue: where coverage polygons come from, and what happens when Geofabrik does
// not answer. Routing the deployment's own instances must never wait on Germany at boot, and a 200
// with nothing in it is not a catalogue (the silent-success family again).
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { hasOutline } from './coverage.mjs'
import { Geofabrik } from './geofabrik.mjs'

const tmp = () => mkdtemp(path.join(tmpdir(), 'geofabrik-'))
const features = (n) => Array.from({ length: n }, (_, i) => ({ type: 'Feature', properties: { id: `r${i}`, name: `R${i}`, urls: { pbf: `https://x/r${i}-latest.osm.pbf` } }, geometry: { type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1], [0, 0]]] } }))
/** A region as Geofabrik's index of 2026-10-10 served eleven of them: no coordinates at all. */
const emptyRegion = (id) => ({ type: 'Feature', properties: { id, name: id, urls: { pbf: `https://x/${id}-latest.osm.pbf` } }, geometry: { type: 'Polygon', coordinates: [] } })

test('offline, a new volume routes from the vendored seed and never calls out', async () => {
  const dir = await tmp()
  try {
    let called = 0
    const g = new Geofabrik(dir, { fetch: async () => { called++; throw new Error('no route') } })
    const md = await g.region('us/maryland', { offline: true })
    assert.equal(called, 0)
    assert.equal(md.properties.id, 'us/maryland')
    assert.equal(g.source, 'seed')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('online, the live index is kept on the volume; a 200 with almost nothing in it is refused', async () => {
  const dir = await tmp()
  try {
    const empty = new Geofabrik(dir, { fetch: async () => ({ ok: true, json: async () => ({ features: features(3) }) }) })
    await empty.index()
    assert.match(empty.source, /seed/, 'three regions is not the catalogue; the seed stands in')
    const good = new Geofabrik(dir, { fetch: async () => ({ ok: true, json: async () => ({ features: features(120) }) }) })
    await good.index()
    assert.equal(good.source, 'geofabrik')
    assert.ok((await stat(path.join(dir, 'overpass', 'geofabrik-index.json'))).size > 1000)
    // and the next process reads the volume rather than asking again
    let called = 0
    const again = new Geofabrik(dir, { fetch: async () => { called++; throw new Error('should not ask') } })
    assert.equal((await again.list()).regions.length, 120)
    assert.equal(called, 0)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('a region Geofabrik leaves without an outline keeps the one the volume already had', async () => {
  // 2026-10-10: the live index listed us/maryland with `"coordinates": []`, and the editor recorded
  // it as "nothing", so every Maryland bake went to the public mirrors (which were answering 504)
  // with no problem reported anywhere. The volume's previous copy outlined it; the fill must use it.
  const dir = await tmp()
  try {
    await mkdir(path.join(dir, 'overpass'), { recursive: true })
    const previous = { features: [{ type: 'Feature', properties: { id: 'us/maryland', name: 'us/maryland' }, geometry: { type: 'MultiPolygon', coordinates: [[[[-79, 39], [-76, 39], [-76, 38], [-79, 38], [-79, 39]]]] } }] }
    await writeFile(path.join(dir, 'overpass', 'geofabrik-index.json'), JSON.stringify(previous))
    const live = { features: [...features(120), emptyRegion('us/maryland')] }
    const g = new Geofabrik(dir, { fetch: async () => ({ ok: true, json: async () => live }) })
    await g.index({ refresh: true })
    assert.equal(g.source, 'geofabrik', 'the live index still wins — this only fills one hole')
    const md = await g.region('us/maryland')
    assert.ok(hasOutline(md.geometry), 'the previous copy must outline it')
    assert.deepEqual(g.patched.map((p) => p.id), ['us/maryland'])
    assert.deepEqual(g.missing, [], 'nothing is left unoutlined')
    // and the filled outline is written to the volume, so the hole is not re-opened next boot
    const onDisk = JSON.parse(await readFile(path.join(dir, 'overpass', 'geofabrik-index.json'), 'utf8'))
    assert.ok(hasOutline(onDisk.features.find((f) => f.properties.id === 'us/maryland').geometry))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('a region nobody can outline is reported and never routed to', async () => {
  const dir = await tmp()
  try {
    const live = { features: [...features(120), emptyRegion('xx/nowhere')] }
    const g = new Geofabrik(dir, { fetch: async () => ({ ok: true, json: async () => live }) })
    await g.index({ refresh: true })
    assert.deepEqual(g.missing, ['xx/nowhere'])
    const f = await g.region('xx/nowhere')
    assert.equal(f.properties.id, 'xx/nowhere')
    assert.equal(hasOutline(f.geometry), false, 'the caller must check hasOutline before routing')
    assert.deepEqual(g.status().missingOutlines, ['xx/nowhere'])
    assert.equal((await g.list()).regions.find((r) => r.id === 'xx/nowhere').outline, false)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
