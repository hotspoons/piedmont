// The editor map's coarse-level choice (src/editor/view/maproads.ts): which `vt.levels` bundle fits
// the eye, so a zoomed-out map reads major roads from a coarse tile instead of every 1 km `vt/0` one.
import { describe, expect, it } from 'vitest'
import { chooseVectorLevel } from '../src/editor/view/maproads'

// a dc-scale pyramid: 8 / 16 / 32 km cells, the coarse end `vtiles.levels_for` would write
const LEVELS = { '11': { cell_m: 8000 }, '10': { cell_m: 16000 }, '9': { cell_m: 32000 } }

describe('chooseVectorLevel', () => {
  it('is null when the bake carries no coarse levels', () => {
    expect(chooseVectorLevel(undefined, 40)).toBeNull()
    expect(chooseVectorLevel({}, 40)).toBeNull()
  })

  it('falls to vt/0 when even the finest coarse level is too coarse to read', () => {
    // 10 m/px over 1000 px is 10 km: half is 5 km, below the 8 km finest level. At exactly the fine
    // zoom, vt/0 takes over.
    expect(chooseVectorLevel(LEVELS, 10)).toBeNull()
  })

  it('bridges the gap between the coarse fit and the fine tiles with the finest coarse level', () => {
    // 13 m/px: half is 6.5 km, no level fits, but the eye is still coarser than the 10 m/px handover
    // to vt/0 — so the finest coarse level stands in rather than leaving the screen bare
    expect(chooseVectorLevel(LEVELS, 13)).toBe('11')
  })

  it('picks the coarsest level whose cell still fits the view a couple of times across', () => {
    // 16 m/px: 16 km span, half 8 km -> only the 8 km level fits
    expect(chooseVectorLevel(LEVELS, 16)).toBe('11')
    // 40 m/px: 40 km span, half 20 km -> 8 and 16 fit, 32 does not -> the coarsest that fits
    expect(chooseVectorLevel(LEVELS, 40)).toBe('10')
    // 100 m/px: 100 km span -> all three fit -> the coarsest
    expect(chooseVectorLevel(LEVELS, 100)).toBe('9')
  })

  it('honours the view width', () => {
    // the same mpp fits a coarser level when the view is wider
    expect(chooseVectorLevel(LEVELS, 16, 2000)).toBe('10')
  })

  it('ignores a level with no cell size', () => {
    expect(chooseVectorLevel({ '11': { cell_m: 0 }, '10': { cell_m: 16000 } }, 40)).toBe('10')
  })
})
