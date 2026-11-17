// Motion on a phone: the phone's own choice (On, Reduced, Off, kept in this browser) and the screen's refresh rate decide how things
// move. Animations stay on by default whatever the system says (reduced motion, Low Power Mode, Save-Data): the page only adapts.
// The refresh rate is measured from requestAnimationFrame (about 1 s at start and each time the page comes back into view) and
// snapped to 30, 60, 90 or 120 Hz; iOS Low Power Mode caps the page at 30, which is measured, not guessed. phone-motion.css reads
// the root's data-hz and classes; the drawer and other frame-driven moves read frameMs().

export type MotionPref = 'on' | 'reduced' | 'off'
const KEY = 'jolty-motion'
const RATES = [30, 60, 90, 120]

let hz = 60
let measuring = false

export function motionPref(): MotionPref {
  try {
    const v = localStorage.getItem(KEY)
    return v === 'reduced' || v === 'off' ? v : 'on'
  } catch {
    return 'on'
  }
}

/** The length of one frame on this screen, in ms. */
export const frameMs = (): number => 1000 / hz

/** A duration in ms rounded to whole frames, so a move ends on a frame and never one short. */
export const onFrames = (ms: number): number => Math.max(1, Math.round(ms / frameMs())) * frameMs()

function apply(): void {
  const root = document.documentElement
  const pref = motionPref()
  root.classList.toggle('motion-reduced', pref === 'reduced')
  root.classList.toggle('motion-off', pref === 'off')
  // Off is the same switch the desktop app uses, so every animation in the app stops, not only the phone's
  root.classList.toggle('reduce-motion', pref === 'off')
  root.dataset.hz = String(hz)
  root.style.setProperty('--frame', `${frameMs().toFixed(2)}ms`)
}

export function setMotionPref(pref: MotionPref): void {
  try {
    localStorage.setItem(KEY, pref)
  } catch {
    // private mode: it still applies until the page is closed
  }
  apply()
  window.dispatchEvent(new CustomEvent('jolty:motion', { detail: pref }))
}

/** Snaps a measured frame interval to the nearest refresh rate a phone has. */
export function snapHz(intervalMs: number): number {
  const raw = 1000 / intervalMs
  return RATES.reduce((best, r) => (Math.abs(r - raw) < Math.abs(best - raw) ? r : best), 60)
}

/** About a second of frames; the median ignores the odd long frame of a page that is still loading. */
function measure(): void {
  if (measuring || document.hidden) return
  measuring = true
  const gaps: number[] = []
  let last = 0
  const t0 = performance.now()
  const tick = (t: number): void => {
    if (last) gaps.push(t - last)
    last = t
    if (t - t0 < 1000 && !document.hidden) return void requestAnimationFrame(tick)
    measuring = false
    if (gaps.length < 10) return
    const sorted = gaps.sort((a, b) => a - b)
    const next = snapHz(sorted[Math.floor(sorted.length / 2)])
    if (next !== hz) {
      hz = next
      apply()
    }
  }
  requestAnimationFrame(tick)
}

/** The browser's own bars (Android's address bar, the iOS status bar of an installed page) take the page colour of the theme. */
function barColour(colour: string): void {
  let meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]')
  if (!meta) {
    meta = document.createElement('meta')
    meta.name = 'theme-color'
    document.head.append(meta)
  }
  meta.content = colour
  // an installed page on iOS draws white status-bar text over the page (black-translucent): on the light theme it would vanish, so
  // the light theme asks for the plain bar with dark text (iOS reads this when the page starts; it applies from the next start)
  const ios = document.querySelector<HTMLMetaElement>('meta[name="apple-mobile-web-app-status-bar-style"]')
  if (ios) ios.content = document.documentElement.dataset.theme === 'frost' ? 'default' : 'black-translucent'
}

/** The theme changes under the finger: the old background fades away instead of the colours snapping. */
function themeFade(): void {
  const root = document.documentElement
  const page = (): string => getComputedStyle(root).getPropertyValue('--black').trim() || '#000'
  let bg = page()
  let theme = root.dataset.theme
  barColour(bg)
  new MutationObserver(() => {
    const next = root.dataset.theme
    const nextBg = page()
    if (next === theme) return
    theme = next
    const from = bg
    bg = nextBg
    barColour(nextBg)
    if (motionPref() === 'off' || !document.body) return
    const veil = document.createElement('div')
    veil.className = 'theme-veil'
    veil.style.background = from
    veil.addEventListener('animationend', () => veil.remove())
    document.body.append(veil)
    setTimeout(() => veil.remove(), 1200)
  }).observe(root, { attributes: true, attributeFilter: ['data-theme'] })
}

export function setupMotion(): void {
  apply()
  measure()
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) setTimeout(measure, 250)
  })
  window.addEventListener('pageshow', () => setTimeout(measure, 250))
  // another tab of the same phone changed it
  window.addEventListener('storage', (e) => e.key === KEY && apply())
  themeFade()
}
