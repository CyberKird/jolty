import { createApi } from '@shared/api-factory'
import { tr } from '@shared/i18n'
import type { JoltyApi } from '@shared/types'
import { screenBus } from './screen-bus'
import { clearOffline, offlineScreen } from './offline-screen'

// The same page runs in a phone's browser: there is no preload there, so the API is built over a WebSocket to the PC's Jolty.
// A phone is paired once (a code from Settings > Phone) and keeps its own key in this browser.

const KEY = 'jolty-remote-token'
const SNAP = 'jolty-snap:'
/** What the page shows at once from the last time, while the connection is still being made. */
const SNAPSHOT = /^(profiles:list|sessions:list|app:settings|sessions:history)$/
/** Reads can be asked again after the line broke; a send or a change is never repeated on its own. */
const SAFE = /^(profiles:list|sessions:(list|history|closed|connectors)|schedules:list|skills:list|usage:\w+|app:settings|updates:status|power:state)$/
/** A line that says nothing for this long is dead (a phone in a pocket does not get a close). */
const SILENT_MS = 24_000
const HELLO_MS = 12_000

function snapKey(channel: string, args: unknown[]): string | undefined {
  if (!SNAPSHOT.test(channel)) return undefined
  return channel === 'sessions:history' ? `${SNAP}history` : `${SNAP}${channel}`
}

function readSnap(channel: string, args: unknown[]): { value: unknown } | undefined {
  const key = snapKey(channel, args)
  if (!key) return undefined
  try {
    const j = JSON.parse(localStorage.getItem(key) || 'null') as { id?: unknown; value: unknown } | null
    if (!j || (channel === 'sessions:history' && j.id !== args[0])) return undefined
    return { value: j.value }
  } catch {
    return undefined
  }
}

function writeSnap(channel: string, args: unknown[], value: unknown): void {
  const key = snapKey(channel, args)
  if (!key) return
  try {
    const text = JSON.stringify({ id: channel === 'sessions:history' ? args[0] : undefined, value })
    if (text.length < 900_000) localStorage.setItem(key, text)
  } catch {
    // storage full or blocked: the page just opens the slower way
  }
}

interface Pending {
  resolve: (v: unknown) => void
  reject: (e: Error) => void
}

class Link {
  private ws?: WebSocket
  private ready = false
  private everReady = false
  private id = 0
  private pending = new Map<number, Pending & { channel: string; args: unknown[] }>()
  private listeners = new Map<string, Set<(data: unknown) => void>>()
  private waiters: Array<() => void> = []
  private delay = 400
  /** connection attempts that failed before the PC ever answered this time */
  private failed = 0
  private offlineShown = false
  private retryTimer?: ReturnType<typeof setTimeout>
  private helloTimer?: ReturnType<typeof setTimeout>
  private lastRx = 0
  private lastPing = 0
  /** the page was drawn from the last picture of the PC before this line was up */
  optimistic = false
  /** called when the line goes down or comes back, to tell the user */
  onState: (up: boolean) => void = () => undefined

  constructor(private token: string) {
    // the phone comes back to the page (unlocked, another app, a tunnel): the line is checked or remade at once, not after the old timers
    const wake = (): void => {
      if (document.visibilityState === 'hidden') return
      this.check()
    }
    document.addEventListener('visibilitychange', wake)
    window.addEventListener('online', wake)
    window.addEventListener('pageshow', wake)
    setInterval(() => this.beat(), 8000)
  }

