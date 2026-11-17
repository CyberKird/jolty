// The light on the activity board's fibres, painted on one small canvas. Two things move, and only while they mean something:
//  - a packet: every time a place is used (its count goes up) one short bright pulse runs from the core to that tile (from the tile to the
//    core for "you": the message travels to the model); the tile's count ticks when it lands (ActivityGraph delays the tick by travelMs);
//  - a train: while the model works somewhere, pulses run steadily along that route.
// Their speed follows the throughput (how many calls in the last seconds). Nothing is drawn when nothing moves: idle costs nothing, the
// loop is capped at 30 frames a second, stops when the window is hidden or the board is off screen, and is off with low-power mode or
// reduced motion (the lit route and the tiles still show the same state).
import { useEffect, useRef, type RefObject } from 'react'
import { NODES, ROUTES, W, sample, type Node, type P } from './activity-geometry'

const FRAME_MS = 1000 / 30
const BASE_SPEED = 120 // board units a second
const TRAIN_GAP = 52
const TAIL = 20

interface Route {
  pts: P[]
  len: number
}
interface Packet {
  node: Node
  at: number
  back: boolean
}

let routes: Record<Node, Route> | null = null
const routeOf = (n: Node): Route => {
  if (!routes) routes = Object.fromEntries(NODES.map((d) => [d.id, sample(ROUTES[d.id])])) as Record<Node, Route>
  return routes[n]
}

const still = (): boolean => {
  const c = document.documentElement.classList
  return c.contains('low-power') || c.contains('reduce-motion')
}

/** How long a packet takes to reach `node` at `speed` (a multiple of the base speed), in ms. */
export const travelMs = (node: Node, speed: number): number => (routeOf(node).len / (BASE_SPEED * speed)) * 1000

function at(r: Route, s: number): P {
  const i = Math.max(0, Math.min(r.pts.length - 1, Math.round((s / r.len) * (r.pts.length - 1))))
  return r.pts[i]
}

