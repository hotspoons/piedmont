// The geometry half of "draw a polygon, build that area into an Overpass instance".
//
// Rich, 2026-10-11: "for world -> explore ... clicking OSM data will list the instances - selecting
// an instance will let you draw a polygon on the screen, and once you close the polygon you can
// launch an index/build job for the overpass instance." And: "In the future I won't bake all of
// north america if I am just interested in a subset."
//
// WHAT A BUILD IS, GIVEN THE NAMED-REGION IMPORT ALREADY EXISTS (runs.mjs `osmImport`). A drawn
// area has no Geofabrik id, so it is turned into one here: find the smallest Geofabrik extract(s)
// whose own coverage the drawn area touches, download those, and let the instance's Job clip them
// to the drawn polygon (`osmium extract -p`) before staging the result for the `regions` sidecar —
// exactly the path a named region takes. The drawn polygon becomes the region's outline, so the
// map and routing treat it like any other.
//
// WHY THE SERVER PICKS THE EXTRACT. The client cannot: it would need the Geofabrik index's
// geometry and the size of each candidate .pbf (a HEAD request), both of which live here. So the
// route answers with the chosen sources BEFORE any download — the dialog confirms against real
// numbers, not a guess (server.mjs `POST /api/osm/builds`, dryRun).
//
// Pure functions over plain geometry and index features, so the pick is tested without a network
// (osmbuild.test.mjs). coverage.mjs owns point-in-polygon and the bounding box; this only chooses.

import { bboxOfGeom, hasOutline, pointIn, polygonsOf } from './coverage.mjs'

/** A drawn area wider than this is a mistake, not a build — north-america is ~170° × 80°. */
const MAX_SPAN_DEG = 20
const MAX_VERTICES = 2000
/** More than this many extracts to download for one drawn area is a sign the area is too big. */
const MAX_SOURCES = 8

const bad = (message) => Object.assign(new Error(message), { status: 400 })

const boxIntersects = (a, b) => a.west <= b.east && a.east >= b.west && a.south <= b.north && a.north >= b.south

/**
 * A drawn ring as a closed GeoJSON Polygon. Throws a 400-shaped error on anything that cannot be
 * one, so the route can hand the message straight to the person.
 *
 * @param {unknown} points  `[[lon, lat], …]` as the coverage map reports the ring
 */
export function drawnPolygon(points) {
  if (!Array.isArray(points) || points.length < 3) throw bad('a polygon needs at least three corners')
  if (points.length > MAX_VERTICES) throw bad(`that polygon has ${points.length} corners; ${MAX_VERTICES} is the most a build takes`)
  const ring = []
  for (const p of points) {
    const lon = Number(p?.[0])
    const lat = Number(p?.[1])
    if (!Number.isFinite(lon) || !Number.isFinite(lat) || lon < -180 || lon > 180 || lat < -90 || lat > 90) {
      throw bad('a corner is not a lon/lat pair on the earth')
    }
    const last = ring[ring.length - 1]
    if (last && Math.abs(last[0] - lon) < 1e-9 && Math.abs(last[1] - lat) < 1e-9) continue
    ring.push([lon, lat])
  }
  if (ring.length < 3) throw bad('the corners are not distinct enough to make a polygon')
  const [x0, y0] = ring[0]
  const last = ring[ring.length - 1]
  if (x0 !== last[0] || y0 !== last[1]) ring.push([x0, y0])
  const box = bboxOfGeom({ type: 'Polygon', coordinates: [ring] })
  const spanX = box.east - box.west
  const spanY = box.north - box.south
  if (spanX > MAX_SPAN_DEG || spanY > MAX_SPAN_DEG) {
    throw bad(`that area is ${spanX.toFixed(1)}° × ${spanY.toFixed(1)}° across — draw something smaller, or add a named region instead`)
  }
  return { type: 'Polygon', coordinates: [ring] }
}

/**
 * The drawn polygon as an osmium `.poly` file — the format `osmium extract -p` reads and the same
 * one Geofabrik publishes beside each extract, so `defer_deletes.py` and the coverage map already
 * understand it.
 */
export function osmPolyText(polygon, name = 'drawn area') {
  const ring = polygon.coordinates[0]
  const lines = [String(name).replace(/\s+/g, ' ').trim().slice(0, 60) || 'drawn area', '1']
  for (const [lon, lat] of ring) lines.push(`   ${lon.toFixed(7)} ${lat.toFixed(7)}`)
  lines.push('END')
  return `${lines.join('\n')}\n`
}

