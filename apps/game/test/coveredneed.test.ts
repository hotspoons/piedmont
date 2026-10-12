// The sink that keeps a coarse terrain tile under the finer tile drawn over it is MEASURED from the
// two surfaces, not a constant: on a country-sized site a graded cut or a deep fill leaves the parent
// tens of metres above the child, and 8 m lets it punch straight through. `coveredNeed` is that
// measurement, over one coarse tile's four quadrants (Rich, 2026-10-12).
import { describe, expect, it } from 'vitest'
import * as THREE from 'three'
import { coveredNeed } from '../src/lod/pyramidstream'

/** A coarse tile's grid as (u, v, baseWorld) — v is the plane v, so the attribute stores 1 - v. */
function grid(rows: { u: number; v: number; x: number; z: number; y: number }[]) {
  const n = rows.length
  const pos = new Float32Array(n * 3)
  const uv = new THREE.BufferAttribute(new Float32Array(n * 2), 2)
  rows.forEach((r, i) => {
    pos[i * 3] = r.x
    pos[i * 3 + 1] = r.y
    pos[i * 3 + 2] = r.z
    uv.setXY(i, r.u, 1 - r.v)
  })
  return { pos, uv }
}

// one vertex at each quadrant's middle, so a mask bit picks exactly one row
const corners = [
  { u: 0.25, v: 0.25, x: 0, z: 0, y: 10 },
  { u: 0.75, v: 0.25, x: 10, z: 0, y: 20 },
  { u: 0.25, v: 0.75, x: 0, z: 10, y: 30 },
  { u: 0.75, v: 0.75, x: 10, z: 10, y: 40 },
]

/** Every quadrant answers with the same finer surface. */
const flat = (_qi: number, _x: number, _z: number) => 0

describe('coveredNeed', () => {
  it('reports, per quadrant, how far the coarse surface stands above the finer one', () => {
    const { pos, uv } = grid(corners)
    const need = coveredNeed(uv, pos, 0b1111, flat)
    expect(need).toEqual([10, 20, 30, 40])
  })

  it('only measures the quadrants the mask names', () => {
    const { pos, uv } = grid(corners)
    expect(coveredNeed(uv, pos, 0b0010, flat)).toEqual([0, 20, 0, 0])
    expect(coveredNeed(uv, pos, 0b1100, flat)).toEqual([0, 0, 30, 40])
  })

  it('is zero where the finer surface is at or above the coarse one', () => {
    const { pos, uv } = grid(corners)
    // the finer surface stands 100 m proud everywhere: nothing to sink
    expect(coveredNeed(uv, pos, 0b1111, () => 100)).toEqual([0, 0, 0, 0])
  })

  it('asks the child named for the quadrant, in the viewer frame (z = -north)', () => {
    const { pos, uv } = grid([{ u: 0.25, v: 0.25, x: 3, z: 7, y: 10 }])
    const seen: [number, number, number][] = []
    const need = coveredNeed(uv, pos, 0b0001, (qi, x, z) => {
      seen.push([qi, x, z])
      return 4
    })
    expect(seen).toEqual([[0, 3, 7]])
    expect(need).toEqual([6, 0, 0, 0])
  })

  it('skips a vertex the covering tile does not own (NaN), so a seam cannot fake a cliff', () => {
    const { pos, uv } = grid([{ u: 0.25, v: 0.25, x: 0, z: 0, y: 200 }])
    expect(coveredNeed(uv, pos, 0b0001, () => Number.NaN)).toEqual([0, 0, 0, 0])
  })

  it('stays off the shared cross at u = 0.5 / v = 0.5', () => {
    const { pos, uv } = grid([
      { u: 0.5, v: 0.5, x: 0, z: 0, y: 99 },
      { u: 0.5, v: 0.2, x: 0, z: 0, y: 99 },
      { u: 0.2, v: 0.5, x: 0, z: 0, y: 99 },
      { u: 0.8, v: 0.8, x: 0, z: 0, y: 50 },
    ])
    // only the interior vertex of quadrant 3 counts
    expect(coveredNeed(uv, pos, 0b1111, flat)).toEqual([0, 0, 0, 50])
  })

  it('a stride oversamples less of a dense grid but still finds the peak', () => {
    const rows = []
    for (let r = 0; r < 20; r++) {
      for (let c = 0; c < 20; c++) {
        const u = (c + 0.5) / 20
        const v = (r + 0.5) / 20
        rows.push({ u, v, x: c, z: r, y: c === 5 && r === 5 ? 70 : 1 })
      }
    }
    const { pos, uv } = grid(rows)
    // vertex (5, 5) is in quadrant 0 and survives a stride of 5 (index 5*20+5 = 105, 105 % 5 == 0)
    expect(coveredNeed(uv, pos, 0b0001, flat, 5)[0]).toBe(70)
  })
})
