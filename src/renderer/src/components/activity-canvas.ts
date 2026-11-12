// The cables of the activity board, painted on a canvas so they look like the reference: glitter ropes made of dense random grain (not
// dashes), a dark edge and a soft highlight down the middle. The board is painted twice with different grain into two canvases; the
// top one fades in and out (CSS opacity), which makes the glitter twinkle while the graphics chip does all the work.
//
// The transfer, as in the reference video (measured frame by frame at 30 fps): when the model starts working somewhere new, three warm
// strands leave the light at the centre and run straight to that place, spread apart at first and pulled together into one rope in about
// half a second; the place itself gathers out of a cloud of square sparks in about a second. Frames are drawn only while that runs.

export type Pt = { x: number; y: number }

export interface Palette {
  base: string
  dark: string
  light: string
  spark: string
}

export const ROPES: Palette[] = [
  { base: '#d4583a', dark: '#8f2c1c', light: '#ff9a6e', spark: '#ffe0c8' },
  { base: '#c99a3e', dark: '#7c5a1e', light: '#f3d27c', spark: '#fff4d0' },
  { base: '#c8c5d6', dark: '#7d7a90', light: '#f4f2ff', spark: '#ffffff' },
  { base: '#7d72d8', dark: '#463c9c', light: '#b6acff', spark: '#ece8ff' }
]
// the three warm strands of the live rope
export const STRANDS: Palette[] = [
  { base: '#d9503a', dark: '#8c241a', light: '#ff8f6a', spark: '#ffd9c8' },
  { base: '#e2843a', dark: '#94501a', light: '#ffb878', spark: '#ffe8cc' },
  { base: '#d6ad48', dark: '#82621e', light: '#f6d886', spark: '#fff6d6' }
]

const hex = (c: string): [number, number, number] => [parseInt(c.slice(1, 3), 16), parseInt(c.slice(3, 5), 16), parseInt(c.slice(5, 7), 16)]

function prng(seed: number): () => number {
  let s = seed % 2147483647 || 1
  return () => ((s = (s * 16807) % 2147483647) - 1) / 2147483646
}

// one tile of grain per palette, seed and pixel ratio; small, made once
const tiles = new Map<string, HTMLCanvasElement>()
function grain(p: Palette, seed: number, dpr: number): HTMLCanvasElement {
  const key = `${p.base}|${seed}|${dpr}`
  const hit = tiles.get(key)
  if (hit) return hit
  const cell = Math.max(1, Math.round(1.15 * dpr))
  const n = 56
  const c = document.createElement('canvas')
  c.width = c.height = n * cell
  const g = c.getContext('2d')!
  const img = g.createImageData(c.width, c.height)
  const rnd = prng(seed * 7919 + p.base.charCodeAt(1) * 131 + p.base.charCodeAt(3))
  const cols = [hex(p.dark), hex(p.base), hex(p.light), hex(p.spark)]
  for (let y = 0; y < n; y++)
    for (let x = 0; x < n; x++) {
      const r = rnd()
      // mostly the body colour with a spread of light and dark grains, a few bright glints
      const pick = r < 0.22 ? 0 : r < 0.62 ? 1 : r < 0.95 ? 2 : 3
      const [cr, cg, cb] = cols[pick]
      const v = 0.78 + rnd() * 0.36
      for (let dy = 0; dy < cell; dy++)
        for (let dx = 0; dx < cell; dx++) {
          const i = ((y * cell + dy) * c.width + x * cell + dx) * 4
          img.data[i] = Math.min(255, cr * v)
          img.data[i + 1] = Math.min(255, cg * v)
          img.data[i + 2] = Math.min(255, cb * v)
          img.data[i + 3] = 255
        }
    }
  g.putImageData(img, 0, 0)
  tiles.set(key, c)
  return c
}

export interface Paint {
  ctx: CanvasRenderingContext2D
  /** board units to device pixels */
  k: number
  dpr: number
  seed: number
}

function pattern(pt: Paint, p: Palette): CanvasPattern {
  const pat = pt.ctx.createPattern(grain(p, pt.seed, pt.dpr), 'repeat')!
  pat.setTransform(new DOMMatrix().scale(1 / pt.k))
  return pat
}

/** One glitter rope along a path: dark edge, grain, a soft light down the middle. */
export function rope(pt: Paint, path: Path2D, p: Palette, width: number, alpha = 1): void {
  const { ctx } = pt
  ctx.globalAlpha = alpha
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
  ctx.strokeStyle = 'rgba(6, 4, 12, 0.7)'
  ctx.lineWidth = width + 1.5
  ctx.stroke(path)
  ctx.strokeStyle = pattern(pt, p)
  ctx.lineWidth = width
  ctx.stroke(path)
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.13)'
  ctx.lineWidth = width * 0.32
  ctx.stroke(path)
  ctx.globalAlpha = 1
}