export function usePulses(o: { target: Node | null; counts: Record<Node, number>; speed: number }): {
  box: RefObject<HTMLDivElement | null>
  cv: RefObject<HTMLCanvasElement | null>
} {
  const box = useRef<HTMLDivElement>(null)
  const cv = useRef<HTMLCanvasElement>(null)
  const st = useRef({ raf: 0, last: 0, k: 1, packets: [] as Packet[], target: o.target, speed: o.speed, t0: performance.now(), seen: false, ink: '', head: '' })
  st.current.target = o.target
  st.current.speed = o.speed

  const paint = (now: number): boolean => {
    const s = st.current
    const c = cv.current
    const ctx = c?.getContext('2d')
    if (!c || !ctx) return false
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.clearRect(0, 0, c.width, c.height)
    ctx.setTransform(s.k, 0, 0, s.k, 0, 0)
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'
    const v = BASE_SPEED * s.speed
    s.packets = s.packets.filter((p) => (now - p.at) / 1000 * v < routeOf(p.node).len + TAIL)
    const pulse = (r: Route, d: number, back: boolean, alpha: number): void => {
      // a bright head and a tail that thins and fades behind it, along the fibre
      const dir = back ? -1 : 1
      const head = back ? r.len - d : d
      const steps = 7
      for (let i = 0; i < steps; i++) {
        const a0 = head - dir * (TAIL * (i + 1)) / steps
        const a1 = head - dir * (TAIL * i) / steps
        if ((a0 < 0 && a1 < 0) || (a0 > r.len && a1 > r.len)) continue
        const p0 = at(r, Math.max(0, Math.min(r.len, a0)))
        const p1 = at(r, Math.max(0, Math.min(r.len, a1)))
        ctx.globalAlpha = alpha * (1 - i / steps) * 0.9
        ctx.lineWidth = 1.5 * (1 - i / (steps * 1.4))
        ctx.strokeStyle = s.ink
        ctx.beginPath()
        ctx.moveTo(p0.x, p0.y)
        ctx.lineTo(p1.x, p1.y)
        ctx.stroke()
      }
      if (head < 0 || head > r.len) return
      const h = at(r, head)
      ctx.globalAlpha = alpha * 0.22
      ctx.fillStyle = s.ink
      ctx.beginPath()
      ctx.arc(h.x, h.y, 3.6, 0, Math.PI * 2)
      ctx.fill()
      ctx.globalAlpha = alpha
      ctx.fillStyle = s.head
      ctx.beginPath()
      ctx.arc(h.x, h.y, 1.25, 0, Math.PI * 2)
      ctx.fill()
    }
    for (const p of s.packets) pulse(routeOf(p.node), ((now - p.at) / 1000) * v, p.back, 1)
    if (s.target) {
      const r = routeOf(s.target)
      const back = s.target === 'you'
      const off = (((now - s.t0) / 1000) * v * 0.55) % TRAIN_GAP
      for (let d = off; d < r.len + TAIL; d += TRAIN_GAP) {
        // softer than a packet, fading in off the core and out into the tile
        const edge = Math.min(1, d / 24, (r.len + TAIL - d) / 30)
        pulse(r, d, back, 0.55 * Math.max(0, edge))
      }
    }
    ctx.globalAlpha = 1
    return s.packets.length > 0 || !!s.target
  }

  const run = (): void => {
    const s = st.current
    cancelAnimationFrame(s.raf)
    s.raf = 0
    const c = cv.current
    if (!c || !s.seen || document.hidden) return
    if (still()) {
      s.packets = []
      c.getContext('2d')?.clearRect(0, 0, c.width, c.height)
      return
    }
    // the theme's light, read once per run (a theme change restarts it through the class change on <html>)
    const cs = getComputedStyle(c)
    s.ink = cs.getPropertyValue('--ag-pulse').trim() || '#ffffff'
    s.head = cs.getPropertyValue('--ag-pulse-head').trim() || '#ffffff'
    const tick = (now: number): void => {
      if (now - s.last < FRAME_MS - 2) {
        s.raf = requestAnimationFrame(tick)
        return
      }
      s.last = now
      if (still()) return run()
      s.raf = paint(now) ? requestAnimationFrame(tick) : 0
    }
    s.raf = requestAnimationFrame(tick)
  }

  // new calls: one packet each to the place that was used
  const prev = useRef<Record<Node, number> | null>(null)
  useEffect(() => {
    const before = prev.current
    prev.current = { ...o.counts }
    if (!before) return
    const now = performance.now()
    let added = false
    for (const n of NODES) {
      const more = Math.min(3, o.counts[n.id] - (before[n.id] ?? 0))
      // several at once leave one after the other
      for (let i = 0; i < more; i++) {
        st.current.packets.push({ node: n.id, at: now + i * 120, back: n.id === 'you' })
        added = true
      }
    }
    if (added && !st.current.raf) run()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [o.counts])

  useEffect(() => {
    if (!st.current.raf) run()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [o.target])

  // size, visibility on screen, window hidden, low-power or theme switched
  useEffect(() => {
    const el = box.current
    if (!el) return
    const ro = new ResizeObserver(() => {
      const r = el.getBoundingClientRect()
      const dpr = Math.min(2, window.devicePixelRatio || 1)
      const s = st.current
      s.k = (r.width * dpr) / W
      const c = cv.current
      if (c) {
        c.width = Math.max(1, Math.round(r.width * dpr))
        c.height = Math.max(1, Math.round(r.height * dpr))
      }
      run()
    })
    ro.observe(el)
    const io = new IntersectionObserver(([e]) => {
      st.current.seen = e.isIntersecting
      run()
    })
    io.observe(el)
    const vis = (): void => run()
    document.addEventListener('visibilitychange', vis)
    const mo = new MutationObserver(() => run())
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'data-theme'] })
    return () => {
      ro.disconnect()
      io.disconnect()
      mo.disconnect()
      document.removeEventListener('visibilitychange', vis)
      cancelAnimationFrame(st.current.raf)
      st.current.raf = 0
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return { box, cv }
}
