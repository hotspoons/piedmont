// The geometry half of a drawn-area build: turning a ring a person drew into a closed polygon, an
// osmium `.poly` file, and — the part that decides the download — the smallest Geofabrik extract(s)
// covering it.
//
// The pick is tested against a small FIXTURE, not the live index: the fixture reproduces the two
// things that broke it in production — `us`, `us-south` and the states all naming `north-america`
// as their parent (siblings, not a tree) and overlapping rectangles — so the choice is exact and
// cannot flake when Geofabrik moves a border. A DC-sized draw once matched the whole-US extract
// here; the fixture is that regression.
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import { coveringRegions, drawnPolygon, osmPolyText } from './osmbuild.mjs'

const seed = JSON.parse(await readFile(new URL('./geofabrik-seed.json', import.meta.url), 'utf8'))
const ids = (fs) => fs.map((f) => f.id)

test('a drawn ring becomes a closed polygon, and nonsense is refused by name', () => {
  const p = drawnPolygon([
    [-77.2, 38.8],
    [-76.9, 38.8],
    [-76.9, 39.0],
  ])
  assert.equal(p.type, 'Polygon')
  assert.deepEqual(p.coordinates[0], [
    [-77.2, 38.8],
    [-76.9, 38.8],
    [-76.9, 39.0],
    [-77.2, 38.8],
  ])
  // an already-closed ring is not closed twice
  assert.equal(drawnPolygon([[-77.2, 38.8], [-76.9, 38.8], [-76.9, 39.0], [-77.2, 38.8]]).coordinates[0].length, 4)
  assert.throws(() => drawnPolygon([[-77, 38], [-76, 39]]), /at least three corners/)
  assert.throws(() => drawnPolygon([['x', 38], [-76, 39], [-75, 38]]), /not a lon\/lat pair/)
  assert.throws(() => drawnPolygon([[-200, 38], [-76, 39], [-75, 38]]), /not a lon\/lat pair/)
  // three corners, two of them the same after rounding to nothing: not a polygon
  assert.throws(() => drawnPolygon([[-77, 38], [-77, 38], [-77, 38]]), /not distinct enough/)
  assert.throws(() => drawnPolygon([[-120, 20], [0, 20], [0, 60], [-120, 60]]), /draw something smaller/)
})

test('the osmium .poly file is the shape, the format osmium extract and defer_deletes.py read', () => {
  const text = osmPolyText(drawnPolygon([[-77.2, 38.8], [-76.9, 38.8], [-76.9, 39.0]]), 'my area')
  const lines = text.trimEnd().split('\n')
  assert.equal(lines[0], 'my area')
  assert.equal(lines[1], '1')
  assert.equal(lines[lines.length - 1], 'END')
  // name + ring count + four coordinate lines (three corners, the ring closed) + END
  assert.equal(lines.length, 2 + 4 + 1)
})

test('a shape picks the smallest containing extract — a city, not the whole US beside it', () => {
  // DC is inside DC, Maryland, Virginia, the US and North America, all overlapping. Only DC.
  assert.deepEqual(ids(coveringRegions(FIXTURE, drawnPolygon(square([-77.0, 38.9], 0.02)))), ['us/district-of-columbia'])
  // Baltimore: Maryland is the smallest of US/Maryland/US/North America that hold it
  const md = coveringRegions(FIXTURE, drawnPolygon(square([-76.6, 39.3], 0.02)))
  assert.deepEqual(ids(md), ['us/maryland'])
  assert.ok(md[0].pbf.endsWith('maryland-latest.osm.pbf'))
  assert.ok(md[0].updates.endsWith('maryland-updates'), 'the covering extract also names its diff stream')
  // northern Virginia, south of the DC line
  assert.deepEqual(ids(coveringRegions(FIXTURE, drawnPolygon(square([-78.0, 37.5], 0.05)))), ['us/virginia'])
})

test('a shape across a border picks both neighbours, and never the continent', () => {
  const fs = coveringRegions(FIXTURE, drawnPolygon(ring(-78.2, 37.5, -77.8, 39.6)))
  assert.deepEqual(ids(fs).sort(), ['us/maryland', 'us/virginia'])
})

test('a shape only a continent holds picks the continent', () => {
  assert.deepEqual(ids(coveringRegions(FIXTURE, drawnPolygon(square([-60, 20], 0.5)))), ['north-america'])
})

test('a shape no extract covers is refused, plainly', () => {
  assert.throws(() => coveringRegions(FIXTURE, drawnPolygon(square([-30, 0], 0.5))), /no Geofabrik extract covers/)
  // …and an open-ocean hole in the coarse vendored seed, too
  assert.throws(() => coveringRegions(seed.features, drawnPolygon(square([10, 10], 0.05))), /no Geofabrik extract covers/)
})

test('the coarse vendored seed (what patches an empty live outline) still never reaches the continent', () => {
  const fs = coveringRegions(seed.features, drawnPolygon(square([-174.0, 22.79], 0.5)))
  assert.deepEqual(ids(fs), ['north-america'])
})

// --- the fixture ---------------------------------------------------------------------------------
//
// Flat parents, exactly as the live index files them, and rectangles so the areas order cleanly:
// DC (0.04) < Maryland (8.6) < Virginia (26) < US South (403) < US (1475) < North America (7440).
const ring = (w, s, e, n) => [[w, s], [e, s], [e, n], [w, n]]
const geo = (w, s, e, n) => ({ type: 'Polygon', coordinates: [[...ring(w, s, e, n), [w, s]]] })
const feat = (id, w, s, e, n) => ({ type: 'Feature', properties: { id, name: id, parent: 'north-america', urls: { pbf: `${id.replace(/\//g, '-')}-latest.osm.pbf`, updates: `${id.replace(/\//g, '-')}-updates` } }, geometry: geo(w, s, e, n) })
const FIXTURE = [
  feat('north-america', -170, 10, -50, 72),
  feat('us', -125, 25, -66, 50),
  feat('us-south', -106, 24, -75, 37),
  feat('us/maryland', -79.5, 37.9, -75.0, 39.8),
  feat('us/virginia', -83.7, 36.5, -75.0, 39.5),
  feat('us/district-of-columbia', -77.12, 38.79, -76.91, 39.0),
]

/** A small square around a point, big enough for the boundary sampler to land inside a state. */
function square([lon, lat], d = 0.05) {
  return ring(lon - d, lat - d, lon + d, lat + d)
}
