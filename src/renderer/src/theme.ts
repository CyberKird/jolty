import type { AppSettings } from '@shared/types'

export type ThemeId = NonNullable<AppSettings['theme']>
export const THEMES: ThemeId[] = ['volt', 'glass', 'frost']
const KEY = 'jolty:theme'

/**
 * Glass bends what is behind it at the rim, like a thick pane. Chromium takes an SVG filter inside `backdrop-filter`, so the
 * bend is two displacement passes (across, then down) steered by gradient maps: the pixels at an edge are read from further in.
 * The maps stretch with the element, so the rim is a share of its size. Only floating and small things use it (themes.css).
 */
const map = (axis: 'x' | 'y', band: number): string => {
  const [x2, y2] = axis === 'x' ? [1, 0] : [0, 1]
  const hi = axis === 'x' ? 'rgb(255,128,128)' : 'rgb(128,255,128)'
  const lo = axis === 'x' ? 'rgb(0,128,128)' : 'rgb(128,0,128)'
  // the pull is steepest at the very rim and fades inwards, like the curve of a thick pane
  const mid = axis === 'x' ? 'rgb(190,128,128)' : 'rgb(128,190,128)'
  const midLo = axis === 'x' ? 'rgb(66,128,128)' : 'rgb(128,66,128)'
  const svg = `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 1 1' preserveAspectRatio='none'><defs><linearGradient id='g' x1='0' y1='0' x2='${x2}' y2='${y2}'><stop offset='0' stop-color='${hi}'/><stop offset='${band * 0.4}' stop-color='${mid}'/><stop offset='${band}' stop-color='rgb(128,128,128)'/><stop offset='${1 - band}' stop-color='rgb(128,128,128)'/><stop offset='${1 - band * 0.4}' stop-color='${midLo}'/><stop offset='1' stop-color='${lo}'/></linearGradient></defs><rect width='1' height='1' fill='url(#g)'/></svg>`
  return `data:image/svg+xml,${encodeURIComponent(svg)}`
}
function lensFilter(): void {
  if (document.getElementById('jolty-lens-defs')) return
  const holder = document.createElement('div')
  holder.id = 'jolty-lens-defs'
  holder.setAttribute('aria-hidden', 'true')
  holder.style.cssText = 'position:absolute;width:0;height:0;overflow:hidden;pointer-events:none'
  holder.innerHTML = `<svg width="0" height="0" xmlns="http://www.w3.org/2000/svg"><defs>
    <filter id="jolty-lens" x="0" y="0" width="100%" height="100%" color-interpolation-filters="sRGB">
      <feImage href="${map('x', 0.06)}" x="0" y="0" width="100%" height="100%" preserveAspectRatio="none" result="mx"/>
      <feDisplacementMap in="SourceGraphic" in2="mx" scale="46" xChannelSelector="R" yChannelSelector="G" result="dx"/>
      <feImage href="${map('y', 0.16)}" x="0" y="0" width="100%" height="100%" preserveAspectRatio="none" result="my"/>
      <feDisplacementMap in="dx" in2="my" scale="46" xChannelSelector="R" yChannelSelector="G"/>
    </filter></defs></svg>`
  document.body.prepend(holder)
}

/** The light on glass follows the pointer: two variables on <html>, read by the sheen layers in themes.css. */
let light: ((e: PointerEvent) => void) | undefined
function pointerLight(on: boolean): void {
  const root = document.documentElement
  if (!on) {
    if (light) removeEventListener('pointermove', light)
    light = undefined
    root.style.removeProperty('--lx')
    root.style.removeProperty('--ly')
    return
  }
  if (light) return
  let frame = 0
  let last: PointerEvent
  light = (e) => {
    last = e
    if (frame) return
    frame = requestAnimationFrame(() => {
      frame = 0
      root.style.setProperty('--lx', `${last.clientX}px`)
      root.style.setProperty('--ly', `${last.clientY}px`)
    })
  }
  addEventListener('pointermove', light, { passive: true })
}

/** Puts the theme on <html> (themes.css reads it) and remembers it for the next start. */
export function applyTheme(theme: AppSettings['theme'], clear = 0): void {
  const id: ThemeId = theme && THEMES.includes(theme) ? theme : 'volt'
  const root = document.documentElement
  root.dataset.theme = id
  setClear(id === 'volt' ? 0 : clear)
  if (id !== 'volt') lensFilter()
  pointerLight(id !== 'volt')
  try { localStorage.setItem(KEY, id) } catch { /* private mode: the saved settings still decide */ }
}

/** How much of the desktop shows through (0 to 100): the page tint thins out; the system draws the acrylic behind it (main/index.ts). */
export function setClear(clear: number): void {
  const root = document.documentElement
  const n = Math.max(0, Math.min(100, Math.round(clear) || 0))
  if (n) {
    root.dataset.clear = ''
    root.style.setProperty('--tint', String(+(1 - n * 0.0065).toFixed(3)))
  } else {
    delete root.dataset.clear
    root.style.removeProperty('--tint')
  }
  try { localStorage.setItem(KEY + ':clear', String(n)) } catch { /* see above */ }
}

export function applySavedTheme(): void {
  try { applyTheme(localStorage.getItem(KEY) as ThemeId | null || undefined, Number(localStorage.getItem(KEY + ':clear')) || 0) } catch { applyTheme(undefined) }
}
