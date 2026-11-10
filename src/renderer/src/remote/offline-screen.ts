import { tr } from '@shared/i18n'
import type { WakeConfig } from '@shared/remote'
import { brandBar, el } from './pair-screen'

// Shown when the PC does not answer: if it is off, the phone can ask the wake agent (a small program on a device that stays on
// in the same network, see tools/wake-agent.py) to send it the Wake-on-LAN packet. Plain DOM, like the pairing screen: the page
// comes from the cache and the app behind it does not exist yet.

export const WAKE_KEY = 'jolty-wake'

export function savedWake(): WakeConfig | null {
  try {
    const v = JSON.parse(localStorage.getItem(WAKE_KEY) || 'null') as WakeConfig | null
    return v && typeof v.url === 'string' && typeof v.token === 'string' ? v : null
  } catch {
    return null
  }
}

let timer: ReturnType<typeof setInterval> | undefined

const clock = (s: number): string => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`

/** Asks the agent to send the packet; resolves with a sentence for the user when it could not. */
async function ask(w: WakeConfig): Promise<string | undefined> {
  try {
    const res = await fetch(`${w.url}/wake`, { method: 'POST', headers: { Authorization: `Bearer ${w.token}` }, signal: AbortSignal.timeout(10000) })
    if (res.ok) return undefined
    return tr("Agentul a refuzat semnalul.")
  } catch {
    return tr("Nu pot ajunge la agentul de pornire. Verifică Tailscale pe telefon.")
  }
}

/** Puts the screen up; the connection keeps trying behind it and the app takes over the moment the PC answers. */
export function offlineScreen(retry: () => void): void {
  const root = document.getElementById('root')!
  const wake = savedWake()
  root.replaceChildren()
  const page = el('div', 'pair offline')
  const form = el('div', 'pair-body')
  const headline = el('h1', 'pair-headline', tr("PC-ul nu răspunde"))
  headline.append(el('span', undefined, '.'))
  const note = el('p', 'pair-note', wake ? tr("Dacă e oprit, îl poți porni de aici.") : tr("Verifică dacă PC-ul e pornit și Jolty deschis. Pornirea de pe telefon se activează din Setări, Telefon, pe PC."))
  const pulse = el('div', 'offline-pulse')
  pulse.hidden = true
  pulse.innerHTML = '<svg width="20" height="72" viewBox="0 0 205 740" aria-hidden="true"><polygon points="52,0 170,0 118,300 205,284 56,740 84,408 0,426"/></svg>'
  const status = el('p', 'pair-note offline-status')
  const go = el('button', 'btn primary pair-go', tr("Pornește PC-ul"))
  go.type = 'button'
  const again = el('button', 'btn pair-go ghost-go', tr("Încearcă din nou"))
  again.type = 'button'
  const error = el('p', 'pair-error')
  error.setAttribute('role', 'alert')

  let since = 0
  go.addEventListener('click', async () => {
    if (!wake) return
    go.disabled = true
    error.textContent = ''
    status.textContent = tr("Se trimite semnalul…")
    const problem = await ask(wake)
    if (problem) {
      go.disabled = false
      status.textContent = ''
      error.textContent = problem
      return
    }
    // the PC takes a minute: the clock shows the phone is still waiting for it
    pulse.hidden = false
    since = Date.now()
    clearInterval(timer)
    const tick = (): void => {
      status.textContent = `${tr("Semnalul a plecat. PC-ul are nevoie de aproximativ un minut ca să pornească.")} ${tr("Așteptăm PC-ul: {t}", { t: clock(Math.round((Date.now() - since) / 1000)) })}`
    }
    tick()
    timer = setInterval(tick, 1000)
    // another signal is allowed after a while, in case the first one was lost
    setTimeout(() => (go.disabled = false), 45000)
  })
  again.addEventListener('click', retry)

  form.append(headline, note, pulse, status)
  if (wake) form.append(go)
  form.append(again, error)
  page.append(brandBar(), form)
  root.append(page)
}

/** The app is about to start: the screen goes. */
export function clearOffline(): void {
  clearInterval(timer)
  document.getElementById('root')?.replaceChildren()
}
