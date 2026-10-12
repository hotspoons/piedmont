// The pure geometry behind Route selection: merging the ways that share a ref into one chain, and
// asking where along that chain a point (or a distance) falls.
//
// Split out of map.ts because it is the part worth testing and it touches no canvas: the map calls
// it to draw the start and end markers and to set a trim, and the bake's own chain of the same ref
// is merged the same way (network._chains), so a trim the person sets lands on the line the bake
// keeps. See apps/game/test/editor-routegeom.test.ts.

export interface RouteWay {
  /** WGS84 [lon, lat] */
  line: [number, number][]
}

export interface Chain {
  /** the merged polyline, WGS84 */
  pts: [number, number][]
  /** along-track metres at each point; `cum[0]` is 0, `cum[n-1]` is `lengthM` */
  cum: number[]
  lengthM: number
}

const EMPTY: Chain = { pts: [], cum: [0], lengthM: 0 }

/** Ground metres between two lon/lat points, equirectangular — enough to trim a route by eye. */
export function metresBetween(a: [number, number], b: [number, number]): number {
  const midLat = ((a[1] + b[1]) / 2) * (Math.PI / 180)
  const dx = (b[0] - a[0]) * Math.cos(midLat) * 111320
  const dy = (b[1] - a[1]) * 110540
  return Math.hypot(dx, dy)
}

const key = (p: [number, number]) => `${p[0].toFixed(7)},${p[1].toFixed(7)}`

/**
 * Merge ways into the longest connected chain, greedily: start from the longest way, then keep
 * appending (or prepending) any way that shares the current end. Ways that meet only at a crossing
 * and not at an endpoint are not joined — the same rule the bake's `network._chains` uses, so a
 * ref's chain here is the shape of the chain the bake will hold.
 */
export function mergeWays(ways: RouteWay[]): Chain {
  const mine = ways.filter((w) => w.line.length >= 2)
  if (!mine.length) return EMPTY
  const used = new Set<number>()
  const longest = mine.reduce((a, b) => (b.line.length > a.line.length ? b : a))
  const pts: [number, number][] = [...longest.line]
  used.add(mine.indexOf(longest))
  let grew = true
  while (grew) {
    grew = false
    for (let i = 0; i < mine.length; i++) {
      if (used.has(i)) continue
      const w = mine[i]
      const head = key(pts[0])
      const tail = key(pts[pts.length - 1])
      if (key(w.line[0]) === tail) { pts.push(...w.line.slice(1)); used.add(i); grew = true }
      else if (key(w.line[w.line.length - 1]) === tail) { pts.push(...w.line.slice(0, -1).reverse()); used.add(i); grew = true }
      else if (key(w.line[w.line.length - 1]) === head) { pts.unshift(...w.line.slice(0, -1)); used.add(i); grew = true }
      else if (key(w.line[0]) === head) { pts.unshift(...w.line.slice(1).reverse()); used.add(i); grew = true }
    }
  }
  const cum = [0]
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + metresBetween(pts[i - 1], pts[i]))
  return { pts, cum, lengthM: cum[cum.length - 1] }
}

/** Where a lon/lat falls along a chain, in metres from the chain's own start. */
export function nearestAlong(chain: Chain, p: { lon: number; lat: number }): number {
  if (chain.pts.length < 2) return 0
  let best = 0
  let bestD = Infinity
  for (let i = 1; i < chain.pts.length; i++) {
    const [ax, ay] = chain.pts[i - 1]
    const [bx, by] = chain.pts[i]
    const dx = bx - ax
    const dy = by - ay
    const len2 = dx * dx + dy * dy || 1
    const t = Math.max(0, Math.min(1, ((p.lon - ax) * dx + (p.lat - ay) * dy) / len2))
    const d = (p.lon - (ax + t * dx)) ** 2 + (p.lat - (ay + t * dy)) ** 2
    if (d < bestD) {
      bestD = d
      best = chain.cum[i - 1] + t * (chain.cum[i] - chain.cum[i - 1])
    }
  }
  return best
}

/** The lon/lat at `s` metres along a chain's own cumulative distances. */
export function pointAtMetres(chain: Chain, s: number): [number, number] {
  const { pts, cum } = chain
  if (pts.length < 2) return pts[0] ?? [0, 0]
  const target = Math.max(0, Math.min(cum[cum.length - 1], s))
  let i = 1
  while (i < cum.length && cum[i] < target) i++
  const span = cum[i] - cum[i - 1] || 1
  const t = (target - cum[i - 1]) / span
  const [a, b] = [pts[i - 1], pts[i]]
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]
}
