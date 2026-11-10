import { tr } from '@shared/i18n'
import { api, useStore } from '../store'
import { play, soundsOn, unlockAudio } from '../mascot/sfx'

/** Behaviour only a phone needs: the sidebar is a drawer, closed at the start and after a conversation or page is chosen. */
export function setupPhone(): void {
  const narrow = window.matchMedia('(max-width: 760px)')
  if (narrow.matches) useStore.setState({ sidebarOpen: false, liveOpen: false })
  let last = ''
  useStore.subscribe((s) => {
    const now = `${s.activeId}|${s.page}`
    if (now !== last && narrow.matches && s.sidebarOpen) useStore.setState({ sidebarOpen: false })
    last = now
  })
  // a tap on the dimmed chat beside the open drawer (drawn by .app::after) closes it
  document.addEventListener('click', (e) => {
    if (narrow.matches && e.target instanceof HTMLElement && e.target.classList.contains('app') && useStore.getState().sidebarOpen) useStore.setState({ sidebarOpen: false })
  })
  // the visible height: on iOS the keyboard covers the page instead of shrinking it, so the composer would hide under it
  const vv = window.visualViewport
  if (vv) {
    // iOS also scrolls the page up to show the focused field: the page follows the visible area (offsetTop) instead of staying put
    const fit = (): void => {
      const root = document.documentElement.style
      root.setProperty('--vvh', `${vv.height}px`)
      root.setProperty('--vvt', `${vv.offsetTop}px`)
    }
    vv.addEventListener('resize', fit)
    vv.addEventListener('scroll', fit)
    fit()
  }
  installHint()
  phoneSounds()
}

/** The mascot is not on a phone, so its sounds are not either: the same soft ones tell when a turn ends, fails or needs a yes. */
function phoneSounds(): void {
  void api.app.settings().then((s) => soundsOn(s.mascotSounds !== false))
  document.addEventListener('pointerdown', unlockAudio, { once: true })
  const running = new Set<string>()
  api.sessions.onEvent((e) => {
    if (e.type === 'status') {
      const was = running.delete(e.sessionId)
      if (e.status === 'running') running.add(e.sessionId)
      else if (was) play(e.status === 'error' ? 'worry' : 'cheer')
    } else if (e.type === 'permission') play('blip')
  })
}

/** In Safari on an iPhone: how to put Jolty on the home screen (a home screen app keeps its own storage, so it is paired again there). */
function installHint(): void {
  const standalone = (navigator as unknown as { standalone?: boolean }).standalone === true || window.matchMedia('(display-mode: standalone)').matches
  if (standalone || !/iPhone|iPad/.test(navigator.userAgent) || localStorage.getItem('jolty-install-hint')) return
  const box = document.createElement('div')
  box.className = 'install-hint'
  const text = document.createElement('span')
  text.textContent = tr("Ca aplicație: apasă Partajează, apoi „Adaugă pe ecranul principal”. Aplicația cere din nou un cod: apasă „Împerechează un telefon” pe PC.")
  const close = document.createElement('button')
  close.textContent = tr("Închide")
  close.onclick = () => {
    localStorage.setItem('jolty-install-hint', '1')
    box.remove()
  }
  box.append(text, close)
  document.body.append(box)
}
