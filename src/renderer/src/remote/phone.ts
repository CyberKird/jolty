import { tr } from '@shared/i18n'
import { useStore } from '../store'

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
    const fit = (): void => {
      document.documentElement.style.setProperty('--vvh', `${vv.height}px`)
      window.scrollTo(0, 0)
    }
    vv.addEventListener('resize', fit)
    fit()
  }
  installHint()
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
