// Route selection's geometry (src/editor/worldedit/routegeom.ts): the part of the world editor's
// many-road picker that is worth testing and that touches no canvas.
//
// The chain here is the shape of the chain the BAKE merges for the same ref (network._chains joins
// ways that share an endpoint), which is the whole reason a trim set on the map lands where the
// bake keeps: the map stores the clicked lon/lat, not a metre offset from a chain that might differ.
import { describe, expect, it } from 'vitest'
import { mergeWays, metresBetween, nearestAlong, pointAtMetres } from '../src/editor/worldedit/routegeom'

const way = (...line: [number, number][]) => ({ line })

describe('metresBetween', () => {
  it('is about 111 m for a thousandth of a degree of latitude', () => {
    expect(metresBetween([-76, 39], [-76, 39.001])).toBeGreaterThan(105)
    expect(metresBetween([-76, 39], [-76, 39.001])).toBeLessThan(115)
  })
})

describe('mergeWays', () => {
  it('joins ways that share an endpoint, flipping the one that points the wrong way', () => {
    // both run north; the second is stored north-to-south, so the merge has to flip it
    const chain = mergeWays([way([-76, 39], [-76, 39.001]), way([-76, 39.002], [-76, 39.001])])
    expect(chain.pts).toHaveLength(3)
    expect(chain.pts[0]).toEqual([-76, 39])
    expect(chain.pts[2]).toEqual([-76, 39.002])
    expect(chain.lengthM).toBeGreaterThan(210)
    expect(chain.lengthM).toBeLessThan(230)
  })

  it('prepends a way that meets the start', () => {
    const chain = mergeWays([way([-76, 39], [-76, 39.001]), way([-76, 38.999], [-76, 39])])
    expect(chain.pts[0]).toEqual([-76, 38.999])
    expect(chain.pts[chain.pts.length - 1]).toEqual([-76, 39.001])
  })

  it('does not join a way that only crosses, rather than meets, the chain', () => {
    // a crossing way shares no endpoint; the chain is the longest run, not everything nearby
    const chain = mergeWays([
      way([-76, 39], [-76, 39.001]),
      way([-76.0005, 38.999], [-76.0005, 39.002]),
    ])
    expect(chain.pts).toHaveLength(2)
  })

  it('starts from the longest way and never repeats a point it already has', () => {
    const chain = mergeWays([way([-76, 39], [-76, 39.001]), way([-76, 39.001], [-76, 39.002])])
    const dupes = chain.pts.filter((p, i) => i > 0 && p[0] === chain.pts[i - 1][0] && p[1] === chain.pts[i - 1][1])
    expect(dupes).toHaveLength(0)
  })

  it('is empty for no ways', () => {
    expect(mergeWays([])).toEqual({ pts: [], cum: [0], lengthM: 0 })
    expect(mergeWays([{ line: [] }]).lengthM).toBe(0)
  })
})

describe('nearestAlong', () => {
  const chain = mergeWays([way([-76, 39], [-76, 39.002])])

  it('clamps before the start and past the end', () => {
    expect(nearestAlong(chain, { lon: -76, lat: 38.99 })).toBe(0)
    expect(nearestAlong(chain, { lon: -76, lat: 39.05 })).toBeCloseTo(chain.lengthM, 3)
  })

  it('projects a point beside the chain onto the nearest point of it', () => {
    const mid = nearestAlong(chain, { lon: -75.999, lat: 39.001 }) // 100 m east of the middle
    expect(mid).toBeGreaterThan(chain.lengthM * 0.4)
    expect(mid).toBeLessThan(chain.lengthM * 0.6)
  })
})

describe('pointAtMetres', () => {
  const chain = mergeWays([way([-76, 39], [-76, 39.002])])

  it('returns the ends at 0 and at the length, clamping beyond', () => {
    expect(pointAtMetres(chain, 0)).toEqual([-76, 39])
    expect(pointAtMetres(chain, chain.lengthM)).toEqual([-76, 39.002])
    expect(pointAtMetres(chain, -50)).toEqual([-76, 39])
    expect(pointAtMetres(chain, chain.lengthM + 1e6)).toEqual([-76, 39.002])
  })

  it('interpolates the middle', () => {
    const [lon, lat] = pointAtMetres(chain, chain.lengthM / 2)
    expect(lon).toBeCloseTo(-76, 6)
    expect(lat).toBeCloseTo(39.001, 4)
  })
})
