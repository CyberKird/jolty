// The orbs of the activity board and of the context sphere: real spheres shaded once per theme, state and light, never per frame.
// Each orb is two small bitmaps (orb-shader.ts): the BACK (contact shadow, body, inner glow) and the FRONT (the window reflection along
// the rim, a faint sheen, the bounce rim, the edge; transparent in the middle). The icon or the liquid goes over the back and the front
// stays clear of it, so it is always crisp HTML. One light for the whole board: each orb gets the reflection angle of where it sits
// relative to that light, plus a small fixed variation of its own, so no two look stamped. A sphere costs about a millisecond; the
// results are cached (angles rounded to 4 degrees), and switching theme renders the new set once. No WebGL, nothing to fall back from.
import { useSyncExternalStore } from 'react'
import { material, paint, type Light, type RGB } from './orb-shader'

export type OrbState = 'idle' | 'used' | 'on' | 'wait' | 'core' | 'core-on' | 'core-wait' | 'liquid'
export type { Light }

const hex = (c: string): RGB => {
  const m = c.trim().match(/^#?([0-9a-f]{6})$/i)
  if (m) return [parseInt(m[1].slice(0, 2), 16) / 255, parseInt(m[1].slice(2, 4), 16) / 255, parseInt(m[1].slice(4, 6), 16) / 255]
  const n = c.match(/[\d.]+/g)
  return n && n.length >= 3 ? [Number(n[0]) / 255, Number(n[1]) / 255, Number(n[2]) / 255] : [1, 1, 1]
}

/** Up and to the left, the light of a sphere on its own (the context sphere in the header). */
export const DEFAULT_LIGHT: Light = { angle: (-128 * Math.PI) / 180, gain: 1, spread: 1 }

/** The light an orb at (x, y) on the board sees from a light at `from`, with a small variation fixed by `seed`. */
export function lightAt(x: number, y: number, from: { x: number; y: number }, seed: number): Light {
  const h = (n: number): number => {
    const s = Math.sin(seed * 12.9898 + n * 78.233) * 43758.5453
    return s - Math.floor(s)
  }
  const dx = from.x - x
  const dy = from.y - y
  const far = Math.hypot(dx, dy)
  return {
    angle: Math.atan2(dy, dx) + (h(1) - 0.5) * 0.16,
    // nearer the light, a touch brighter and longer
    gain: Math.min(1.15, Math.max(0.8, 260 / far)) * (0.93 + h(2) * 0.14),
    spread: 0.9 + h(3) * 0.2
  }
}

// ---- the cache, and the theme it was made for ----
const cache = new Map<string, string>()
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
export function orb(state: OrbState, size: number, light: Light = DEFAULT_LIGHT): { back: string; front: string } {
  const theme = document.documentElement.dataset.theme || 'volt'
  const dpr = Math.min(2, Math.max(1, window.devicePixelRatio || 1))
  const px = Math.round(size * dpr)
  const cs = getComputedStyle(document.documentElement)
  const accentCss = (state.endsWith('wait') ? cs.getPropertyValue('--warning') : cs.getPropertyValue('--volt')).trim()
  // rounded, so orbs in nearly the same place share their bitmaps
  const q: Light = { angle: Math.round((light.angle * 180) / Math.PI / 4) * 4 * (Math.PI / 180), gain: Math.round(light.gain * 20) / 20, spread: Math.round(light.spread * 10) / 10 }
  const key = `${theme}|${state}|${px}|${accentCss}|${q.angle.toFixed(3)}|${q.gain}|${q.spread}`
  const m = material(theme)
  const accent = hex(accentCss || '#ffffff')
  // how much light is inside: an obsidian orb shows it as a glow pooled at its base, glass and pearl can take more
  const k = m.dark && m.opacity === 1 ? 0.55 : 1
  const glow = k * (state === 'on' ? 0.8 : state === 'wait' ? 0.55 : state === 'core-on' ? 0.85 : state === 'core-wait' ? 0.5 : state === 'core' ? 0.18 : 0)
  // an idle place is a shade darker than a used one
  const mm = state === 'idle' ? { ...m, body: m.body.map((v, i) => m.shade[i] + (v - m.shade[i]) * (m.dark ? 0.75 : 0.96)) as RGB } : m
  const get = (front: boolean): string => {
    const k2 = `${key}|${front ? 'f' : 'b'}`
    let u = cache.get(k2)
    if (!u) {
      u = paint(px, mm, glow, accent, front, q).toDataURL()
      cache.set(k2, u)
    }
    return u
  }
  return { back: get(false), front: get(true) }
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
