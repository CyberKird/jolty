// A phone has no right click: iOS Safari never sends 'contextmenu' on a long press. A finger that rests on a row of the side menu
// (a conversation, a Live item) for half a second sends the same event the mouse would, so the menus that exist on the PC
// (pin, archive, rename, merge assistant, hide from Live...) open under the finger.

const HOLD = 480
const SLOP = 9
const SCOPE = '.sidebar'
const SKIP = 'input, textarea, button, a, [contenteditable="true"], .ctx'

export function setupLongPress(): void {
  let timer: ReturnType<typeof setTimeout> | undefined
  let x0 = 0
  let y0 = 0
  let fired = false

  const cancel = (): void => {
    clearTimeout(timer)
    timer = undefined
  }

  document.addEventListener(
    'touchstart',
    (e) => {
      cancel()
      fired = false
      const target = e.target instanceof Element ? e.target : null
      if (e.touches.length !== 1 || !target?.closest(SCOPE) || target.closest(SKIP)) return
      const t = e.touches[0]
      x0 = t.clientX
      y0 = t.clientY
      timer = setTimeout(() => {
        timer = undefined
        fired = true
        navigator.vibrate?.(12)
        target.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: x0, clientY: y0, view: window }))
      }, HOLD)
    },
    { passive: true }
  )
  document.addEventListener(
    'touchmove',
    (e) => {
      const t = e.touches[0]
      if (timer && t && Math.hypot(t.clientX - x0, t.clientY - y0) > SLOP) cancel()
    },
    { passive: true }
  )
  document.addEventListener(
    'touchend',
    (e) => {
      cancel()
      // the finger lifts after the menu opened: no tap must follow it (it would open the row or close the menu at once)
      if (fired && e.cancelable) e.preventDefault()
      fired = false
    },
    { passive: false }
  )
  document.addEventListener('touchcancel', cancel, { passive: true })
}
