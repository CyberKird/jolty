// How a person moves a mouse and types, as pure functions: every one takes an RNG, so a seeded run is
// reproducible in tests. Nothing here touches the machine; plan.ts turns these into timed input events.
export type Humanness = 'max' | 'normal' | 'fast'
export type Rng = () => number

/** A small seedable generator (mulberry32). */
export function makeRng(seed: number): Rng {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export const between = (r: Rng, lo: number, hi: number): number => lo + (hi - lo) * r()
export const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v))

/** Standard normal (Box-Muller). */
export function gauss(r: Rng): number {
  const u = Math.max(r(), 1e-12)
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * r())
}

/** Lognormal with the given median and log-space sigma. */
export const lognormal = (r: Rng, median: number, sigma: number): number => median * Math.exp(sigma * gauss(r))

export interface Pt {
  x: number
  y: number
}
export interface PathPoint extends Pt {
  /** milliseconds from the start of the movement */
  t: number
}

/** Pace of everything: Max looks like a person, Fast is a quick smooth move with no extras. */
const PACE: Record<Humanness, number> = { max: 1, normal: 0.6, fast: 0.2 }

/** Fitts's law: time to hit a target of `width` px at `distance` px. */
export function fittsMs(distance: number, width: number, mode: Humanness, r: Rng): number {
  const w = Math.max(width, 4)
  const base = 100 + 120 * Math.log2(distance / w + 1)
  const t = base * PACE[mode] * Math.exp(0.1 * gauss(r))
  return clamp(t, mode === 'fast' ? 50 : 140, mode === 'fast' ? 600 : 1800)
}

/** Minimum-jerk position profile: 0 to 1, zero speed and acceleration at both ends. */
export const minJerk = (t: number): number => {
  const x = clamp(t, 0, 1)
  return x * x * x * (10 - 15 * x + 6 * x * x)
}

const cubic = (p0: Pt, p1: Pt, p2: Pt, p3: Pt, s: number): Pt => {
  const u = 1 - s
  const a = u * u * u
  const b = 3 * u * u * s
  const c = 3 * u * s * s
  const d = s * s * s
  return { x: a * p0.x + b * p1.x + c * p2.x + d * p3.x, y: a * p0.y + b * p1.y + c * p2.y + d * p3.y }
}

/** Sample times, about 125 Hz with a little variation. */
function sampleTimes(total: number, r: Rng): number[] {
  const out = [0]
  let t = 0
  while (true) {
    t += between(r, 6.5, 9.5)
    if (t >= total - 3) break
    out.push(t)
  }
  out.push(total)
  return out
}

/** One curved, eased stretch from a to b taking `ms`; `noise` is the hand-jitter amplitude in px. */
function stretch(a: Pt, b: Pt, ms: number, r: Rng, curve: number, noise: number): PathPoint[] {
  const dx = b.x - a.x
  const dy = b.y - a.y
  const d = Math.hypot(dx, dy)
  const ux = dx / d
  const uy = dy / d
  const nx = -uy
  const ny = ux
  const side = r() < 0.5 ? -1 : 1
  const bend = (k: number): number => Math.min(d * k, 260) * curve
  // an S-shape now and then, otherwise one gentle arc
  const o1 = side * bend(between(r, 0.04, 0.14))
  const o2 = (r() < 0.25 ? -side : side) * bend(between(r, 0.02, 0.1))
  const f1 = between(r, 0.2, 0.35)
  const f2 = between(r, 0.62, 0.8)
  const p1 = { x: a.x + ux * d * f1 + nx * o1, y: a.y + uy * d * f1 + ny * o1 }
  const p2 = { x: a.x + ux * d * f2 + nx * o2, y: a.y + uy * d * f2 + ny * o2 }
  // people speed up a little faster than they slow down: warp time slightly
  const warp = between(r, 0.88, 1.08)
  const waves = [0, 1, 2].map(() => ({ f: between(r, 0.006, 0.016), ph: between(r, 0, 6.28), ax: between(r, 0.3, 1), ay: between(r, 0.3, 1) }))
  const times = sampleTimes(ms, r)
  return times.map((t) => {
    const tau = t / ms
    const p = cubic(a, p1, p2, b, minJerk(Math.pow(tau, warp)))
    const env = Math.sin(Math.PI * tau)
    let jx = 0
    let jy = 0
    for (const w of waves) {
      const s = Math.sin(t * w.f * 2 * Math.PI + w.ph)
      jx += s * w.ax
      jy += s * w.ay
    }
    return { x: p.x + (jx * noise * env) / 3, y: p.y + (jy * noise * env) / 3, t }
  })
}

export interface PathOptions {
  mode: Humanness
  rng: Rng
  /** size of the target in px: the smaller, the slower the approach */
  width?: number
}