/** A ring's boundary, `target` points spread along it, plus its vertex mean as an interior guess. */
function ringSamples(ring, target = 96) {
  const out = []
  const edges = ring.length - 1
  if (edges < 1) return out
  const per = Math.max(1, Math.floor(target / edges))
  for (let i = 0; i < edges; i++) {
    const [x0, y0] = ring[i]
    const [x1, y1] = ring[i + 1]
    for (let k = 0; k < per; k++) {
      const t = k / per
      out.push([x0 + (x1 - x0) * t, y0 + (y1 - y0) * t])
    }
  }
  let cx = 0
  let cy = 0
  for (let i = 0; i < edges; i++) {
    cx += ring[i][0]
    cy += ring[i][1]
  }
  out.push([cx / edges, cy / edges])
  return out
}

/** The samples of every polygon in a (multi)polygon, so a small drawn area can be tested against a big one. */
function geomSamples(geom, target = 64) {
  return polygonsOf(geom).flatMap((poly) => (poly[0] ? ringSamples(poly[0], target) : []))
}

/**
 * The smallest Geofabrik extracts whose coverage the drawn area touches.
 *
 * "Smallest" is by nesting, not by area: Geofabrik files a state under a country under a continent
 * (`north-america/us/virginia`), and any feature that has a DESCENDANT also overlapping is dropped.
 * So a city inside Virginia picks Virginia, not the United States, and a drawn area straddling a
 * border picks both neighbours. A drawn area that no extract covers (ocean, or a hole in the index)
 * is a 400, said plainly.
 *
 * @param {Array<{properties: {id: string, name?: string, urls?: {pbf?: string, updates?: string}}, geometry: unknown}>} features  the Geofabrik index's features
 * @param {{type: 'Polygon', coordinates: number[][][]}} polygon
 */
export function coveringRegions(features, polygon) {
  const box = bboxOfGeom(polygon)
  const all = features ?? []
  const byId = new Map(all.map((f) => [f.properties?.id, f]))
  // is `ancestor` above `f` in the index's parent chain? (Geofabrik files a state under a country
  // under a continent through `properties.parent`; the ids themselves are not always nested)
  const descendsFrom = (f, ancestor) => {
    let p = f.properties?.parent
    for (let hops = 0; p && hops < 32; hops++) {
      if (p === ancestor) return true
      p = byId.get(p)?.properties?.parent
    }
    return false
  }
  const overlap = all.filter((f) => hasOutline(f.geometry) && boxIntersects(bboxOfGeom(f.geometry), box))
  // the SMALLEST overlapping features: drop any that has a descendant also overlapping, so a city
  // inside Virginia picks Virginia's extract, not the whole continent's
  const leaves = overlap.filter((f) => !overlap.some((g) => g !== f && descendsFrom(g, f.properties?.id)))
  // A drawn area touches a leaf if either shape reaches into the other: a vertex or edge of the
  // drawing inside the leaf (the drawing sits in it, or crosses its border), OR a point of the leaf
  // inside the drawing (the drawing swallows a whole leaf). Their bboxes overlapping alone means
  // nothing — a continent's own bbox spans the world, so a square over the ocean overlaps it.
  const drawn = ringSamples(polygon.coordinates[0])
  const touched = leaves.filter(
    (f) => drawn.some(([lon, lat]) => pointIn(f.geometry, lon, lat)) || geomSamples(f.geometry).some(([lon, lat]) => pointIn(polygon, lon, lat)),
  )
  const chosen = touched
  if (!chosen.length) throw bad('no Geofabrik extract covers that area — draw over land Geofabrik publishes, or add a named region')
  if (chosen.length > MAX_SOURCES) throw bad(`that area touches ${chosen.length} extracts (${chosen.map((f) => f.properties?.id).join(', ')}) — draw a smaller area`)
  return chosen
    .map((f) => ({
      id: f.properties?.id ?? '',
      name: f.properties?.name ?? f.properties?.id ?? '',
      pbf: f.properties?.urls?.pbf ?? null,
      updates: f.properties?.urls?.updates ?? null,
    }))
    .sort((a, b) => a.id.localeCompare(b.id))
}