  /** Resolves when the PC accepted the key for the first time. */
  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.open(resolve, reject)
    })
  }

  private first?: () => void
  private fail?: (e: Error) => void

  private open(first?: () => void, fail?: (e: Error) => void): void {
    this.first = first ?? this.first
    this.fail = fail ?? this.fail
    clearTimeout(this.retryTimer)
    this.retryTimer = undefined
    const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`)
    this.ws = ws
    ws.binaryType = 'arraybuffer'
    // a connection that hangs half-made is dropped and tried again, not waited on for as long as the browser would
    this.helloTimer = setTimeout(() => this.drop(ws), HELLO_MS)
    ws.onopen = () => ws.send(JSON.stringify({ t: 'auth', token: this.token }))
    ws.onmessage = (ev) => {
      this.lastRx = Date.now()
      // a picture of the PC's screen
      if (typeof ev.data !== 'string') return screenBus.frame(ev.data as ArrayBuffer)
      const m = JSON.parse(String(ev.data)) as { t: string; id?: number; ok?: boolean; value?: unknown; error?: string; channel?: string; data?: unknown; version?: string }
      if (m.t === 'pong') return
      if (m.t === 'screen') return screenBus.message(m as unknown as Record<string, unknown>)
      if (m.t === 'ready') {
        clearTimeout(this.helloTimer)
        const back = this.everReady
        screenBus.attach((msg) => ws.readyState === 1 && ws.send(JSON.stringify(msg)))
        this.ready = true
        this.everReady = true
        this.delay = 400
        this.failed = 0
        this.unknown = 0
        this.onState(true)
        refreshIfNewer(m.version)
        if (this.offlineShown) {
          this.offlineShown = false
          clearOffline()
        }
        for (const w of this.waiters.splice(0)) w()
        // while the phone was away, events were missed: the page catches up from the PC (remote/phone.ts), keeping what is typed
        if (back || this.optimistic) {
          this.optimistic = false
          window.dispatchEvent(new Event('jolty:resync'))
        }
        this.first?.()
        this.first = undefined
      } else if (m.t === 'res' && m.id !== undefined) {
        const p = this.pending.get(m.id)
        this.pending.delete(m.id)
        if (m.ok) {
          if (p) writeSnap(p.channel, p.args, m.value)
          p?.resolve(m.value)
        } else p?.reject(new Error(m.error || 'Failed'))
      } else if (m.t === 'ev' && m.channel) {
        for (const cb of this.listeners.get(m.channel) || []) cb(m.data)
      }
    }
    ws.onclose = (ev) => this.lost(ws, ev.code, ev.reason)
  }

  /** Cuts a line that is not answering; the close handler does the rest. */
  private drop(ws: WebSocket): void {
    if (this.ws !== ws) return
    ws.onclose = null
    ws.onmessage = null
    try {
      ws.close()
    } catch {
      // already gone
    }
    this.lost(ws, 1006, '')
  }

  /** how many times in a row the PC said it does not know the key */
  private unknown = 0

  private lost(ws: WebSocket, code: number, reason: string): void {
    if (this.ws !== ws) return
    this.ws = undefined
    clearTimeout(this.helloTimer)
    const wasUp = this.ready
    this.ready = false
    if (wasUp) this.onState(false)
    screenBus.message({ t: 'screen', op: 'ended', reason: 'link' })
    // what was in the air: reads go again when the line is back, the rest is told it did not get through
    const redo: Array<[string, unknown[], Pending]> = []
    for (const p of this.pending.values()) {
      if (SAFE.test(p.channel)) redo.push([p.channel, p.args, p])
      else p.reject(new Error('Connection to the PC lost'))
    }
    this.pending.clear()
    for (const [channel, args, p] of redo) void this.issue(channel, args, false).then(p.resolve, p.reject)
    // Only the PC saying "I do not know this key" ends the pairing, and not on the first word: the key is tried once more by the cookie the PC set
    // when this phone was paired (a storage that was cleared does not unpair a phone). Every other way a line closes is the line, not the key.
    if (code === 4401 && (reason === 'revoked' || reason === 'unknown key')) {
      if (reason === 'unknown key' && ++this.unknown < 2) this.token = ''
      else {
        localStorage.removeItem(KEY)
        if (!this.everReady || this.optimistic) return this.fail?.(new Error('This phone is no longer paired. Open the pairing link from Jolty again.'))
        // revoked while the app was open: back to the pairing screen (nothing typed is worth keeping for a phone that was cut off)
        location.reload()
        return
      }
    }
    // the PC does not answer (off, asleep, no Tailscale): the page says so and offers to start it, the tries go on behind it
    if (!this.everReady && ++this.failed >= 2 && !this.offlineShown) {
      this.offlineShown = true
      offlineScreen(() => {
        this.delay = 400
      }, this.optimistic)
    }
    this.retryTimer = setTimeout(() => this.open(), this.delay + Math.random() * 250)
    this.delay = Math.min(Math.round(this.delay * 1.7), 4000)
  }

  /** The phone is back in view: a line that looks up is asked to prove it, one that is down is remade now. */
  private check(): void {
    const ws = this.ws
    if (this.ready && ws) {
      this.probe(ws)
      return
    }
    if (!ws && this.retryTimer) {
      this.delay = 400
      this.open()
    } else if (ws && ws.readyState === WebSocket.CONNECTING) {
      // a try made while the network was changing: start over on the new one
      this.drop(ws)
    }
  }

  private probe(ws: WebSocket): void {
    const sent = Date.now()
    this.lastPing = sent
    if (ws.readyState === 1) ws.send(JSON.stringify({ t: 'ping' }))
    setTimeout(() => {
      if (this.ws === ws && this.ready && this.lastRx < sent) this.drop(ws)
    }, 4000)
  }

  private beat(): void {
    const ws = this.ws
    if (!ws || !this.ready || document.visibilityState === 'hidden') return
    if (Date.now() - this.lastRx > SILENT_MS) return this.drop(ws)
    if (Date.now() - this.lastPing > 10_000) this.probe(ws)
  }

  private whenReady(): Promise<void> {
    return this.ready ? Promise.resolve() : new Promise((resolve) => this.waiters.push(resolve))
  }

  call = <T>(channel: string, ...args: unknown[]): Promise<T> => this.issue<T>(channel, args, true)

  private async issue<T>(channel: string, args: unknown[], fromSnapshot: boolean): Promise<T> {
    if (!this.ready && fromSnapshot) {
      // the last picture the PC gave answers while the line is being made: the page opens at once, and is refreshed when the PC answers
      const snap = readSnap(channel, args)
      if (snap) return snap.value as T
    }
    while (!this.ready || this.ws?.readyState !== 1) await this.whenReady()
    const id = ++this.id
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, channel, args })
      this.ws?.send(JSON.stringify({ t: 'call', id, channel, args }))
    })
  }

  listen = (channel: string, cb: (data: unknown) => void): (() => void) => {
    const set = this.listeners.get(channel) || new Set()
    set.add(cb)
    this.listeners.set(channel, set)
    return () => set.delete(cb)
  }
}

async function claim(code: string): Promise<string> {
  const name = /iPhone/.test(navigator.userAgent) ? 'iPhone' : /Android/.test(navigator.userAgent) ? 'Android' : 'Browser'
  const res = await fetch('/api/pair', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code, name }) })
  const j = (await res.json().catch(() => ({}))) as { token?: string; error?: string }
  if (!res.ok || !j.token) throw new Error(j.error || 'Pairing failed')
  return j.token
}

/** The pairing screen: asks for the code shown at the PC, or says what went wrong. */
async function pairScreen(message?: string): Promise<string> {
  const { pairScreen: show } = await import('./pair-screen')
  return show(message, claim)
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
  let token = localStorage.getItem(KEY) || ''
  const fromLink = /[#&]pair=([0-9A-Za-z]+)/.exec(location.hash)?.[1]
  let note: string | undefined
  // the key is also kept by the PC's cookie: a phone whose own storage was cleared (Safari does it to pages not opened for a week) is still paired
  let viaCookie = false
  if (!token && !fromLink) viaCookie = await fetch('/api/session', { cache: 'no-store' }).then((r) => r.ok, () => false)
  if (!token && fromLink) {
    try {
      token = await claim(fromLink)
    } catch (e) {
      note = e instanceof Error ? e.message : String(e)
    }
  }
  history.replaceState(null, '', location.pathname)
  for (;;) {
    if (!token && !viaCookie) token = await pairScreen(note)
    if (token) localStorage.setItem(KEY, token)
    const link = new Link(token)
    try {
      // paired before and the last picture of the PC is kept: the page opens from it at once and the line is made behind it
      // (a poor connection no longer means a blank screen); a key the PC no longer knows sends the phone back to pairing
      if (localStorage.getItem(`${SNAP}sessions:list`)) {
        link.optimistic = true
        void link.start().catch(() => location.reload())
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
      note = e instanceof Error ? e.message : String(e)
      token = ''
      viaCookie = false
    }
  }
}
