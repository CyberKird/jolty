// The cables of the activity board and the transfer between places: WebGL when there is one, the 2D painting otherwise.
import { useEffect, useRef, useState, type RefObject } from 'react'
import { ROPES, STRANDS, easeOut, liveCurve, rope, sparks, sparksFor, strandLines, type Paint, type Spark } from './activity-canvas'
import { CableGL, sample } from './activity-gl'
import { BOTTOM_Y, CORE, NODES, ROPE, ROUTES, STUB, TOP_Y, W, laneEnd, type Node, type P } from './activity-geometry'

// ---- the cables: on the graphics chip (activity-gl.ts) with the glitter flowing out of the light at 30 frames a second; without WebGL,
// or with low-power mode or reduced motion, painted still. Every cable is drawn as the whole route from the light to its tile: the narrow
// side branches first, then the full ropes that end at a lane's last tile over them, so branches come out from under the bundle and no
// cable ends in a stub on a corner. Same route, same start, same grain: where cables overlap they match. ----
const LIVE_FROM: P = { x: CORE.x + 4, y: CORE.y }
const STRAND_W = 3.3
const CONVERGE_MS = 560
export const ARRIVE_MS = 1000
const LEAVE_MS = 280
const SETTLE_MS = 180
const FLOW = 24 // board units a second, as measured in the reference
const FRAME_MS = 1000 / 30

interface Live {
  node: Node
  at: number
  line: P[]
  sparks: Spark[]
}

// branches (narrow) first, then the routes that end a lane at full width
const CABLES = [...NODES.filter((n) => n.x !== laneEnd(n.lane)), ...NODES.filter((n) => n.x === laneEnd(n.lane))].map((n) => ({
  d: ROUTES[n.id].stub,
  lane: n.lane,
  width: n.x === laneEnd(n.lane) ? ROPE : STUB
}))

const still = (): boolean => {
  const c = document.documentElement.classList
  return c.contains('low-power') || c.contains('reduce-motion')
}