/**
 * The route of the pointer from `from` to `to`: a curve with randomized control points, eased in and out
 * (minimum jerk), paced by Fitts's law, with a faint hand tremor and, on long moves, a small overshoot that
 * is corrected. Starts at `from` and ends exactly on `to`; timestamps only go up.
 */
export function mousePath(from: Pt, to: Pt, o: PathOptions): PathPoint[] {
  const a = { x: Math.round(from.x), y: Math.round(from.y) }
  const b = { x: Math.round(to.x), y: Math.round(to.y) }
  const d = Math.hypot(b.x - a.x, b.y - a.y)
  if (d < 1) return [{ ...a, t: 0 }]
  const r = o.rng
  const total = fittsMs(d, o.width ?? 24, o.mode, r)
  let pts: PathPoint[]
  if (o.mode === 'fast') pts = stretch(a, b, total, r, 0.15, 0)
  else {
    const noise = o.mode === 'max' ? 0.9 : 0.4
    const overshoot = o.mode === 'max' && d > 350 && r() < 0.35
    if (overshoot) {
      const ux = (b.x - a.x) / d
      const uy = (b.y - a.y) / d
      const o1 = clamp(2 + d * 0.012 + between(r, 0, 6), 3, 16)
      const lateral = between(r, -3, 3)
      const far = { x: b.x + ux * o1 - uy * lateral, y: b.y + uy * o1 + ux * lateral }
      const first = stretch(a, far, total * 0.9, r, 1, noise)
      const back = stretch(far, b, between(r, 110, 220), r, 0.3, noise * 0.4)
      const t0 = first[first.length - 1].t + between(r, 20, 60)
      pts = [...first, ...back.slice(1).map((p) => ({ ...p, t: p.t + t0 }))]
    } else pts = stretch(a, b, total, r, 1, noise)
  }
  const out: PathPoint[] = []
  for (const p of pts) {
    const q = { x: Math.round(p.x), y: Math.round(p.y), t: Math.round(p.t * 10) / 10 }
    const last = out[out.length - 1]
    if (last && last.x === q.x && last.y === q.y) continue
    if (last && q.t <= last.t) q.t = last.t + 0.1
    out.push(q)
  }
  const end = out[out.length - 1]
  if (end.x !== b.x || end.y !== b.y) out.push({ ...b, t: end.t + 8 })
  out[0] = { ...a, t: 0 }
  return out
}

/**
 * Where inside a target the click lands: a gaussian around the point, narrow when the target is small.
 * Without a size the spread is about a pixel; with one it grows with the target but stays well inside it.
 */
export function clickOffset(r: Rng, mode: Humanness, w?: number, h?: number): Pt {
  if (mode === 'fast') return { x: 0, y: 0 }
  const size = w && h ? Math.min(w, h) : 0
  const sigma = size ? clamp(size / 10, 0.6, 4) : 1
  const lim = size ? Math.max(0.5, size * 0.3) : 2
  return { x: Math.round(clamp(gauss(r) * sigma, -lim, lim)), y: Math.round(clamp(gauss(r) * sigma, -lim, lim)) }
}

/** The pause of someone looking at a screen before they act. */
export function readingPauseMs(mode: Humanness, r: Rng): number {
  if (mode === 'fast') return 0
  return clamp(lognormal(r, mode === 'max' ? 520 : 200, 0.4), 80, 1400)
}

/** Timings of one click: dwell before it, how long the button stays down, and the gap between clicks of a double click. */
export function clickTimes(mode: Humanness, r: Rng): { dwell: number; hold: number; gap: number } {
  if (mode === 'fast') return { dwell: 10, hold: 30, gap: 60 }
  const k = mode === 'max' ? 1 : 0.6
  return { dwell: between(r, 40, 160) * k, hold: between(r, 50, 110) * k, gap: between(r, 80, 140) * k }
}

// ------------------------------------------------------------------ typing
const NEXT = new Set('th he in er an re on at en nd ti es or te of ed is it al ar st to nt ng se ha as ou io le ve co me de hi ri ro ic ne ea ra ce li ch ll be ma si om ur'.split(' '))

const ROWS = ['qwertyuiop', 'asdfghjkl', 'zxcvbnm']
/** Keys beside a letter on a QWERTY keyboard: where a finger slips. */
export function neighbours(ch: string): string[] {
  const lower = ch.toLowerCase()
  for (let i = 0; i < ROWS.length; i++) {
    const j = ROWS[i].indexOf(lower)
    if (j < 0) continue
    const out = [ROWS[i][j - 1], ROWS[i][j + 1]]
    for (const k of [i - 1, i + 1]) if (ROWS[k]) out.push(ROWS[k][j], ROWS[k][j + (k < i ? 1 : -1)])
    return out.filter(Boolean)
  }
  return []
}