// ---- the live rope: a curve from the light to a place, three strands that start spread and close up ----

const bez = (a: Pt, b: Pt, c: Pt, d: Pt, t: number): Pt => {
  const u = 1 - t
  return {
    x: u * u * u * a.x + 3 * u * u * t * b.x + 3 * u * t * t * c.x + t * t * t * d.x,
    y: u * u * u * a.y + 3 * u * u * t * b.y + 3 * u * t * t * c.y + t * t * t * d.y
  }
}

/** The centre line of the live rope, from the light to the edge of a tile above or below it. */
export function liveCurve(from: Pt, to: Pt): Pt[] {
  // like the reference: out of the light and up a little, through the gap under the hump, over the bundle's run, then into the tile
  const c1 = { x: from.x + (to.x - from.x) * 0.38, y: from.y - 16 }
  const c2 = { x: to.x, y: from.y - 16 }
  return Array.from({ length: 72 }, (_, i) => bez(from, c1, c2, to, i / 71))
}

/** The centre lines of the three strands; `spread` 1 = apart as they first leave, 0 = closed into one rope. */
export function strandLines(line: Pt[], spread: number, width: number): Pt[][] {
  const n = line.length
  return STRANDS.map((_, s) => {
    const side = s - 1
    return line.map((p, i) => {
      const a = line[Math.max(0, i - 1)]
      const b = line[Math.min(n - 1, i + 1)]
      const l = Math.hypot(b.x - a.x, b.y - a.y) || 1
      const t = i / (n - 1)
      // together at the light, apart towards the place while spread
      const off = side * (width * 0.55 + spread * 9 * Math.pow(t, 1.3)) * Math.min(1, t * 6 + 0.25)
      return { x: p.x - ((b.y - a.y) / l) * off, y: p.y + ((b.x - a.x) / l) * off }
    })
  })
}

/** The strands painted in 2D (the board without WebGL). */
export function strands(pt: Paint, line: Pt[], spread: number, alpha: number, width: number): void {
  strandLines(line, spread, width).forEach((pts, s) => {
    const path = new Path2D()
    pts.forEach((q, i) => (i ? path.lineTo(q.x, q.y) : path.moveTo(q.x, q.y)))
    rope(pt, path, STRANDS[s], width, alpha)
  })
}

// ---- the sparks a place gathers from ----

export interface Spark {
  sx: number
  sy: number
  ex: number
  ey: number
  s: number
  c: string
  d: number
}

const SPARK_COLORS = ['#ffffff', '#ffffff', '#e8e4ff', '#c9c0ff', '#ffe6d0']
export function sparksFor(at: Pt, half: number, seed: number): Spark[] {
  const rnd = prng(seed)
  return Array.from({ length: 90 }, () => {
    // the cloud leans away from the board's centre, like the reference, and settles inside the tile
    const a = rnd() * Math.PI * 2
    const r = half * (1.1 + rnd() * 1.9)
    return {
      sx: at.x + Math.cos(a) * r * 1.35 + half * 0.6,
      sy: at.y + Math.sin(a) * r * 0.8 - half * 0.2,
      ex: at.x + (rnd() - 0.5) * half * 1.7,
      ey: at.y + (rnd() - 0.5) * half * 1.7,
      s: 0.7 + rnd() * 1.3,
      c: SPARK_COLORS[Math.floor(rnd() * SPARK_COLORS.length)],
      d: rnd() * 0.25
    }
  })
}

export const easeOut = (t: number): number => 1 - Math.pow(1 - Math.min(1, Math.max(0, t)), 3)

/** The sparks at progress `t` (0..1): drawn in, then gone as the tile takes their place. */
export function sparks(pt: Paint, list: Spark[], t: number): void {
  const { ctx } = pt
  for (const p of list) {
    const q = easeOut((t - p.d) / (1 - p.d))
    if (q <= 0) continue
    const fade = t < 0.7 ? Math.min(1, q * 3) : Math.max(0, (1 - t) / 0.3)
    ctx.globalAlpha = fade
    ctx.fillStyle = p.c
    const x = p.sx + (p.ex - p.sx) * q
    const y = p.sy + (p.ey - p.sy) * q
    ctx.fillRect(x - p.s / 2, y - p.s / 2, p.s, p.s)
  }
  ctx.globalAlpha = 1
}
