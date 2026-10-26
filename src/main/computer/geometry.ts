// Coordinates. The model works in pixels of the screenshot it was given; the PC works in physical pixels of the
// virtual desktop. A View remembers how one screenshot maps back, so a click lands where the model saw it.
import type { Rect } from './helper'

export interface DisplayInfo extends Rect {
  index: number
  id: number
  primary: boolean
  /** Windows display scaling, 1 = 100 % */
  scaleFactor: number
  /** the monitor's name from Windows, when it has one */
  name?: string
}

/** The long edge of a screenshot and its total pixels stay inside what models read well. */
export const MAX_EDGE = 1568
export const MAX_PIXELS = 1_150_000

export function fitScale(w: number, h: number, maxEdge = MAX_EDGE, maxPixels = MAX_PIXELS): number {
  return Math.min(1, maxEdge / Math.max(w, h), Math.sqrt(maxPixels / (w * h)))
}

export interface View {
  display: DisplayInfo
  /** physical region the picture shows (the whole display unless zoomed) */
  region: Rect
  /** picture pixels per physical pixel */
  scale: number
  width: number
  height: number
}

export function viewOf(display: DisplayInfo, region: Rect = display, scaleOverride?: number): View {
  const scale = scaleOverride ?? fitScale(region.w, region.h)
  return { display, region, scale, width: Math.round(region.w * scale), height: Math.round(region.h * scale) }
}

/** Picture pixel to physical pixel. */
export const toPhysical = (v: View, x: number, y: number): { x: number; y: number } => ({
  x: Math.round(v.region.x + x / v.scale),
  y: Math.round(v.region.y + y / v.scale)
})

/** Physical pixel to picture pixel (may fall outside the picture). */
export const toPicture = (v: View, x: number, y: number): { x: number; y: number } => ({
  x: Math.round((x - v.region.x) * v.scale),
  y: Math.round((y - v.region.y) * v.scale)
})

export const inside = (v: View, x: number, y: number): boolean => x >= 0 && y >= 0 && x < v.width && y < v.height

export function displayAt(displays: DisplayInfo[], x: number, y: number): DisplayInfo | undefined {
  return displays.find((d) => x >= d.x && y >= d.y && x < d.x + d.w && y < d.y + d.h)
}

/** The display that holds most of a window. */
export function displayOfRect(displays: DisplayInfo[], r: Rect): DisplayInfo | undefined {
  let best: DisplayInfo | undefined
  let area = 0
  for (const d of displays) {
    const w = Math.min(d.x + d.w, r.x + r.w) - Math.max(d.x, r.x)
    const h = Math.min(d.y + d.h, r.y + r.h) - Math.max(d.y, r.y)
    if (w > 0 && h > 0 && w * h > area) {
      area = w * h
      best = d
    }
  }
  return best
}

/** Where a display sits next to the primary one, in words the model can use ("right of the primary"). */
export function placement(d: DisplayInfo, displays: DisplayInfo[]): string {
  const p = displays.find((x) => x.primary)
  if (d.primary || !p) return 'primary'
  const dx = d.x + d.w / 2 - (p.x + p.w / 2)
  const dy = d.y + d.h / 2 - (p.y + p.h / 2)
  if (Math.abs(dx) >= Math.abs(dy)) return `${dx > 0 ? 'right' : 'left'} of the primary`
  return `${dy > 0 ? 'below' : 'above'} the primary`
}

/** One line per display for the model: index, name, placement, physical size and origin, scaling. */
export function displayLine(d: DisplayInfo, displays: DisplayInfo[]): string {
  return `display ${d.index}${d.name ? ` "${d.name}"` : ''} (${placement(d, displays)}): ${d.w}x${d.h} physical px at (${d.x}, ${d.y}), scaling ${Math.round(d.scaleFactor * 100)}%`
}

/** A view is only good while its display is still there with the same place and size (monitors get unplugged or rearranged). */
export const stillThere = (displays: DisplayInfo[], d: DisplayInfo): boolean => displays.some((x) => x.id === d.id && x.x === d.x && x.y === d.y && x.w === d.w && x.h === d.h)
