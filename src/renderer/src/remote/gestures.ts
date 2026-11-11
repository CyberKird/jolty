import { flushSync } from 'react-dom'
import { useStore } from '../store'
import { useScreenUi } from './screen-bus'

// The finger moves the drawer: a swipe from the left edge (or a rightward swipe on the chat) pulls the sidebar out under it, a swipe
// to the left pushes it back. The drawer follows the finger one to one and, on release, goes where the finger was heading
// (position and speed decide), so it feels like part of the phone and not like a button with an animation.

const EDGE = 30
const MIN_MOVE = 10

interface Drag {
  mode: 'open' | 'close'
  x0: number
  y0: number
  width: number
  p: number
  /** the speed of the last moments, px per ms, positive to the right */
  v: number
  lastX: number
  lastT: number
}

/** Whether something under the finger scrolls sideways itself (a code block, a table): the swipe is then its own. */
function scrollsSideways(el: Element | null): boolean {
  for (let n = el; n && n !== document.body; n = n.parentElement) {
    if (n instanceof HTMLInputElement || n instanceof HTMLTextAreaElement || (n instanceof HTMLElement && n.isContentEditable)) return true
    if (n instanceof HTMLElement && n.scrollWidth > n.clientWidth + 2) {
      const ox = getComputedStyle(n).overflowX
      if (ox === 'auto' || ox === 'scroll') return true
    }
  }
  return false
}

export function setupGestures(): void {
  const narrow = window.matchMedia('(max-width: 760px)')
  const root = document.documentElement
  let drag: Drag | null = null
  let pending: { mode: 'open' | 'close'; x0: number; y0: number } | null = null

  const parts = (): { app: HTMLElement; side: HTMLElement } | null => {
    const app = document.querySelector<HTMLElement>('.app')
    const side = document.querySelector<HTMLElement>('.sidebar')
    return app && side ? { app, side } : null
  }

  const paint = (d: Drag, el: { app: HTMLElement; side: HTMLElement }): void => {
    el.side.style.transform = `translateX(${(d.p - 1) * (d.width + 10)}px)`
    el.app.style.setProperty('--scrim', String(d.p))
  }

  const onStart = (e: TouchEvent): void => {
    pending = null
    if (!narrow.matches || e.touches.length !== 1 || useScreenUi.getState().open) return
    const t = e.touches[0]
    const target = e.target instanceof Element ? e.target : null
    // the screen of the PC and its sheets keep their own touches
    if (target?.closest('.pcscreen, .sheet, .sheet-scrim, .picker-pop, .ctx')) return
    const open = useStore.getState().sidebarOpen
    if (open) pending = { mode: 'close', x0: t.clientX, y0: t.clientY }
    else if (t.clientX <= EDGE || !scrollsSideways(target)) pending = { mode: 'open', x0: t.clientX, y0: t.clientY }
    // from the edge the swipe is certain; elsewhere it must be clearly sideways (decided in onMove)
    if (pending && pending.mode === 'open' && t.clientX > EDGE) pending.x0 = t.clientX
  }

  const begin = (mode: 'open' | 'close', x: number, y: number): void => {
    const el = parts()
    if (!el) return
    const width = el.side.offsetWidth || 320
    drag = { mode, x0: x, y0: y, width, p: mode === 'open' ? 0 : 1, v: 0, lastX: x, lastT: performance.now() }
    root.classList.add('drawer-drag')
    ;(document.activeElement as HTMLElement | null)?.blur?.()
  }

  const onMove = (e: TouchEvent): void => {
    const t = e.touches[0]
    if (!t) return
    if (!drag && pending) {
      const dx = t.clientX - pending.x0
      const dy = t.clientY - pending.y0
      const fromEdge = pending.mode === 'open' && pending.x0 <= EDGE
      if (Math.abs(dy) > 22 && Math.abs(dy) > Math.abs(dx)) {
        pending = null
        return
      }
      const ok = pending.mode === 'open' ? dx > MIN_MOVE && (fromEdge || dx > Math.abs(dy) * 1.6) : dx < -MIN_MOVE && -dx > Math.abs(dy) * 1.4
      if (!ok) return
      begin(pending.mode, t.clientX, t.clientY)
      pending = null
    }
    const d = drag
    if (!d) return
    const el = parts()
    if (!el) return
    if (e.cancelable) e.preventDefault()
    const dx = t.clientX - d.x0
    d.p = Math.min(1, Math.max(0, (d.mode === 'open' ? dx : d.width + dx) / d.width))
    const now = performance.now()
    const dt = now - d.lastT
    if (dt > 0) d.v = d.v * 0.6 + ((t.clientX - d.lastX) / dt) * 0.4
    d.lastX = t.clientX
    d.lastT = now
    paint(d, el)
  }

  const onEnd = (): void => {
    pending = null
    const d = drag
    drag = null
    if (!d) return
    const el = parts()
    // speed beats position: a quick flick opens or closes even when it did not get halfway
    const open = Math.abs(d.v) > 0.4 ? d.v > 0 : d.p > 0.5
    const changed = open !== (d.mode === 'close')
    flushSync(() => useStore.setState({ sidebarOpen: open }))
    root.classList.remove('drawer-drag')
    if (el) {
      el.side.style.removeProperty('transform')
      el.app.style.removeProperty('--scrim')
    }
    if (changed) navigator.vibrate?.(8)
  }

  document.addEventListener('touchstart', onStart, { passive: true })
  document.addEventListener('touchmove', onMove, { passive: false })
  document.addEventListener('touchend', onEnd)
  document.addEventListener('touchcancel', onEnd)
}
