import { tr } from '@shared/i18n'

// Pull down in the side menu (when it is scrolled to its top) and let go: the phone asks the PC for a fresh picture of everything
// (what runs, what waits, the lists, the open conversation). There is no browser refresh in an installed page, so this is the way.

const TRIGGER = 72
const MAX = 120

export function setupPullRefresh(): void {
  let y0 = 0
  let x0 = 0
  let pulling = false
  let target: HTMLElement | null = null
  let dy = 0
  let busy = false
  const el = document.createElement('div')
  el.className = 'pull-refresh'
  el.setAttribute('aria-hidden', 'true')
  el.innerHTML = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-3-6.7"/><path d="M21 3v6h-6"/></svg>'
  document.body.append(el)

  const show = (p: number): void => {
    el.style.setProperty('--p', String(Math.min(1, p / TRIGGER)))
    el.style.setProperty('--y', `${Math.min(p, MAX) * 0.6}px`)
    el.classList.toggle('on', p > 6)
    el.classList.toggle('ready', p >= TRIGGER)
  }
  const hide = (): void => {
    el.classList.remove('on', 'ready', 'spin')
    el.style.setProperty('--y', '0px')
  }

  document.addEventListener(
    'touchstart',
    (e) => {
      pulling = false
      const side = e.target instanceof Element ? e.target.closest<HTMLElement>('.sidebar') : null
      if (busy || !side || e.touches.length !== 1 || side.scrollTop > 0) return
      target = side
      y0 = e.touches[0].clientY
      x0 = e.touches[0].clientX
      dy = 0
      pulling = true
    },
    { passive: true }
  )
  document.addEventListener(
    'touchmove',
    (e) => {
      if (!pulling || !target) return
      const t = e.touches[0]
      const d = t.clientY - y0
      // sideways (the drawer's swipe) or up (a scroll): not a pull
      if (d < 0 || target.scrollTop > 0 || Math.abs(t.clientX - x0) > Math.abs(d)) {
        pulling = false
        show(0)
        return
      }
      dy = d
      if (d > 8 && e.cancelable) e.preventDefault()
      show(d)
    },
    { passive: false }
  )
  const end = (): void => {
    if (!pulling) return
    pulling = false
    if (dy < TRIGGER) return show(0)
    busy = true
    el.classList.add('spin')
    const done = (): void => {
      window.removeEventListener('jolty:refreshed', done)
      clearTimeout(cap)
      // a moment of the spinner even on a fast line, so the user sees something happened
      setTimeout(() => {
        busy = false
        hide()
      }, 500)
    }
    const cap = setTimeout(done, 8000)
    window.addEventListener('jolty:refreshed', done)
    window.dispatchEvent(new Event('jolty:refresh'))
  }
  document.addEventListener('touchend', end, { passive: true })
  document.addEventListener('touchcancel', () => {
    pulling = false
    show(0)
  }, { passive: true })
  el.title = tr("Reîmprospătează")
}
