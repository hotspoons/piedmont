// Which coarse vector level a map draws, and the cells that cover a view. Pure — no THREE, no DOM —
// so the editor's map (editor/view/maproads.ts), the game's minimap (game/move/minimap.ts) and any
// worker can share one policy. Moved out of `maproads.ts`, which re-exports it.

/** metres per CSS pixel at or below which each tier is drawn (tier 1 is "z14": ≤ 10 m a pixel) */
export const TIER_MPP = [Infinity, 10, 2.5]

/**
 * Which coarse vector level fits the eye, or null to use `vt/0`.
 *
 * `vt.levels` (bake/vtiles.py) is the pyramid's coarse end, keyed by quadtree z; each level's cells
 * are `cell_m` metres and carry only the distance-reading layers. A map picks the COARSEST level
 * whose cells still fit the view a few times across — few tiles, and detail scaled to the distance —
 * and falls to `vt/0` (null) once even the finest coarse level is too coarse to read, i.e. zoomed in.
 *
 * `viewPx` is the view's long side in CSS pixels; `mpp` its metres a pixel, so `mpp · viewPx` is the
 * ground span. A level fits when its cell is at most half that span (≈2 cells across, the minimum
 * that shows a road's shape rather than a dot).
 *
 * NO DEAD BAND. The fine tiles only stream at or below `minMpp` (`TIER_MPP[1]`, the "z14" zoom). If
 * no coarse level fits yet the eye is still coarser than that, the FINEST coarse level bridges the
 * gap — better a slightly-too-coarse tile than a screen with no new roads on it — and it hands over
 * to `vt/0` exactly at `minMpp`.
 */
export function chooseVectorLevel(
  levels: Record<string, { cell_m: number }> | undefined,
  mpp: number,
  viewPx = 1000,
  minMpp = TIER_MPP[1],
): string | null {
  if (!levels) return null
  const half = (mpp * viewPx) / 2
  let best: string | null = null
  let bestCell = 0
  let finest: string | null = null
  let finestCell = Infinity
  for (const z of Object.keys(levels)) {
    const cell = levels[z]?.cell_m ?? 0
    if (cell <= 0) continue
    if (cell < finestCell) { finest = z; finestCell = cell }
    if (cell <= half && cell >= bestCell) { best = z; bestCell = cell }
  }
  if (best) return best
  return finest && mpp > minMpp ? finest : null
}

/**
 * The site-metre cells a box crosses at `cell_m`: `(floor(x/cell), floor(y/cell))`, inclusive on both
 * ends — the same key space `vt/0` and the coarse bundles are written in (`bake/vtiles.py`), so a
 * cell's id is `(x, y)` under whichever level directory names it.
 */
export function cellsCovering(cell_m: number, x0: number, y0: number, x1: number, y1: number): { x: number; y: number }[] {
  const cell = Math.max(1, cell_m)
  const out: { x: number; y: number }[] = []
  for (let ix = Math.floor(x0 / cell); ix <= Math.floor(x1 / cell); ix++) {
    for (let iy = Math.floor(y0 / cell); iy <= Math.floor(y1 / cell); iy++) out.push({ x: ix, y: iy })
  }
  return out
}

/**
 * The level a small map streams, capped so a wide view never asks for a wall of cells.
 *
 * `chooseVectorLevel` answers the EDITOR's question — the coarsest level that still shows a road's
 * shape, ~2 cells across — which is right for a fixed ~1000 px view with a handover to `vt/0`. A
 * minimap zooms over a far wider range on a view that can fill the screen, so that rule would ask for
 * `vt/0` at 10 km across: hundreds of 1 km cells. Here the level is the FINEST whose cell keeps the
 * view under `maxAcross` cells across, and `null` means `vt/0`. Never fetches more than `maxAcross²`.
 *
 * `size_m` is `vt/0`'s cell (`manifest.vt.size_m`); `mpp` is metres a pixel and `viewPx` the view's
 * long side, so `mpp · viewPx` is the ground span.
 */
export function chooseMapLevel(
  levels: Record<string, { cell_m: number }> | undefined,
  size_m: number,
  mpp: number,
  viewPx: number,
  maxAcross = 8,
): { z: string | null; cell_m: number } {
  const want = (mpp * viewPx) / Math.max(1, maxAcross)
  const fine = size_m > 0 ? size_m : 1000
  const coarse = Object.keys(levels ?? {})
    .map((z) => ({ z, cell: levels?.[z]?.cell_m ?? 0 }))
    .filter((l) => l.cell > 0)
  // `vt/0` when its own cell already keeps the view under the cap, or when there are no coarse levels
  if (fine >= want || !coarse.length) return { z: null, cell_m: fine }
  // the finest coarse level at or above the wanted cell; if none is that coarse, the coarsest there is
  const fits = coarse.filter((l) => l.cell >= want).sort((a, b) => a.cell - b.cell)[0]
  const pick = fits ?? coarse.sort((a, b) => b.cell - a.cell)[0]
  return { z: pick.z, cell_m: pick.cell }
}

