// The OSM data dialog's map: which ground each Overpass instance holds, and where every world sits
// on it.
//
// ITS OWN SMALL CANVAS, ON THE MAIN MAP'S PROJECTION. `MapView` (map.ts) is the world-drawing map:
// a ring editor, a road picker and a tile loader, wired to the page's world state. This needs none
// of that and must not disturb it, so it borrows map.ts's Web Mercator (`project`) and draws its own
// handful of polygons. Pan with a drag — right, middle or Ctrl/Cmd-left pans even while a shape is
// being drawn — and zoom with the wheel about the cursor.
//
// HOW A PROBLEM LOOKS. A world is filled with the colour of the instance that serves it. A world no
// single instance holds is outlined in red and hatched. And while a `#s/w/n/e` fence is still on a
// URL, a world the fences would send to an instance that does not hold all of it has the MISSING
// PART filled red — computed on the canvas, not guessed: the world is painted red on a scratch layer
// and that instance's real coverage is cut out of it (`destination-out`), so what stays red is
// exactly the ground the old routing would have baked as empty. For dc-metro-take-2 against the
// Maryland instance that is Washington and everything across the Potomac.

import { project, unproject } from './map'
import type { BorderFeature, CoverageUpstream, CoverageWorld, GeoJsonPolygonal } from './api'
import { upstreamColour, worldVerdict } from './osmregions'

type Ring = number[][]

const polysOf = (g: GeoJsonPolygonal | undefined | null): Ring[][] => (!g ? [] : g.type === 'Polygon' ? [g.coordinates] : g.coordinates)

export class CoverageMap {
  centre = { lon: -77.0, lat: 39.0 }
  zoom = 5
  borders: BorderFeature[] = []
  upstreams: CoverageUpstream[] = []
  worlds: CoverageWorld[] = []
  preview: { geometry: GeoJsonPolygonal; label: string } | null = null
  /** upstreams switched off in the legend */
  hidden = new Set<string>()

  /* ---- drawing a region to build (osmdata.ts) ----
   *
   * The map is a canvas and a drag; a build needs a ring drawn on the same ground. So when
   * `drawing` is on a press becomes a vertex rather than a pan, and the ring is painted with the
   * coverage. `ring` is always `[lon,lat]` — the same pairs every other route in this app speaks —
   * and `onRing` is how the panel hears a vertex landed, the shape closed, or it was cleared. */
  drawing = false
  ring: [number, number][] = []
  onRing: ((ring: [number, number][], closed: boolean) => void) | null = null

