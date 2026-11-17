import { createApi } from '@shared/api-factory'
import { tr } from '@shared/i18n'
import type { JoltyApi } from '@shared/types'
import { askPaired, dropKey, loadKey, renewCookie, saveKey } from './keystore'
import { Link, SNAP } from './link'

// The same page runs in a phone's browser: there is no preload there, so the API is built over a WebSocket to the PC's Jolty.
// A phone is paired once (a code from Settings > Phone) and keeps its own key in this browser.

async function claim(code: string): Promise<string> {
  const name = /iPhone/.test(navigator.userAgent) ? 'iPhone' : /Android/.test(navigator.userAgent) ? 'Android' : 'Browser'
  const res = await fetch('/api/pair', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code, name }) })
  const j = (await res.json().catch(() => ({}))) as { token?: string; error?: string }
  if (!res.ok || !j.token) throw new Error(j.error || 'Pairing failed')
  return j.token
}

/** The pairing screen: asks for the code shown at the PC, or says what went wrong. */
async function pairScreen(message?: string, over = false): Promise<string> {
  const { pairScreen: show } = await import('./pair-screen')
  return show(message, claim, over)
}

/**
 * The pairing screen, while the key this phone already holds keeps being tried behind it: when the PC knows it again (its list
 * of phones could not be read for a moment, Jolty was restarting) the old key wins and nothing was lost. Resolves with the
 * key to use: the old one, or the new one from a code. A phone revoked at the PC stops trying its old key.
 */
async function pairAgain(note: string | undefined, old: string, over = false): Promise<string> {
  let done = false
  const watch = new Promise<string>((resolve) => {
    if (note && /no longer paired/.test(note)) return
    const tick = async (): Promise<void> => {
      if (done) return
      const r = await askPaired(old)
      if (done) return
      if (r === 'yes') return resolve(old)
      if (r === 'revoked') return void dropKey()
      setTimeout(() => void tick(), 6000)
    }
    setTimeout(() => void tick(), 3000)
  })
  const token = await Promise.race([pairScreen(note, over), watch])
  done = true
  return token
}

/**
 * Once the page is up and the phone idle, the service worker keeps the rest of the phone's scripts (the pages not opened
 * yet), so opening one later does not wait for the network. Not on a phone that asks to save data, nor on a slow or far line.
 */
let warmed = false
function warmOnce(link: Link): void {
  if (warmed) return
  warmed = true
  const c = (navigator as unknown as { connection?: { saveData?: boolean; effectiveType?: string } }).connection
  if (c?.saveData || /2g/.test(c?.effectiveType || '')) return
  const later = window.requestIdleCallback ?? ((cb: () => void) => window.setTimeout(cb, 2000))
  // a far or slow line (a relay, weak signal) keeps its bandwidth for what the user opens: decided once the line was measured
  window.setTimeout(() => later(() => !link.slow() && void navigator.serviceWorker?.ready.then((r) => r.active?.postMessage('warm')), { timeout: 10000 }), 5000)
}

const UPDATING = 'jolty-updating'
const updating = (): boolean => Date.now() - Number(sessionStorage.getItem(UPDATING) || 0) < 5 * 60_000

/**
 * Jolty on the PC was updated while this page was kept on the phone: the page is the old copy. Once the PC says its version, the kept copies
 * are dropped and the page loads again, so the phone runs the new one (once per version, and never over text that is being typed).
 */
function refreshIfNewer(version?: string): void {
  const mine = (window as unknown as { joltyVersion?: string }).joltyVersion
  if (!version || !mine || version === mine || sessionStorage.getItem('jolty-reloaded') === version) return
  const box = document.querySelector<HTMLTextAreaElement>('.composer textarea')
  if (box?.value.trim()) return
  sessionStorage.setItem('jolty-reloaded', version)
  void (async () => {
    try {
      for (const k of await caches.keys()) await caches.delete(k)
      for (const r of (await navigator.serviceWorker?.getRegistrations()) ?? []) await r.unregister()
    } catch {
      // the page just loads again
    }
    location.reload()
  })()
}

