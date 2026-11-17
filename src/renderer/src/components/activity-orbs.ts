// The orbs of the activity board and of the context sphere: real spheres shaded once per theme and state, never per frame.
// Each orb is two small bitmaps: the BACK (contact shadow, body, inner glow) and the FRONT (only the specular highlights and the
// fresnel rim, transparent elsewhere). What sits inside the orb (an icon, the liquid of the context sphere) goes between the two, so it
// floats inside the glass and stays crisp HTML. The shading is a tiny per-pixel sphere shader on the CPU (a few thousand pixels, about a
// millisecond), cached by theme, state and size; switching theme renders the new set once. No WebGL, so there is nothing to fall back
// from: a weak PC gets the same picture.
import { useSyncExternalStore } from 'react'

export type OrbState = 'idle' | 'used' | 'on' | 'wait' | 'core' | 'core-on' | 'core-wait' | 'liquid'
type RGB = [number, number, number]

interface Material {
  /** body colour, lit and in shade */
  body: RGB
  shade: RGB
  /** how much of the studio reflects in it (chrome 1, pearl low) */
  reflect: number
  /** specular: tightness and strength */
  shine: number
  spec: number
  /** glass: how see-through the middle is (1 opaque) */
  opacity: number
  /** the colour seen at grazing angles */
  rim: RGB
  rimK: number
  /** the soft shadow under it on the panel */
  shadow: RGB
  shadowA: number
  /** the light inside (an active orb glows in the accent) */
  inner: RGB
  /** a matte sphere scatters light under its skin (pearl, frosted glass) */
  scatter: number
  dark: boolean
}

const hex = (c: string): RGB => {
  const m = c.trim().match(/^#?([0-9a-f]{6})$/i)
  if (m) return [parseInt(m[1].slice(0, 2), 16) / 255, parseInt(m[1].slice(2, 4), 16) / 255, parseInt(m[1].slice(4, 6), 16) / 255]
  const n = c.match(/[\d.]+/g)
  return n && n.length >= 3 ? [Number(n[0]) / 255, Number(n[1]) / 255, Number(n[2]) / 255] : [1, 1, 1]
}

/** The three looks: obsidian and chrome on Volt, clear glass on Glass, frosted pearl on Frost. */
function material(theme: string): Material {
  if (theme === 'glass')
    return { body: [0.3, 0.26, 0.55], shade: [0.04, 0.03, 0.12], reflect: 0.55, shine: 90, spec: 1.1, opacity: 0.42, rim: [0.85, 0.9, 1], rimK: 0.9, shadow: [0.02, 0, 0.08], shadowA: 0.55, inner: [0.77, 0.71, 1], scatter: 0.15, dark: true }
  if (theme === 'frost')
    return { body: [0.99, 0.99, 1], shade: [0.8, 0.82, 0.88], reflect: 0.16, shine: 26, spec: 0.55, opacity: 0.94, rim: [0.97, 0.93, 1], rimK: 0.5, shadow: [0.16, 0.2, 0.4], shadowA: 0.3, inner: [0.94, 0.38, 0.3], scatter: 0.6, dark: false }
  return { body: [0.11, 0.12, 0.14], shade: [0.01, 0.01, 0.015], reflect: 0.9, shine: 140, spec: 1.2, opacity: 1, rim: [0.6, 0.63, 0.7], rimK: 0.55, shadow: [0, 0, 0], shadowA: 0.85, inner: [0.83, 1, 0], scatter: 0, dark: true }
}

// the studio the orb reflects: a big soft box above and to the left, a thin strip light on the right, a dim floor
function env(x: number, y: number, z: number, dark: boolean): number {
  const sky = Math.max(0, -y) * 0.55 + 0.04
  const box = Math.exp(-(((x + 0.35) / 0.45) ** 2 + ((y + 0.62) / 0.2) ** 2)) * 1.6
  const strip = Math.exp(-(((x - 0.72) / 0.07) ** 2)) * Math.max(0, 0.6 - Math.abs(y + 0.1)) * 1.4
  const floor = y > 0.15 ? (dark ? 0.02 : 0.25) * (1 - Math.min(1, (y - 0.15) * 2)) : 0
  return (sky + box + strip + floor) * (z > -0.2 ? 1 : 0.6)
}

const clamp = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v)
const L = (() => {
  const v = [-0.5, -0.62, 0.6]
  const l = Math.hypot(v[0], v[1], v[2])
  return v.map((c) => c / l)
})()
const H = (() => {
  const v = [L[0], L[1], L[2] + 1]
  const l = Math.hypot(v[0], v[1], v[2])
  return v.map((c) => c / l)
})()

