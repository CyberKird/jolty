// The real screen source and input for remote-screen.ts: Electron's desktopCapturer and the computer-use helper.
import { desktopCapturer, screen } from 'electron'
import { electronCapturer } from './computer/capture'
import { nativeComputer } from './computer/native'
import type { ScreenInput, ScreenSource } from './remote-screen'

export const nativeScreenSource: ScreenSource = {
  displays: () => electronCapturer.displays(),
  cursor: () => {
    const p = screen.getCursorScreenPoint()
    return process.platform === 'win32' ? screen.dipToScreenPoint(p) : p
  },
  async frame(display, maxEdge) {
    const scale = Math.min(1, maxEdge / Math.max(display.w, display.h))
    const w = Math.max(2, Math.round(display.w * scale))
    const h = Math.max(2, Math.round(display.h * scale))
    const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: w, height: h }, fetchWindowIcons: false })
    const src = sources.find((s) => s.display_id === String(display.id)) || sources[display.index]
    if (!src || src.thumbnail.isEmpty()) throw new Error('The screen could not be captured (is it locked or asleep?).')
    const size = src.thumbnail.getSize()
    return { jpeg: src.thumbnail.toJPEG(68), width: size.width, height: size.height }
  }
}

export const nativeScreenInput = async (): Promise<ScreenInput> => {
  const input = await nativeComputer.inputBackend()
  // the person at the PC may be moving the mouse too: a phone's touch must not be cancelled by that
  return { play: (events) => input.play(events, { allowUser: true }) }
}
