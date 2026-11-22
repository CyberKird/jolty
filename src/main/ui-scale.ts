// How big the interface is drawn. Jolty is laid out for about 2560 x 1440 of room (a 4K screen at 150 %); on a smaller screen
// (1080p at 100 %, a laptop at 125 %) the same layout feels crowded, so 'auto' draws it a little smaller there, never below a size
// that still reads well. A fixed percent overrides it. Applied as the page zoom, so every theme and layout scales together.
import { screen, type BrowserWindow } from 'electron'

export const UI_SCALES = [80, 90, 100, 110, 125] as const
const MIN = 0.8
const MAX = 1.5

/** auto: from the work area of the window's screen, in device-independent pixels */
export function autoZoom(width: number, height: number): number {
  // width and height both count: a short wide screen (ultrawide 2560 x 1080) is as crowded as 1920 x 1080 for the chat
  const room = Math.min(width / 2560, (height + 60) / 1440)
  // 1920 x 1080 (room 0.75) lands at 0.9: the layout breathes, the smallest text stays about 10 px; 2560 x 1440 and up stay at 1
  const z = 0.9 + (room - 0.75) * 0.5
  return Math.round(Math.min(1, Math.max(0.85, z)) * 100) / 100
}

export function zoomFor(win: BrowserWindow, setting: unknown): number {
  if (typeof setting === 'number' && Number.isFinite(setting)) return Math.min(MAX, Math.max(MIN, setting / 100))
  const { width, height } = screen.getDisplayMatching(win.getBounds()).workAreaSize
  return autoZoom(width, height)
}

/** one step bigger or smaller than the zoom in use, for Ctrl+wheel and Ctrl +/- */
export function stepScale(current: number, dir: 1 | -1): number {
  const pct = Math.round(current * 100)
  const next = dir > 0 ? UI_SCALES.find((s) => s > pct) : [...UI_SCALES].reverse().find((s) => s < pct)
  return next ?? (dir > 0 ? UI_SCALES[UI_SCALES.length - 1] : UI_SCALES[0])
}
