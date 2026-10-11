// The geometry half of a drawn-area build: turning a ring a person drew into a closed polygon, an
// osmium `.poly` file, and — the part that decides the download — the smallest Geofabrik extract(s)
// covering it. No network: the index here is the same seed the coverage tests use.
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import { coveringRegions, drawnPolygon, osmPolyText } from './osmbuild.mjs'

const seed = JSON.parse(await readFile(new URL('./geofabrik-seed.json', import.meta.url), 'utf8'))
// a point inside each seed feature's own (coarse) outline, found once and written down
const IN = {
  maryland: [-79.413, 39.2661],
  virginia: [-83.5221, 36.6357],
  dc: [-77.1166, 38.9311],
  northAmerica: [-174.0, 22.7907],
}
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

test('an area inside one state picks that state, never the continent', () => {
  const fs = coveringRegions(seed.features, drawnPolygon(square(IN.maryland)))
  assert.deepEqual(ids(fs), ['us/maryland'])
  assert.ok(fs[0].pbf.endsWith('maryland-latest.osm.pbf'))
  assert.ok(fs[0].updates.endsWith('maryland-updates'), 'the covering extract also names its diff stream')
})

test('an area that straddles two states picks both, and still not the continent', () => {
  // a long, thin shape with a corner in Maryland and a corner in Virginia
  const fs = coveringRegions(seed.features, drawnPolygon([IN.maryland, IN.virginia, [IN.virginia[0], IN.maryland[1]]]))
  assert.deepEqual(ids(fs).sort(), ['us/maryland', 'us/virginia'])
})

test('an area no extract covers is refused, plainly', () => {
  assert.throws(() => coveringRegions(seed.features, drawnPolygon(square([10, 10]))), /no Geofabrik extract covers/)
})

test('an area only a continent covers picks the continent', () => {
  const fs = coveringRegions(seed.features, drawnPolygon(square(IN.northAmerica)))
  assert.deepEqual(ids(fs), ['north-america'])
})

/** A small square around a point, big enough for the boundary sampler to land inside a state. */
function square([lon, lat], d = 0.05) {
  return [
    [lon - d, lat - d],
    [lon + d, lat - d],
    [lon + d, lat + d],
    [lon - d, lat + d],
  ]
}