  private canvas: HTMLCanvasElement
  private ctx: CanvasRenderingContext2D
  private scratch = document.createElement('canvas')
  private w = 1
  private h = 1
  private dpr = 1
  private frame = 0
  private drag: { x: number; y: number; cx: number; cy: number } | null = null
  /** a press while drawing, held until pointerup decides click-or-drag */
  private down: { x: number; y: number; moved: boolean } | null = null
  /** the cursor, in canvas pixels, for the rubber-band line */
  private cursor: { x: number; y: number } | null = null

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas
    this.ctx = canvas.getContext('2d')!
    // focusable so Backspace/Enter reach the dialog while a person is drawing
    canvas.tabIndex = 0
    new ResizeObserver(() => this.resize()).observe(canvas)
    canvas.addEventListener('pointerdown', (e) => {
      // Middle and right start a pan even while drawing: the shape and the ground beneath it are
      // separate questions, and a person mid-polygon often needs to shift the map without losing
      // corners. preventDefault keeps the middle button from autoscrolling and the right button
      // from opening its menu over the drag. Ctrl/Cmd-left pans too, as on the main map (map.ts).
      if (e.button === 1 || e.button === 2 || (e.button === 0 && (e.ctrlKey || e.metaKey))) {
        e.preventDefault()
        this.startPan(e)
        return
      }
      if (!this.drawing) {
        // not drawing: a plain drag pans, the same as everywhere else in the editor
        this.startPan(e)
        return
      }
      // a press while drawing is a vertex, not a pan — which one it was is decided on release
      this.down = { x: e.clientX, y: e.clientY, moved: false }
      canvas.focus()
    })
    canvas.addEventListener('pointermove', (e) => {
      // the rubber band follows the cursor whenever drawing, pan or no pan
      if (this.drawing) {
        const r = canvas.getBoundingClientRect()
        this.cursor = { x: e.clientX - r.left, y: e.clientY - r.top }
      } else {
        this.cursor = null
      }
      if (this.drag) {
        const s = 2 ** this.zoom
        this.centre = unproject(this.drag.cx - (e.clientX - this.drag.x) / s, this.drag.cy - (e.clientY - this.drag.y) / s)
        this.draw()
        return
      }
      if (this.drawing) {
        if (this.down && (Math.abs(e.clientX - this.down.x) > 4 || Math.abs(e.clientY - this.down.y) > 4)) this.down.moved = true
        this.draw()
      }
    })
    const end = () => {
      if (this.drag) {
        this.drag = null
        return
      }
      if (this.drawing) {
        const d = this.down
        this.down = null
        // a release that did not move is a click: put a vertex here (or close on the first one)
        if (d && !d.moved) this.tap(d.x, d.y)
        this.draw()
      }
    }
    canvas.addEventListener('pointerup', end)
    canvas.addEventListener('pointercancel', end)
    canvas.addEventListener('pointerleave', () => { this.cursor = null; this.draw() })
    // right-drag is a pan here, so the browser's own menu must not land on top of it
    canvas.addEventListener('contextmenu', (e) => e.preventDefault())
    // a double-click closes the shape; the two taps it fires first add two vertices at the same
    // spot, which `closeRing` drops before it closes
    canvas.addEventListener('dblclick', () => { if (this.drawing) this.closeRing() })
    canvas.addEventListener('wheel', (e) => {
      e.preventDefault()
      const r = canvas.getBoundingClientRect()
      const before = this.toLonLat(e.clientX - r.left, e.clientY - r.top)
      this.zoom = Math.max(1, Math.min(14, this.zoom - Math.sign(e.deltaY) * 0.5))
      // keep the point under the cursor where it was
      const after = this.toLonLat(e.clientX - r.left, e.clientY - r.top)
      const [cx, cy] = project(this.centre)
      const [bx, by] = project(before)
      const [ax, ay] = project(after)
      this.centre = unproject(cx + (bx - ax), cy + (by - ay))
      this.draw()
    }, { passive: false })
    this.resize()
  }

  /** Frame a lon/lat box with a margin. */
  fit(b: { south: number; west: number; north: number; east: number }) {
    const [x0, y1] = project({ lon: b.west, lat: b.south })
    const [x1, y0] = project({ lon: b.east, lat: b.north })
    const z = Math.log2(Math.min(this.w / Math.max(1e-9, x1 - x0), this.h / Math.max(1e-9, y1 - y0))) - 0.3
    this.zoom = Math.max(1, Math.min(13, z))
    this.centre = unproject((x0 + x1) / 2, (y0 + y1) / 2)
    this.draw()
  }

  private resize() {
    this.dpr = Math.min(2, devicePixelRatio || 1)
    const r = this.canvas.getBoundingClientRect()
    this.w = Math.max(1, Math.round(r.width))
    this.h = Math.max(1, Math.round(r.height))
    this.canvas.width = Math.round(this.w * this.dpr)
    this.canvas.height = Math.round(this.h * this.dpr)
    this.scratch.width = this.canvas.width
    this.scratch.height = this.canvas.height
    this.draw()
  }

  private toLonLat(x: number, y: number) {
    const [cx, cy] = project(this.centre)
    const s = 2 ** this.zoom
    return unproject(cx + (x - this.w / 2) / s, cy + (y - this.h / 2) / s)
  }

  private xy(lon: number, lat: number): [number, number] {
    const [cx, cy] = project(this.centre)
    const [x, y] = project({ lon, lat })
    const s = 2 ** this.zoom
    return [this.w / 2 + (x - cx) * s, this.h / 2 + (y - cy) * s]
  }

  /** Begin a pan: remember where the pointer and the centre projection started. */
  private startPan(e: PointerEvent) {
    const [cx, cy] = project(this.centre)
    this.drag = { x: e.clientX, y: e.clientY, cx, cy }
    this.canvas.setPointerCapture(e.pointerId)
    this.canvas.focus()
  }

  /** A click while drawing: close on the first vertex, otherwise drop a corner here. */
  private tap(clientX: number, clientY: number) {
    const r = this.canvas.getBoundingClientRect()
    const x = clientX - r.left
    const y = clientY - r.top
    if (this.ring.length >= 3) {
      const [fx, fy] = this.xy(this.ring[0][0], this.ring[0][1])
      if (Math.hypot(x - fx, y - fy) <= 10) {
        this.closeRing()
        return
      }
    }
    const ll = this.toLonLat(x, y)
    this.ring.push([ll.lon, ll.lat])
    this.onRing?.(this.ring, false)
  }

  /**
   * Close the shape. A double-click fires two taps first, so a duplicate tail is dropped before
   * the ring is handed over; fewer than three corners is not a ring and does nothing.
   */
  closeRing() {
    if (this.ring.length >= 2) {
      const [ax, ay] = this.ring[this.ring.length - 1]
      const [bx, by] = this.ring[this.ring.length - 2]
      if (ax === bx && ay === by) this.ring.pop()
    }
    if (this.ring.length < 3) return
    this.onRing?.(this.ring, true)
    this.draw()
  }

  /** Throw the ring away. */
  clearRing() {
    if (!this.ring.length) return
    this.ring = []
    this.onRing?.(this.ring, false)
    this.draw()
  }

  /** Backspace: drop the last corner. */
  removeLastVertex() {
    if (!this.ring.length) return
    this.ring.pop()
    this.onRing?.(this.ring, false)
    this.draw()
  }

  /**
   * Escape: throw the drawn area away and stop drawing — the end state of clicking the instance
   * again, but with the ring gone. True when there was something to cancel, so the caller knows
   * Escape was its to consume (osmdata.ts, ui/shell.ts).
   */
  cancelDraw(): boolean {
    if (!this.drawing && !this.ring.length) return false
    this.drawing = false
    this.down = null
    this.ring = []
    this.onRing?.(this.ring, false)
    this.draw()
    return true
  }

  private path(g: CanvasRenderingContext2D, polys: Ring[][]) {
    g.beginPath()
    for (const poly of polys) {
      for (const ring of poly) {
        ring.forEach(([lon, lat], i) => {
          const [x, y] = this.xy(lon, lat)
          if (i) g.lineTo(x, y)
          else g.moveTo(x, y)
        })
        g.closePath()
      }
    }
  }

  /** A world's footprint as polygons: its drawn ring, else the box the bake will ask about. */
  private footprint(w: CoverageWorld): Ring[][] {
    if (w.ring && w.ring.length >= 3) return [[[...w.ring, w.ring[0]]]]
    const b = w.box
    if (!b) return []
    return [[[[b.west, b.south], [b.east, b.south], [b.east, b.north], [b.west, b.north], [b.west, b.south]]]]
  }

  draw() {
    if (this.frame) return
    // rendering only — nothing waits on this frame (see map.ts on rAF in a background tab)
    this.frame = requestAnimationFrame(() => {
      this.frame = 0
      this.paint()
    })
  }

  /** for the probe: what the last paint drew */
  painted = { upstreams: 0, worlds: 0, missing: 0 }

  private paint() {
    const g = this.ctx
    this.canvas.style.cursor = this.drag ? 'grabbing' : this.drawing ? 'crosshair' : 'grab'
    const css = getComputedStyle(document.documentElement)
    const tok = (n: string, d: string) => css.getPropertyValue(n).trim() || d
    g.setTransform(this.dpr, 0, 0, this.dpr, 0, 0)
    g.fillStyle = tok('--bg-0', '#0d1014')
    g.fillRect(0, 0, this.w, this.h)

    // land, so the polygons have somewhere to be
    g.fillStyle = tok('--bg-2', '#1c232b')
    g.strokeStyle = tok('--line-2', '#3a4652')
    g.lineWidth = 0.6
    for (const f of this.borders) {
      this.path(g, polysOf(f.geometry as GeoJsonPolygonal))
      g.fill('evenodd')
      g.stroke()
    }

    // each instance's coverage, in its colour
    let nUp = 0
    this.upstreams.forEach((u, i) => {
      if (this.hidden.has(u.name)) return
      const c = upstreamColour(i)
      for (const r of u.regions) {
        if (!r.geometry) continue
        this.path(g, polysOf(r.geometry))
        g.fillStyle = `${c}22`
        g.fill('evenodd')
        g.strokeStyle = c
        g.lineWidth = 1.5
        g.setLineDash(r.source === 'fence' ? [6, 4] : [])
        g.stroke()
        g.setLineDash([])
        nUp++
      }
    })

    // worlds
    const danger = tok('--danger', '#e2685f')
    let nMissing = 0
    for (const w of this.worlds) {
      if (!w.placed) continue
      const fp = this.footprint(w)
      const v = worldVerdict(w)
      const ui = w.upstream ? this.upstreams.findIndex((u) => u.name === w.upstream) : -1
      this.path(g, fp)
      if (ui >= 0) {
        g.fillStyle = `${upstreamColour(ui)}66`
        g.fill('evenodd')
      }
      g.strokeStyle = v.kind === 'ok' ? (ui >= 0 ? upstreamColour(ui) : tok('--ink-2', '#a3b1bf')) : danger
      g.lineWidth = v.kind === 'ok' ? 2 : 2.5
      g.stroke()
      if (v.kind === 'mirrors') {
        g.save()
        this.path(g, fp)
        g.clip('evenodd')
        g.strokeStyle = `${danger}99`
        g.lineWidth = 1
        for (let k = -this.h; k < this.w; k += 9) {
          g.beginPath()
          g.moveTo(k, 0)
          g.lineTo(k + this.h, this.h)
          g.stroke()
        }
        g.restore()
      }
      // THE MISSING GROUND: the world, minus the real coverage of where the fences send it
      if (v.kind === 'misrouted' && w.fences?.upstream) {
        const up = this.upstreams.find((u) => u.name === w.fences!.upstream)
        const s = this.scratch.getContext('2d')!
        s.setTransform(this.dpr, 0, 0, this.dpr, 0, 0)
        s.clearRect(0, 0, this.w, this.h)
        this.path(s, fp)
        s.fillStyle = `${danger}cc`
        s.fill('evenodd')
        s.globalCompositeOperation = 'destination-out'
        for (const r of up?.regions ?? []) {
          if (!r.geometry) continue
          this.path(s, polysOf(r.geometry))
          s.fillStyle = '#000'
          s.fill('evenodd')
        }
        s.globalCompositeOperation = 'source-over'
        g.save()
        g.setTransform(1, 0, 0, 1, 0, 0)
        g.drawImage(this.scratch, 0, 0)
        g.restore()
        nMissing++
      }
      if (this.zoom >= 4) {
        const b = w.box
        if (b) {
          const [x, y] = this.xy(b.west, b.north)
          g.font = `600 11px ${tok('--font-body', 'sans-serif')}`
          g.fillStyle = v.kind === 'ok' ? tok('--ink-1', '#e6ecf2') : danger
          g.fillText(w.slug, x + 3, y - 4)
        }
      }
    }

    // the region a person is looking at in the picker
    if (this.preview) {
      this.path(g, polysOf(this.preview.geometry))
      g.fillStyle = 'rgba(255,255,255,0.10)'
      g.fill('evenodd')
      g.strokeStyle = tok('--ink-1', '#e6ecf2')
      g.setLineDash([5, 4])
      g.lineWidth = 1.5
      g.stroke()
      g.setLineDash([])
    }

    // THE RING BEING DRAWN for a build (osmdata.ts): the polyline and its handles, plus the
    // rubber band a person is pulling to the cursor. Above the coverage, because it is the thing
    // being claimed and everything under it is only where it lands.
    if (this.ring.length) {
      const bright = tok('--accent', '#4aa8e8')
      const pts = this.ring.map(([lon, lat]) => this.xy(lon, lat))
      g.beginPath()
      pts.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y)))
      if (this.ring.length >= 3) {
        g.closePath()
        g.fillStyle = `${bright}22`
        g.fill('evenodd')
      }
      g.strokeStyle = bright
      g.lineWidth = 2
      g.setLineDash([])
      g.stroke()
      if (this.drawing && this.cursor) {
        const [lx, ly] = pts[pts.length - 1]
        g.beginPath()
        g.moveTo(lx, ly)
        g.lineTo(this.cursor.x, this.cursor.y)
        if (this.ring.length >= 2) {
          // and the end of the rubber band back to the first corner: the shape as it would close
          g.moveTo(this.cursor.x, this.cursor.y)
          g.lineTo(pts[0][0], pts[0][1])
        }
        g.setLineDash([5, 4])
        g.lineWidth = 1.5
        g.stroke()
        g.setLineDash([])
      }
      g.fillStyle = bright
      for (const [x, y] of pts) {
        g.beginPath()
        g.arc(x, y, 3.5, 0, Math.PI * 2)
        g.fill()
      }
    }
    this.painted = { upstreams: nUp, worlds: this.worlds.filter((w) => w.placed).length, missing: nMissing }
  }
}