export function useCables(target: Node | null): {
  box: RefObject<HTMLDivElement | null>
  cv: RefObject<HTMLCanvasElement | null>
  fx: RefObject<HTMLCanvasElement | null>
  arriving: Node | null
} {
  const box = useRef<HTMLDivElement>(null)
  const cv = useRef<HTMLCanvasElement>(null)
  const fx = useRef<HTMLCanvasElement>(null)
  const st = useRef<{ cur: Live | null; old: Live | null; raf: number; k: number; dpr: number; gl: CableGL | null | undefined; t0: number; last: number; padK: number }>({
    cur: null,
    old: null,
    raf: 0,
    k: 1,
    dpr: 1,
    gl: undefined,
    t0: performance.now(),
    last: 0,
    padK: 0
  })
  const [arriving, setArriving] = useState<Node | null>(null)
  // a place that lights for a blink (a quick read between two thoughts) does not move the rope
  const [settled, setSettled] = useState<Node | null>(null)
  useEffect(() => {
    const t = setTimeout(() => setSettled(target), target === null ? SETTLE_MS * 2 : SETTLE_MS)
    return () => clearTimeout(t)
  }, [target])

  /** The live rope at `now`: the strands of the current place closing up, the old ones opening and fading. */
  const liveRopes = (now: number): { lines: P[][]; alpha: number }[] => {
    const s = st.current
    const out: { lines: P[][]; alpha: number }[] = []
    if (s.old) {
      const q = (now - s.old.at) / LEAVE_MS
      if (q < 1) out.push({ lines: strandLines(s.old.line, easeOut(q) * 0.8, STRAND_W), alpha: 1 - easeOut(q) })
      else s.old = null
    }
    if (s.cur) {
      const q = Math.max(0, (now - s.cur.at) / CONVERGE_MS)
      out.push({ lines: strandLines(s.cur.line, 1 - easeOut(q), STRAND_W), alpha: Math.min(1, 0.35 + q * 2.5) })
    }
    return out
  }

  /** Paints the frame at `now`; true while the transfer still moves (the 2D board stops drawing then). */
  const paint = (now: number, flowing: boolean): boolean => {
    const s = st.current
    const c = cv.current
    if (!c) return false
    if (s.gl === undefined) {
      s.gl = CableGL.create(c)
      s.padK = 0
    }
    const live = liveRopes(now)
    let busy = !!s.old || (!!s.cur && now - s.cur.at < ARRIVE_MS)
    if (s.gl) {
      const pad = 0.7 + 2 / s.k
      if (s.padK !== s.k) {
        s.gl.setStatic(
          CABLES.map((x) => ({ pts: sample(x.d), width: x.width, pal: ROPES[x.lane] })),
          pad
        )
        s.padK = s.k
      }
      const t = flowing ? (now - s.t0) / 1000 : 0
      s.gl.frame({
        time: t % 600,
        flow: (t * FLOW) % 6000,
        k: s.k,
        width: c.width,
        height: c.height,
        under: live.flatMap((r) => r.lines.map((pts, i) => ({ pts, width: STRAND_W, pal: STRANDS[i], alpha: r.alpha })))
      })
    } else {
      const ctx = c.getContext('2d')
      if (ctx) {
        ctx.setTransform(1, 0, 0, 1, 0, 0)
        ctx.clearRect(0, 0, c.width, c.height)
        ctx.setTransform(s.k, 0, 0, s.k, 0, 0)
        const pt: Paint = { ctx, k: s.k, dpr: s.dpr, seed: 1 }
        for (const r of live)
          r.lines.forEach((pts, i) => {
            const path = new Path2D()
            pts.forEach((q, j) => (j ? path.lineTo(q.x, q.y) : path.moveTo(q.x, q.y)))
            rope(pt, path, STRANDS[i], STRAND_W, r.alpha)
          })
        for (const x of CABLES) rope(pt, new Path2D(x.d), ROPES[x.lane], x.width)
      }
    }
    const f = fx.current
    const fctx = f?.getContext('2d')
    if (f && fctx) {
      fctx.setTransform(1, 0, 0, 1, 0, 0)
      fctx.clearRect(0, 0, f.width, f.height)
      if (s.cur) {
        const q = (now - s.cur.at) / ARRIVE_MS
        if (q < 1) {
          fctx.setTransform(s.k, 0, 0, s.k, 0, 0)
          sparks({ ctx: fctx, k: s.k, dpr: s.dpr, seed: 0 }, s.cur.sparks, q)
        }
      }
    }
    return busy
  }

  // one loop: 30 frames a second while the glitter flows (WebGL), only during a transfer otherwise, nothing while the window is hidden
  const run = (): void => {
    const s = st.current
    cancelAnimationFrame(s.raf)
    s.raf = 0
    if (still()) {
      s.old = null
      if (s.cur) s.cur.at = -1e9
      paint(performance.now(), false)
      return
    }
    const tick = (now: number): void => {
      if (now - s.last < FRAME_MS - 2) {
        s.raf = requestAnimationFrame(tick)
        return
      }
      s.last = now
      // low-power or reduced motion switched on while the board is open: hold still at once
      if (still()) return run()
      const busy = paint(now, true)
      if (s.gl || busy) s.raf = requestAnimationFrame(tick)
      else s.raf = 0
    }
    s.raf = requestAnimationFrame(tick)
  }

  // the size: the canvases follow the board at the screen's pixel density
  useEffect(() => {
    const el = box.current
    if (!el) return
    const ro = new ResizeObserver(() => {
      const r = el.getBoundingClientRect()
      const dpr = Math.min(2, window.devicePixelRatio || 1)
      const s = st.current
      s.dpr = dpr
      s.k = (r.width * dpr) / W
      for (const c of [cv.current, fx.current]) {
        if (!c) continue
        c.width = Math.max(1, Math.round(r.width * dpr))
        c.height = Math.max(1, Math.round(r.height * dpr))
      }
      if (!s.raf) run()
    })
    ro.observe(el)
    const vis = (): void => {
      if (document.hidden) {
        cancelAnimationFrame(st.current.raf)
        st.current.raf = 0
      } else run()
    }
    document.addEventListener('visibilitychange', vis)
    return () => {
      ro.disconnect()
      document.removeEventListener('visibilitychange', vis)
      cancelAnimationFrame(st.current.raf)
      st.current.raf = 0
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // the transfer
  useEffect(() => {
    const s = st.current
    if ((s.cur?.node ?? null) === settled) return
    const now = performance.now()
    s.old = s.cur ? { ...s.cur, at: now } : null
    if (settled) {
      const def = NODES.find((n) => n.id === settled)!
      const centre = { x: def.x, y: def.row === 'top' ? TOP_Y : BOTTOM_Y }
      s.cur = { node: settled, at: now, line: liveCurve(LIVE_FROM, ROUTES[settled].end), sparks: sparksFor(centre, 14, def.x * 31 + (def.row === 'top' ? 7 : 3)) }
      setArriving(settled)
    } else s.cur = null
    if (!s.raf) run()
    const t = setTimeout(() => setArriving(null), ARRIVE_MS)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settled])

  return { box, cv, fx, arriving }
}
