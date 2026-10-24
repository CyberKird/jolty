// Screenshots through Electron's desktopCapturer, with the pointer painted in (the capturer leaves it out).
import { desktopCapturer, nativeImage, screen } from 'electron'
import { fitScale, viewOf, type DisplayInfo, type View } from './geometry'
import type { Rect } from './helper'

export interface Shot {
  jpeg: Buffer
  view: View
}

export interface Capturer {
  displays(): DisplayInfo[]
  /** `region` is physical pixels of the display; `cursor` physical pixels of the desktop */
  grab(display: DisplayInfo, region: Rect | undefined, cursor: { x: number; y: number } | undefined): Promise<Shot>
}

/** The pointer arrow, as a polygon in a 12 x 19 box. */
const ARROW: [number, number][] = [[0, 0], [0, 16], [4, 12.5], [7, 19], [9.4, 18], [6.6, 11.6], [11.5, 11.6]]

const inPoly = (poly: [number, number][], x: number, y: number): boolean => {
  let c = false
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i]
    const [xj, yj] = poly[j]
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) c = !c
  }
  return c
}

const edgeDistance = (poly: [number, number][], x: number, y: number): number => {
  let best = Infinity
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [ax, ay] = poly[j]
    const [bx, by] = poly[i]
    const dx = bx - ax
    const dy = by - ay
    const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy)))
    best = Math.min(best, Math.hypot(x - (ax + t * dx), y - (ay + t * dy)))
  }
  return best
}

/** Paints a white arrow with a dark outline into a BGRA bitmap, tip at (px, py). */
export function paintCursor(bgra: Buffer, width: number, height: number, px: number, py: number, size: number): void {
  const k = size / 19
  const x0 = Math.max(0, Math.floor(px - 2))
  const y0 = Math.max(0, Math.floor(py - 2))
  const x1 = Math.min(width, Math.ceil(px + 13 * k + 2))
  const y1 = Math.min(height, Math.ceil(py + size + 2))
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const lx = (x + 0.5 - px) / k
      const ly = (y + 0.5 - py) / k
      const inside = inPoly(ARROW, lx, ly)
      const edge = edgeDistance(ARROW, lx, ly) * k
      if (!inside && edge > 1.3) continue
      const o = (y * width + x) * 4
      const white = inside && edge > 0.9
      bgra[o] = bgra[o + 1] = bgra[o + 2] = white ? 255 : 20
      bgra[o + 3] = 255
    }
  }
}

export const electronCapturer: Capturer = {
  displays(): DisplayInfo[] {
    const primary = screen.getPrimaryDisplay().id
    return screen.getAllDisplays().map((d, index) => {
      const r = screen.dipToScreenRect(null, d.bounds)
      return { index, id: d.id, x: r.x, y: r.y, w: r.width, h: r.height, primary: d.id === primary, scaleFactor: d.scaleFactor }
    })
  },

  async grab(display, region, cursor): Promise<Shot> {
    const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: display.w, height: display.h }, fetchWindowIcons: false })
    const src = sources.find((s) => s.display_id === String(display.id)) || sources[display.index]
    if (!src || src.thumbnail.isEmpty()) throw new Error('The screen could not be captured (is it locked or asleep?).')
    let img = src.thumbnail
    const full = img.getSize()
    // the thumbnail is the display at its physical size; guard against a driver that returns another size
    const fx = full.width / display.w
    const fy = full.height / display.h
    const reg = region || { x: display.x, y: display.y, w: display.w, h: display.h }
    if (region) {
      img = img.crop({ x: Math.round((reg.x - display.x) * fx), y: Math.round((reg.y - display.y) * fy), width: Math.round(reg.w * fx), height: Math.round(reg.h * fy) })
    }
    // a zoom may enlarge (up to 4x) so small print becomes readable; a whole screen is only ever reduced
    const scale = region ? Math.min(4, 1568 / Math.max(reg.w, reg.h), Math.sqrt(1_150_000 / (reg.w * reg.h))) : fitScale(reg.w, reg.h)
    const out = scale < 1 ? img.resize({ width: Math.max(1, Math.round(reg.w * scale)), height: Math.max(1, Math.round(reg.h * scale)), quality: 'best' }) : img
    const final = viewOf(display, reg, scale)
    if (cursor && cursor.x >= reg.x && cursor.y >= reg.y && cursor.x < reg.x + reg.w && cursor.y < reg.y + reg.h) {
      const { width, height } = out.getSize()
      const bitmap = Buffer.from(out.toBitmap())
      paintCursor(bitmap, width, height, (cursor.x - reg.x) * scale, (cursor.y - reg.y) * scale, Math.max(18, 19 * scale * 1.2))
      return { jpeg: nativeImage.createFromBitmap(bitmap, { width, height }).toJPEG(82), view: final }
    }
    return { jpeg: out.toJPEG(82), view: final }
  }
}
