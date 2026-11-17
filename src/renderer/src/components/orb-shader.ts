// The sphere shader behind activity-orbs.ts: a tiny per-pixel shader on the CPU that paints one orb into a canvas, once.
// BACK: the contact shadow and the body (wrapped diffuse light, light scattered under a matte skin, the glow from inside pooled low).
// FRONT: only what lies on the surface, and never over the middle where the icon sits:
//  - the window: one soft lens-shaped reflection of a big softbox, along the rim on the side facing the board's light, following the
//    sphere's curve, about 35% white at its brightest and fading to nothing at both ends and inwards;
//  - a very faint broad sheen on the same side;
//  - the bounce: a soft rim of light along the opposite edge (light coming back off the panel), in the accent when the orb glows;
//  - a hairline fresnel edge so the silhouette reads on any background.
// There is no point highlight on purpose: a hard dot in the same spot on every orb reads as a sticker and sits on the icons.

export type RGB = [number, number, number]

export interface Material {
  body: RGB
  shade: RGB
  /** glass: how see-through the middle is (1 opaque) */
  opacity: number
  /** light scattered under the skin (pearl, frosted glass) */
  scatter: number
  /** strength of the window reflection, the sheen, the bounce rim and the fresnel edge */
  win: number
  sheen: number
  bounce: number
  edge: number
  /** the colour of the reflections (white, or a cool or warm white) */
  ink: RGB
  bounceInk: RGB
  shadow: RGB
  shadowA: number
  /** the light inside an active orb */
  inner: RGB
  dark: boolean
}

/** Obsidian on Volt, clear glass on Glass, frosted pearl on Frost. */
export function material(theme: string): Material {
  if (theme === 'glass')
    return { body: [0.3, 0.26, 0.55], shade: [0.04, 0.03, 0.12], opacity: 0.42, scatter: 0.15, win: 0.4, sheen: 0.06, bounce: 0.3, edge: 0.35, ink: [1, 1, 1], bounceInk: [0.62, 0.86, 1], shadow: [0.02, 0, 0.08], shadowA: 0.55, inner: [0.77, 0.71, 1], dark: true }
  if (theme === 'frost')
    return { body: [0.99, 0.99, 1], shade: [0.78, 0.8, 0.87], opacity: 0.95, scatter: 0.6, win: 0.75, sheen: 0.18, bounce: 0.22, edge: 0.18, ink: [1, 1, 1], bounceInk: [1, 0.86, 0.82], shadow: [0.16, 0.2, 0.4], shadowA: 0.3, inner: [0.94, 0.38, 0.3], dark: false }
  return { body: [0.13, 0.14, 0.16], shade: [0.01, 0.01, 0.015], opacity: 1, scatter: 0, win: 0.42, sheen: 0.05, bounce: 0.16, edge: 0.22, ink: [0.92, 0.95, 1], bounceInk: [0.75, 0.78, 0.85], shadow: [0, 0, 0], shadowA: 0.85, inner: [0.83, 1, 0], dark: true }
}

const clamp = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v)
const smooth = (a: number, b: number, v: number): number => {
  const t = clamp((v - a) / (b - a))
  return t * t * (3 - 2 * t)
}
const wrap = (a: number): number => Math.atan2(Math.sin(a), Math.cos(a))

export interface Light {
  /** where the board's light is, seen from this orb (radians, screen angle: -PI/2 is straight up) */
  angle: number
  /** how strong its reflection is here (about 1) */
  gain: number
  /** how long the window is along the rim (about 1) */
  spread: number
}

