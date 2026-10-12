// Turning a vector tile — a `vt/0` cell or a coarse `vt/<z>` bundle — into the minimap's class
// vocabulary. Pure: no DOM, no THREE, no worker, so the mapping is tested in isolation and used from
// minimap.ts (which fetches the cells) and its worker (which strokes them).
//
// THE SAME PARTIAL MANIFEST BOTH WAYS. The bake writes a coarse tile with the manifest's own field
// names (`branches`, `trails`, `rail`, `water.lines`) and record shapes (bake/vtiles.py), so a cell
// here is read exactly like a `vt/0` one. Branches carry `highway`; trails and rail `kind`; water
// lines `pts`. Only the first two coordinates of a point are used: the minimap is a plan view.
import type { Branch } from '../../world/site'

/** One polyline in the minimap's vocabulary: a class the worker's style table knows, and plan (x,y)
 *  pairs in site metres. */
export interface MapLine { cls: string; coords: [number, number][] }

/** The lines a minimap draws from one tile. A layer that is absent contributes nothing and a record
 *  with fewer than two points is skipped — a one-point "line" is a bad record, not a feature. */
export function mapLayersOf(tile: Record<string, unknown>): MapLine[] {
  const out: MapLine[] = []
  const xy = (coords: readonly (readonly number[])[] | undefined): [number, number][] => {
    const p: [number, number][] = []
    for (const c of coords ?? []) if (c.length >= 2) p.push([c[0], c[1]])
    return p
  }
  // roads: the drivable branches, classed by `highway` (the worker's CLASS_STYLE)
  for (const br of (tile.branches ?? []) as Branch[]) {
    if (!br.highway) continue
    const coords = xy(br.coords)
    if (coords.length > 1) out.push({ cls: br.highway, coords })
  }
  // trails and rail: their own layers (bake/export.py `_paths`), one style each
  for (const t of (tile.trails ?? []) as { coords?: number[][] }[]) {
    const coords = xy(t.coords)
    if (coords.length > 1) out.push({ cls: 'trail', coords })
  }
  for (const r of (tile.rail ?? []) as { coords?: number[][] }[]) {
    const coords = xy(r.coords)
    if (coords.length > 1) out.push({ cls: 'railway', coords })
  }
  // streams: `water.lines`, keyed `pts`
  const lines = (tile.water as { lines?: { pts?: number[][] }[] } | undefined)?.lines ?? []
  for (const w of lines) {
    const coords = xy(w.pts)
    if (coords.length > 1) out.push({ cls: 'waterway', coords })
  }
  return out
}