/** One key press in a typing schedule: wait `delay` after the previous one, then tap the key for `hold` ms. */
export interface TypeStep {
  /** a character, or "\b" for Backspace, "\n" for Enter, "\t" for Tab */
  ch: string
  delay: number
  hold: number
}

export interface TypeOptions {
  mode: Humanness
  rng: Rng
  /** rare slips that are noticed and corrected */
  typos?: boolean
}

const isLetter = (c: string | undefined): boolean => Boolean(c) && /\p{L}/u.test(c as string)

/** Per-key delays in the way people type: lognormal rhythm, quick common pairs, bursts, longer pauses at word and sentence ends. */
export function typeSteps(text: string, o: TypeOptions): TypeStep[] {
  const r = o.rng
  const chars = [...text.replace(/\r\n?/g, '\n')]
  const median = o.mode === 'max' ? 105 : o.mode === 'normal' ? 55 : 6
  const sigma = o.mode === 'fast' ? 0.2 : 0.35
  const out: TypeStep[] = []
  let burst = 0
  const delayFor = (prev: string | undefined, ch: string): number => {
    let d = lognormal(r, median, sigma)
    if (o.mode === 'fast') return d
    if (prev && NEXT.has((prev + ch).toLowerCase())) d *= 0.7
    if (prev === ch) d *= 0.85
    if (ch !== ch.toLowerCase()) d += between(r, 15, 40)
    if (burst > 0) {
      d *= 0.6
      burst--
    } else if (r() < 0.12) burst = Math.floor(between(r, 3, 7))
    if (prev === ' ' && o.mode === 'max' && r() < 0.03) d += between(r, 350, 1100)
    if (ch === ' ' || ch === '\n') d += between(r, 0, 60)
    if (prev === ' ' && ch !== ' ') d += between(r, 25, 110)
    return clamp(d, 35, 1400)
  }
  const gap = (prev: string | undefined, before: string | undefined, ch: string): number => {
    // the pause belongs to the boundary: after a comma, a full stop or a line break
    let d = delayFor(prev, ch)
    if (o.mode === 'fast') return d
    const k = o.mode === 'max' ? 1 : 0.5
    if (prev === ',' || prev === ';' || prev === ':') d += between(r, 70, 240) * k
    if (prev === ' ' && before && /[.!?]/.test(before)) d += between(r, 220, 650) * k
    if (prev === '\n') d += between(r, 150, 480) * k
    return d
  }
  const hold = (): number => (o.mode === 'fast' ? 5 : clamp(lognormal(r, o.mode === 'max' ? 70 : 50, 0.3), 30, 140))
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i]
    const prev = chars[i - 1]
    const eligible = o.typos && o.mode === 'max' && isLetter(ch) && isLetter(prev) && isLetter(chars[i + 1]) && neighbours(ch).length > 0
    if (eligible && r() < 0.012) {
      // a slip: the wrong neighbour key, then up to two more characters before it is noticed
      const wrong = neighbours(ch)[Math.floor(r() * neighbours(ch).length)]
      const typed = ch === ch.toLowerCase() ? wrong : wrong.toUpperCase()
      const more = Math.min(Math.floor(between(r, 0, 3)), chars.length - i - 1)
      out.push({ ch: typed, delay: gap(prev, chars[i - 2], ch), hold: hold() })
      for (let k = 1; k <= more; k++) out.push({ ch: chars[i + k], delay: gap(chars[i + k - 1], undefined, chars[i + k]), hold: hold() })
      for (let k = 0; k <= more; k++) out.push({ ch: '\b', delay: k === 0 ? between(r, 160, 420) : between(r, 60, 130), hold: hold() })
      for (let k = 0; k <= more; k++) out.push({ ch: chars[i + k], delay: k === 0 ? between(r, 70, 170) : gap(chars[i + k - 1], undefined, chars[i + k]), hold: hold() })
      i += more
      continue
    }
    out.push({ ch, delay: i === 0 ? 0 : gap(prev, chars[i - 2], ch), hold: hold() })
  }
  return out
}

/** Notches for a scroll of `n` wheel clicks: quick at first, then slowing a little, like a flick of the finger. */
export function scrollGaps(n: number, mode: Humanness, r: Rng): number[] {
  const gaps: number[] = []
  const base = mode === 'fast' ? 8 : mode === 'normal' ? 22 : 34
  for (let i = 0; i < n; i++) {
    const slow = mode === 'fast' ? 1 : 1 + (n > 1 ? (i / (n - 1)) * 2.2 : 0)
    gaps.push(i === 0 ? 0 : base * slow * between(r, 0.85, 1.2))
  }
  return gaps
}