/** Paints one orb, back or front, into a canvas `px` wide (the sphere fills 80% of it, centred at 46% of the height). */
export function paint(px: number, m: Material, glow: number, accent: RGB, front: boolean, light: Light): HTMLCanvasElement {
  const c = document.createElement('canvas')
  c.width = c.height = px
  const g = c.getContext('2d')!
  const R = px * 0.4
  const cx = px / 2
  const cy = px * 0.46
  if (!front) {
    // the contact shadow: a soft ellipse under the sphere
    const sh = g.createRadialGradient(cx, cy + R * 0.95, 0, cx, cy + R * 0.95, R * 1.05)
    const [r, gg, b] = m.shadow.map((v) => Math.round(v * 255))
    sh.addColorStop(0, `rgba(${r},${gg},${b},${m.shadowA})`)
    sh.addColorStop(1, `rgba(${r},${gg},${b},0)`)
    g.save()
    g.translate(cx, cy + R * 0.95)
    g.scale(1, 0.32)
    g.translate(-cx, -(cy + R * 0.95))
    g.fillStyle = sh
    g.fillRect(0, 0, px, px)
    g.restore()
  }
  // the body is lit from the board's light too: its direction in 3D, a little in front of the sphere
  const lx = Math.cos(light.angle) * 0.62
  const ly = Math.sin(light.angle) * 0.62
  const lz = 0.78
  const img = g.createImageData(px, px)
  const d = img.data
  const inner = glow > 0 ? accent : m.inner
  const bounceInk = glow > 0 ? accent : m.bounceInk
  for (let y = 0; y < px; y++)
    for (let x = 0; x < px; x++) {
      const nx = (x + 0.5 - cx) / R
      const ny = (y + 0.5 - cy) / R
      const rr = nx * nx + ny * ny
      const dist = Math.sqrt(rr)
      // anti-aliased edge, one pixel wide
      const cover = clamp((1 - dist) * R + 0.5)
      if (cover <= 0) continue
      const nz = Math.sqrt(Math.max(0, 1 - Math.min(1, rr)))
      const fres = Math.pow(1 - nz, 2.6)
      let r: number, gg: number, b: number, a: number
      if (front) {
        const ang = Math.atan2(ny, nx)
        const toLight = Math.abs(wrap(ang - light.angle))
        const away = Math.abs(wrap(ang - light.angle - Math.PI))
        // the window: a lens along the rim, thickest facing the light, tapering to nothing about 60 degrees either side
        const along = 1 - smooth(0, 1.05 * light.spread, toLight)
        const half = 0.085 * along
        const band = half > 0.004 ? 1 - smooth(half * 0.35, half, Math.abs(dist - 0.84)) : 0
        // brighter on its outer side, so it reads as light on a curved surface, not a stroke
        const win = m.win * light.gain * band * along * (0.7 + 0.3 * smooth(0.76, 0.92, dist))
        // the sheen: very faint, broad, on the light's side, never reaching the middle
        const sheen = m.sheen * light.gain * smooth(0.45, 0.95, dist) * (1 - smooth(0, 1.4, toLight))
        // the bounce: a soft rim along the far edge
        const bounce = (m.bounce + glow * 0.45) * smooth(0.8, 0.97, dist) * (1 - smooth(0, 1.25, away))
        // the hairline edge all round
        const edge = m.edge * fres * smooth(0.9, 1, dist)
        const lit = win + sheen + edge
        const tot = lit + bounce
        a = clamp(tot) * cover
        if (a <= 0.002) continue
        r = (lit * m.ink[0] + bounce * bounceInk[0]) / tot
        gg = (lit * m.ink[1] + bounce * bounceInk[1]) / tot
        b = (lit * m.ink[2] + bounce * bounceInk[2]) / tot
      } else {
        const ndl = nx * lx + ny * ly + nz * lz
        const dif = clamp((ndl + m.scatter) / (1 + m.scatter))
        const t = dif * 0.85 + 0.15 * (1 - fres)
        r = m.shade[0] + (m.body[0] - m.shade[0]) * t
        gg = m.shade[1] + (m.body[1] - m.shade[1]) * t
        b = m.shade[2] + (m.body[2] - m.shade[2]) * t
        // a dark sphere picks up a little of the room towards its edge; glass shows the floor upside down through it
        const room = m.dark ? fres * 0.1 * clamp(0.6 - ny * 0.5) : 0
        const through = m.opacity < 1 ? clamp(0.5 + ny * 0.6) * 0.08 : 0
        const pool = Math.exp(-((nx / 0.55) ** 2 + ((ny - 0.42) / 0.38) ** 2))
        const core = Math.exp(-((nx / 0.5) ** 2 + ((ny - 0.05) / 0.5) ** 2))
        const gl = glow * (pool * 0.85 + core * (m.dark && m.opacity === 1 ? 0.12 : 0.35)) + (m.opacity < 1 ? pool * 0.22 : m.dark ? 0 : pool * 0.06)
        r += room + through + inner[0] * gl
        gg += room + through + inner[1] * gl
        b += room + through + inner[2] * gl
        // glass is clear in the middle and solid at the edge
        a = (m.opacity + (1 - m.opacity) * Math.min(1, fres * 1.6 + gl * 0.6)) * cover
      }
      const i = (y * px + x) * 4
      d[i] = Math.round(clamp(r) * 255)
      d[i + 1] = Math.round(clamp(gg) * 255)
      d[i + 2] = Math.round(clamp(b) * 255)
      d[i + 3] = Math.round(clamp(a) * 255)
    }
  const t = document.createElement('canvas')
  t.width = t.height = px
  t.getContext('2d')!.putImageData(img, 0, 0)
  g.drawImage(t, 0, 0)
  return c
}
