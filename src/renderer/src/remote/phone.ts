import { tr } from '@shared/i18n'
import { api, useStore } from '../store'
import { play, soundsOn, unlockAudio } from '../mascot/sfx'
import { setupGestures } from './gestures'

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
    // the tallest the page has been with no field being typed in: below that by a keyboard's height, the keyboard is up
    let full = vv.height
    let frame = 0
    const typing = (): boolean => {
      const a = document.activeElement
      return a instanceof HTMLTextAreaElement || a instanceof HTMLInputElement || (a instanceof HTMLElement && a.isContentEditable)
    }
    const apply = (): void => {
      frame = 0
      const root = document.documentElement
      if (!typing()) full = Math.max(full, vv.height)
      const kb = vv.height < full - 110
      const messages = document.querySelector<HTMLElement>('.messages')
      // at the bottom of the conversation the newest message stays in view when the keyboard comes up
      const atEnd = !!messages && messages.scrollHeight - messages.scrollTop - messages.clientHeight < 90
      const was = root.classList.contains('kb')
      root.style.setProperty('--vvh', `${vv.height}px`)
      // iOS also scrolls the page up to show the focused field: the page follows the visible area (offsetTop) instead of staying put
      root.style.setProperty('--vvt', `${vv.offsetTop}px`)
      root.classList.toggle('kb', kb)
      if (kb !== was && atEnd && messages) requestAnimationFrame(() => (messages.scrollTop = messages.scrollHeight))
    }
    // once per frame: the keyboard's slide fires many events, and the page follows it in step instead of stuttering behind
    const fit = (): void => {
      if (!frame) frame = requestAnimationFrame(apply)
    }
    vv.addEventListener('resize', fit)
    vv.addEventListener('scroll', fit)
    document.addEventListener('focusin', () => {
      fit()
      // iOS scrolls the whole page to the field; the page is fixed, so it is put back
      window.setTimeout(() => window.scrollTo(0, 0), 60)
    })
    document.addEventListener('focusout', () => window.setTimeout(fit, 120))
    // turning the phone changes what "full" is
    window.addEventListener('orientationchange', () => window.setTimeout(() => ((full = vv.height), fit()), 400))
    apply()
  }
  setupGestures()
  installHint()
  phoneSounds()
  keepWake()
  window.addEventListener('jolty:resync', resync)
}

/**
 * The phone was away (locked, another app, no signal) and missed events. The PC replays what is running and what waits for a yes
 * right after this; here the lists and the open conversation are read again, and the message box is not touched.
 */
/** The way to wake the PC stays on the phone: when the PC is off nothing can be asked of it. */
function keepWake(): void {
  void api.remote.wakeConfig().then(
    (c) => (c ? localStorage.setItem('jolty-wake', JSON.stringify(c)) : localStorage.removeItem('jolty-wake')),
    () => undefined
  )
}

function resync(): void {
  keepWake()
  const s = useStore.getState()
  // what was running or asked is told again by the PC: forget the old picture first, so a turn that ended while away does not stay "running"
  useStore.setState({ status: {}, permissions: {} })
  void s.loadProfiles()
  void s.loadSessions()
  void s.loadUsage()
  const id = s.activeId
  const keep = Object.fromEntries(Object.keys(s.transcripts).filter((k) => k === id).map((k) => [k, s.transcripts[k]]))
  useStore.setState({ transcripts: keep })
  if (id) void api.sessions.history(id).then((items) => useStore.setState((st) => ({ transcripts: { ...st.transcripts, [id]: items } })), () => undefined)
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
