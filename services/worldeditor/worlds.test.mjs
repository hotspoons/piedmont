// A drawn world is validated here, and since 2026-10-11 that no longer includes a size ceiling.
//
// There used to be a `MAX_M = 20000` half-width refusal ("bake it in pieces") from when one Job
// owned the whole bbox. The runner shards a large world automatically now (runs.mjs #shouldShard),
// so validate() warns with the shard count and the area instead — mirroring the bake's own
// `shards.partition` so the number a person reads is the number they get.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fromDraw, shardPlan, validate } from './worlds.mjs'

const cfg = { shardAboveM: 5000, shardSideM: 10000, maxShards: 36 }
const world = (radius_m, extra = {}) => ({ slug: 'preview-x', kind: null, lat: 39.31, lon: -76.62, radius_m, ...extra })

test('a world past the old ceiling is accepted now', () => {
  const v = validate(world(28751), cfg)
  assert.equal(v.ok, true)
  assert.deepEqual(v.errors, [])
  // and it says what the bake becomes: the pieces, named
  assert.equal(v.warnings.length, 1)
  assert.match(v.warnings[0], /36 blocks/)
  assert.match(v.warnings[0], /3306 km²/)
})

test('shardPlan mirrors the bake partition on the square an un-shaped world bakes', () => {
  // the numbers are the Python `shards.partition` answers for the same inputs
  assert.equal(shardPlan(6000, cfg).count, 4)
  assert.equal(shardPlan(15000, cfg).count, 9)
  assert.equal(shardPlan(20000, cfg).count, 16)
  assert.equal(shardPlan(28751, cfg).count, 36)
  // over the cap, the tie-break merges the longer axis first — 35, not 36 (partition's own answer)
  assert.equal(shardPlan(30500, cfg).count, 35)
})

test('without the shard config there is no shard count, only the area', () => {
  const v = validate(world(28751))
  assert.equal(v.ok, true)
  assert.match(v.warnings[0], /3306 km²/)
  assert.doesNotMatch(v.warnings[0], /blocks/)
})

test('a small world is still refused below the floor, and warned above the comfort line', () => {
  assert.equal(validate(world(50)).ok, false)
  const v = validate(world(4500), cfg)
  assert.equal(v.ok, true)
  assert.match(v.warnings[0], /expect hours/) // under shardAboveM: no block count
})

/* ---- route worlds: several refs bounded to a clip, with a per-ref start/end trim ---- */

const ring = [[-77.6, 39.4], [-77.4, 39.4], [-77.4, 39.6], [-77.6, 39.6]]
const routeDraw = (extra = {}) =>
  fromDraw({
    slug: 'i70-and-15',
    name: 'I-70 and US-15',
    kind: 'route',
    refs: ['I 70', 'US 15'],
    clip: ring,
    centre: { lat: 39.5, lon: -77.5 },
    radius_m: 12000,
    primary: 'I 70',
    ...extra,
  })

test('fromDraw keeps a route a route: refs, the clip ring, and the trim', () => {
  const cuts = { 'I 70': [[-77.55, 39.45], [-77.45, 39.55]] }
  const w = routeDraw({ cuts })
  assert.equal(w.kind, 'route')
  assert.deepEqual(w.refs, ['I 70', 'US 15'])
  assert.deepEqual(w.clip, ring)
  assert.deepEqual(w.cuts, cuts)
  // a route is never "every street", and it carries no `roads` list — those are the network keys
  assert.equal(w.all_streets, false)
  assert.equal(w.roads, undefined)
})

test('a route validates on its refs, not on its spine being among roads', () => {
  assert.equal(validate(routeDraw()).ok, true)
  const noRefs = validate(routeDraw({ refs: [] }))
  assert.equal(noRefs.ok, false)
  assert.match(noRefs.errors.join(' '), /at least one route/)
  const badSpine = validate(routeDraw({ primary: 'I 95' }))
  assert.equal(badSpine.ok, false)
  assert.match(badSpine.errors.join(' '), /not in the route list/)
})

test('a route region with a stray two-point ring is refused', () => {
  const v = validate(routeDraw({ clip: [[-77.6, 39.4], [-77.4, 39.4]] }))
  assert.equal(v.ok, false)
  assert.match(v.errors.join(' '), /at least three points/)
})