/** A small note over the page while the line to the PC is down (shown after a moment, so a short blink does not flash it). */
function linkPill(link: Link): void {
  const pill = document.createElement('div')
  pill.className = 'link-pill'
  pill.setAttribute('role', 'status')
  const dot = document.createElement('i')
  const text = document.createElement('span')
  text.textContent = tr('Se reconectează la PC…')
  pill.append(dot, text)
  document.body.append(pill)
  let timer: ReturnType<typeof setTimeout> | undefined
  link.onState = (up) => {
    clearTimeout(timer)
    if (up) {
      sessionStorage.removeItem(UPDATING)
      pill.classList.remove('on')
      return
    }
    // an update is installing: Jolty is closed and opened again, say that and do not wait to say it
    const busy = updating()
    text.textContent = busy ? tr("Jolty se actualizează. Telefonul se reconectează singur.") : tr("Se reconectează la PC…")
    timer = setTimeout(() => pill.classList.add('on'), busy ? 0 : 1800)
  }
  // opened from the last picture: the line is not up yet
  if (link.optimistic) link.onState(false)
}

/** Sets window.jolty for a browser that is not the desktop window. */
export async function connectRemote(): Promise<void> {
  document.documentElement.classList.add('remote')
  // the page is kept on the phone, so it opens when the PC is off
  void navigator.serviceWorker?.register('/sw.js').catch(() => undefined)
  let token = await loadKey()
  const fromLink = /[#&]pair=([0-9A-Za-z]+)/.exec(location.hash)?.[1]
  let note: string | undefined
  if (!token && fromLink) {
    try {
      token = await claim(fromLink)
      await saveKey(token)
    } catch (e) {
      note = e instanceof Error ? e.message : String(e)
    }
  }
  history.replaceState(null, '', location.pathname)
  // a phone that has never been paired here (no key, nothing kept): the pairing screen comes first, without a warning
  const before = Boolean(token || localStorage.getItem(`${SNAP}sessions:list`))
  // with no key of its own the phone still tries: the PC's cookie may name it (its own storage was cleared). Only the PC's
  // answer decides; a PC that does not answer shows the "not answering" screen, never the pairing one.
  if (!token && note) token = await pairAgain(note, '')
  for (;;) {
    const link = new Link(token)
    link.onVersion = refreshIfNewer
    // every connection keeps the key in all three places again (the cookie included)
    link.onReady = () => {
      warmOnce(link)
      if (!token) return
      void saveKey(token)
      renewCookie(token)
    }
    try {
      // paired before and the last picture of the PC is kept: the page opens from it at once and the line is made behind it
      // (a poor connection no longer means a blank screen); a key the PC does not know leads to the pairing screen, the key kept
      if (localStorage.getItem(`${SNAP}sessions:list`)) {
        link.optimistic = true
        const kept = token
        void link.start().catch(async (e: unknown) => {
          const fresh = await pairAgain(e instanceof Error ? e.message : String(e), kept, true)
          if (fresh !== kept) await saveKey(fresh)
          location.reload()
        })
      } else await link.start()
      const api = createApi(link.call, link.listen, () => '')
      linkPill(link)
      // the PC's clipboard and browser are not the phone's: copying and links happen on the phone itself
      api.app.copyText = async (text) => void (await navigator.clipboard?.writeText(text).catch(() => undefined))
      api.app.openExternal = async (url) => void window.open(url, '_blank', 'noopener')
      api.app.openLink = async (url) => void window.open(url, '_blank', 'noopener')
      // no see-through window on a phone
      api.app.glassSupport = async () => 'os'
      // an update of Jolty from the phone: the tap is the yes, the PC restarts and this page reconnects by itself
      link.listen('jolty:event', (e) => (e as { type?: string })?.type === 'restarting' && sessionStorage.setItem(UPDATING, String(Date.now())))
      api.updates.install = async () => {
        if (!window.confirm(tr("Actualizezi Jolty pe PC? Se închide și se pornește din nou, iar telefonul se reconectează singur în câteva zeci de secunde. Ce lucrează acum se oprește, conversațiile rămân."))) return
        sessionStorage.setItem(UPDATING, String(Date.now()))
        try {
          await link.call('updates:installFromPhone')
        } catch (e) {
          // Jolty closing is the update starting, not a failure
          if (/connection to the pc lost/i.test(String(e))) return
          sessionStorage.removeItem(UPDATING)
          window.alert(e instanceof Error ? e.message : String(e))
        }
      }
      ;(window as unknown as { jolty: JoltyApi }).jolty = api
      return
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e)
      const fresh = await pairAgain(before || /no longer paired/.test(reason) ? reason : undefined, token)
      // the old key works again: the page starts over with it, as if nothing happened
      if (fresh === token) {
        location.reload()
        return new Promise<void>(() => undefined)
      }
      token = fresh
      await saveKey(token)
    }
  }
}
