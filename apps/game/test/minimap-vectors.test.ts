// The minimap's vector data path (src/world/vectorlevel.ts, src/game/move/mapvectors.ts): which level
// a map streams, the cells that cover its view, and how a vector tile's layers become the map's
// classes. Pure functions — no worker, no DOM.
import { describe, expect, it } from 'vitest'
import { chooseMapLevel, cellsCovering } from '../src/world/vectorlevel'
import { mapLayersOf } from '../src/game/move/mapvectors'

// a dc-scale pyramid: 8 / 16 / 32 km cells, the coarse end `vtiles.levels_for` would write
const LEVELS = { '11': { cell_m: 8000 }, '10': { cell_m: 16000 }, '9': { cell_m: 32000 } }

describe('chooseMapLevel', () => {
  it('uses vt/0 when the fine 1 km cell already keeps the view under the cap', () => {
    // 4 m/px over 240 px is 960 m: one km cells are fine, and vt/0 carries every class
    expect(chooseMapLevel(LEVELS, 1000, 4, 240)).toEqual({ z: null, cell_m: 1000 })
  })

  it('uses vt/0 when the bake carries no coarse levels at all', () => {
    expect(chooseMapLevel(undefined, 1000, 40, 240)).toEqual({ z: null, cell_m: 1000 })
    expect(chooseMapLevel({}, 1000, 40, 240)).toEqual({ z: null, cell_m: 1000 })
  })

  it('picks the finest coarse level whose cell keeps the view under the cap', () => {
    // 10 km across, cap 8 -> want 1250 m: the 8 km level is the finest at or above it
    expect(chooseMapLevel(LEVELS, 1000, 10000 / 240, 240)).toEqual({ z: '11', cell_m: 8000 })
    // 100 km across -> want 12.5 km -> 16 km fits
    expect(chooseMapLevel(LEVELS, 1000, 100000 / 240, 240)).toEqual({ z: '10', cell_m: 16000 })
    // 400 km across -> want 50 km -> only 32 km fits, and 32 km is the coarsest there is
    expect(chooseMapLevel(LEVELS, 1000, 400000 / 240, 240)).toEqual({ z: '9', cell_m: 32000 })
  })

  it('falls back to the coarsest level when none is as coarse as the view wants', () => {
    expect(chooseMapLevel({ '11': { cell_m: 8000 } }, 1000, 100000 / 240, 240)).toEqual({ z: '11', cell_m: 8000 })
  })

  it('never needs more than maxAcross² cells while the pyramid can match the view', () => {
    // the pyramid's coarsest cell is 32 km; up to mpp=100 the cap of 8 across is reachable
    for (const mpp of [0.5, 4, 20, 100]) {
      const { cell_m } = chooseMapLevel(LEVELS, 1000, mpp, 2560, 8)
      const r = (mpp * 2560) / 2
      expect(cellsCovering(cell_m, -r, -r, r, r).length).toBeLessThanOrEqual(81)
    }
  })
})

describe('cellsCovering', () => {
  it('is the cells a box crosses, inclusive on both ends', () => {
    expect(cellsCovering(1000, 100, 100, 1100, 1100)).toEqual([
      { x: 0, y: 0 }, { x: 0, y: 1 }, { x: 1, y: 0 }, { x: 1, y: 1 },
    ])
  })

  it('keys negative coordinates the same way the bake writes them', () => {
    expect(cellsCovering(1000, -100, -100, 100, 100)).toEqual([
      { x: -1, y: -1 }, { x: -1, y: 0 }, { x: 0, y: -1 }, { x: 0, y: 0 },
    ])
  })

  it('is one cell for a box inside a cell', () => {
    expect(cellsCovering(1000, 10, 10, 200, 200)).toEqual([{ x: 0, y: 0 }])
  })
})

describe('mapLayersOf', () => {
  it('classes branches by `highway`, and drops what it cannot draw', () => {
    const out = mapLayersOf({
      branches: [
        { highway: 'motorway', coords: [[0, 0, 5], [10, 0, 5]] },
        { highway: null, coords: [[0, 0], [1, 1]] },
        { highway: 'residential', coords: [[2, 2]] },
      ],
    })
    expect(out).toEqual([{ cls: 'motorway', coords: [[0, 0], [10, 0]] }])
  })

  it('gives trails, rail and streams their own layers', () => {
    const out = mapLayersOf({
      branches: [],
      trails: [{ kind: 'path', coords: [[0, 0], [5, 5]] }],
      rail: [{ kind: 'rail', coords: [[0, 0], [9, 9]] }],
      water: { lines: [{ kind: 'stream', pts: [[1, 1], [2, 2]] }] },
    })
    expect(out.map((l) => l.cls)).toEqual(['trail', 'railway', 'waterway'])
  })

  it('is nothing for a tile with no line layers', () => {
    expect(mapLayersOf({})).toEqual([])
    expect(mapLayersOf({ branches: [], water: { lines: [] } })).toEqual([])
  })
})