/** Paints one orb, back or front, into a canvas `px` wide (the sphere fills 80% of it, the shadow the rest below). */
function paint(px: number, m: Material, glow: number, accent: RGB, front: boolean): HTMLCanvasElement {
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
  const img = g.createImageData(px, px)
  const d = img.data
  const inner = glow > 0 ? accent : m.inner
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
      const ndl = nx * L[0] + ny * L[1] + nz * L[2]
      const ndh = Math.max(0, nx * H[0] + ny * H[1] + nz * H[2])
      const fres = Math.pow(1 - nz, 2.6)
      // the reflected view ray, and the studio seen in it
      const rx = 2 * nz * nx
      const ry = 2 * nz * ny
      const rz = 2 * nz * nz - 1
      const e = env(rx, ry, rz, m.dark)
      const spec = Math.pow(ndh, m.shine) * m.spec + Math.pow(ndh, m.shine * 6) * m.spec * 1.4
      let r: number, gg: number, b: number, a: number
      if (front) {
        // only the light that sits on the surface: highlights, the reflected box, a thin bright rim
        const hi = spec + e * m.reflect * (0.35 + fres * 0.9) * (m.dark ? 0.55 : 0.3)
        const rimL = fres * m.rimK * (0.35 + 0.65 * clamp(-ny * 0.8 + 0.5)) * 0.8 + fres * glow * 0.8
        const tot = hi + rimL
        a = clamp(tot) * cover
        if (a <= 0.002) continue
        r = (hi + rimL * (glow > 0 ? accent[0] : m.rim[0])) / Math.max(tot, 1e-4)
        gg = (hi + rimL * (glow > 0 ? accent[1] : m.rim[1])) / Math.max(tot, 1e-4)
        b = (hi + rimL * (glow > 0 ? accent[2] : m.rim[2])) / Math.max(tot, 1e-4)
      } else {
        // the body: wrapped diffuse light, light scattered under the skin, the glow from inside pooled low (as light gathers in a lens)
        const dif = clamp((ndl + m.scatter) / (1 + m.scatter))
        const t = dif * 0.85 + 0.15 * (1 - fres)
        r = m.shade[0] + (m.body[0] - m.shade[0]) * t
        gg = m.shade[1] + (m.body[1] - m.shade[1]) * t
        b = m.shade[2] + (m.body[2] - m.shade[2]) * t
        // the floor seen upside down through the glass, and the studio in the surface
        const through = m.opacity < 1 ? env(-nx * 0.6, -ny * 0.9, 1, m.dark) * 0.18 : 0
        const refl = e * m.reflect * (0.12 + fres * 0.5) * (m.dark ? 1 : 0.25)
        const pool = Math.exp(-((nx / 0.55) ** 2 + ((ny - 0.42) / 0.38) ** 2))
        const core = Math.exp(-((nx / 0.5) ** 2 + ((ny - 0.05) / 0.5) ** 2))
        const gl = glow * (pool * 0.85 + core * (m.dark && m.opacity === 1 ? 0.12 : 0.35)) + (m.opacity < 1 ? pool * 0.22 : m.dark ? 0 : pool * 0.06)
        r += refl + through + inner[0] * gl
        gg += refl + through + inner[1] * gl
        b += refl + through + inner[2] * gl
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

// ---- the cache, and the theme it was made for ----
const cache = new Map<string, { back: string; front: string }>()
let version = 0
const listeners = new Set<() => void>()
let watching = false

function watch(): void {
  if (watching || typeof MutationObserver === 'undefined') return
  watching = true
  new MutationObserver(() => {
    version++
    listeners.forEach((l) => l())
  }).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
}

/** The two bitmaps of an orb, as URLs for CSS: `size` is the largest it is shown at, in CSS pixels. */
export function orb(state: OrbState, size: number): { back: string; front: string } {
  const theme = document.documentElement.dataset.theme || 'volt'
  const dpr = Math.min(2, Math.max(1, window.devicePixelRatio || 1))
  const px = Math.round(size * dpr)
  const cs = getComputedStyle(document.documentElement)
  const warn = cs.getPropertyValue('--warning').trim()
  const accentCss = state.endsWith('wait') ? warn : cs.getPropertyValue('--volt').trim()
  const key = `${theme}|${state}|${px}|${accentCss}`
  const hit = cache.get(key)
  if (hit) return hit
  const m = material(theme)
  const accent = hex(accentCss || '#ffffff')
  // how much light is inside: an obsidian orb shows it as a glow pooled at its base, glass and pearl can take more
  const k = m.dark && m.opacity === 1 ? 0.55 : 1
  const glow = k * (state === 'on' ? 0.8 : state === 'wait' ? 0.55 : state === 'core-on' ? 0.85 : state === 'core-wait' ? 0.5 : state === 'core' ? 0.18 : 0)
  // a used place is lit a little; idle ones are a shade darker
  const mm = state === 'idle' ? { ...m, body: m.body.map((v, i) => m.shade[i] + (v - m.shade[i]) * (m.dark ? 0.75 : 0.96)) as RGB } : m
  const out = { back: paint(px, mm, glow, accent, false).toDataURL(), front: paint(px, mm, glow, accent, true).toDataURL() }
  cache.set(key, out)
  return out
}

/** Re-renders a component when the theme changes, so it asks for the new orbs. */
export function useOrbTheme(): number {
  watch()
  return useSyncExternalStore(
    (l) => {
      listeners.add(l)
      return () => listeners.delete(l)
    },
    () => version
  )
}
