import { screenBus } from './screen-bus'
import { clearOffline, offlineScreen } from './offline-screen'
import { dropKey } from './keystore'

// The line to the PC's Jolty: one WebSocket that carries calls (with answers) and events, made for bad phone networks.
// - Every event has a number. A phone that lost the line says the last number it got and receives exactly what it missed
//   (main/remote-events.ts); only when the PC cannot give that (it restarted, or too much happened) is everything read again.
// - Reads are asked again after a cut. An action (a message, a yes) carries its own id and is sent again with it once
//   the line is back: the PC answers from what it already did, so nothing is done twice and nothing is silently lost.
// - The line is checked by pings, with a patience measured from the line itself: a slow line is not a dead one.
// - Only the PC saying "revoked" unpairs the phone. "Unknown key" while the page is up is waited out.

export const SNAP = 'jolty-snap:'
/** What the page shows at once from the last time, while the connection is still being made. */
const SNAPSHOT = /^(profiles:list|sessions:list|app:settings|sessions:history)$/
/** Reads can be asked again after the line broke; anything else is sent again only with its id (see above). */
const SAFE = /^(profiles:list|sessions:(list|history|closed|connectors)|schedules:list|skills:list|usage:\w+|app:settings|updates:status|power:state|remote:wakeConfig)$/
/** A line that says nothing for this long is dead (a phone in a pocket does not get a close). */
const SILENT_MS = 24_000
const HELLO_MS = 12_000
/** an action waits this long for the line to come back before the user is told it did not get through */
const HOLD_MS = 60_000

function snapKey(channel: string): string | undefined {
  if (!SNAPSHOT.test(channel)) return undefined
  return channel === 'sessions:history' ? `${SNAP}history` : `${SNAP}${channel}`
}

function readSnap(channel: string, args: unknown[]): { value: unknown } | undefined {
  const key = snapKey(channel)
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
  const key = snapKey(channel)
  if (!key) return
  // a very long conversation would not fit anyway: it is not turned into text just to be thrown away (a slow phone feels that)
  if (Array.isArray(value) && value.length > 1500) return
  try {
    const text = JSON.stringify({ id: channel === 'sessions:history' ? args[0] : undefined, value })
    if (text.length < 900_000) localStorage.setItem(key, text)
  } catch {
    // storage full or blocked: the page just opens the slower way
  }
}

const newKey = (): string => (crypto.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`).replace(/[^\w-]/g, '')

interface Pending {
  resolve: (v: unknown) => void
  reject: (e: Error) => void
  channel: string
  args: unknown[]
  /** the action's own id: sent again with it after a cut */
  k?: string
}

type Msg = { t: string; id?: number; ok?: boolean; value?: unknown; error?: string; channel?: string; data?: unknown; version?: string; s?: number; list?: Array<[string, unknown]>; epoch?: string; seq?: number; resumed?: boolean }

export class Link {
  private ws?: WebSocket
  private ready = false
  private everReady = false
  private id = 0
  private pending = new Map<number, Pending>()
  /** actions whose answer was lost with the line, waiting for it to come back */
  private held: Array<{ p: Pending; until: number }> = []
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
  /** connection tries in a row that ran out of time (each next one waits longer) */
  private slowTries = 0
  /** the PC said this key is not to be used: no more tries from this link */
  private stopped = false
  private started = false
  /** when the system froze the page (Android Chrome's Page Lifecycle), to judge the line when it comes back */
  private frozenAt = 0
  /** smoothed round trip of a ping (ms) */
  private rtt = 0
  /** when the current connection try started, and how long the last one took to be accepted */
  private opened = 0
  private connectMs = 0
  /** the PC's run and the number of the last event received from it */
  private epoch?: string
  private seq = 0
  /**
   * What is running or asked right now, as the events that told it (the newest per session / question). The PC tells this right after
   * the line is up, often before the page has mounted and subscribed: whoever subscribes to the events later gets it from here, so
   * a turn that started on the PC is in Live on the phone from the first picture.
   */
  private state = new Map<string, { channel: string; data: Record<string, unknown>; at: number }>()
  /** the page was drawn from the last picture of the PC before this line was up */
  optimistic = false
  /** called when the line goes down or comes back, to tell the user */
  onState: (up: boolean) => void = () => undefined
  /** called when the PC answered and the line is up (the key is then kept again everywhere) */
  onReady: () => void = () => undefined
  /** called with the PC's version on every connection */
  onVersion: (version?: string) => void = () => undefined

  constructor(private token: string) {
    // the phone comes back to the page (unlocked, another app, a tunnel): the line is checked or remade at once, not after the old timers
    const wake = (): void => {
      if (document.visibilityState === 'hidden') return
      this.check()
    }
    document.addEventListener('visibilitychange', wake)
    window.addEventListener('online', wake)
    window.addEventListener('pageshow', wake)
    // another network (Wi-Fi to cellular, a new address, Tailscale going from relay to direct): the old line may be dead without a word.
    // It is proven with a ping at once; a try that was being made on the old network starts over on the new one.
    const net = (navigator as unknown as { connection?: EventTarget }).connection
    net?.addEventListener?.('change', wake)
    // the browser says the network is gone: the next try waits for it to come back ('online') instead of piling up failures
    window.addEventListener('offline', () => (this.delay = Math.max(this.delay, 2000)))
    // Android Chrome freezes a page in the background (Doze, battery saver, a tab not in view) without closing its socket; after a
    // long freeze the line is gone for sure and is remade at once instead of waiting for a ping to fail
    document.addEventListener('freeze', () => (this.frozenAt = Date.now()))
    document.addEventListener('resume', () => {
      const long = this.frozenAt && Date.now() - this.frozenAt > SILENT_MS
      this.frozenAt = 0
      if (long && this.ws) this.drop(this.ws)
      else wake()
    })
    // leaving the page (both systems): the socket is closed so the browser can keep the page whole for the back button; 'pageshow' remakes it
    window.addEventListener('pagehide', (e) => {
      if (!(e as PageTransitionEvent).persisted || !this.ws) return
      const ws = this.ws
      ws.onclose = null
      this.lost(ws, 1001, '')
      clearTimeout(this.retryTimer)
      this.retryTimer = undefined
      try {
        ws.close(1000)
      } catch {
        // already closed
      }
    })
    setInterval(() => this.beat(), 4000)
    // the user asks for a fresh picture (pull down in the side menu, or the button there)
    window.addEventListener('jolty:refresh', () => this.refresh())
  }

  private refreshing = false

  /**
   * A new line to the PC that is not a resumed one: the PC tells again what runs and what waits, the lists and the open conversation
   * are read again (remote/phone.ts), whatever the phone thought it knew. 'jolty:refreshed' tells the pull indicator it is done.
   */
  refresh(): void {
    if (!this.started || this.stopped) return
    this.refreshing = true
    this.epoch = undefined
    this.delay = 400
    const ws = this.ws
    if (ws) this.drop(ws)
    else this.open()
  }

  /** Resolves when the PC accepted the key for the first time. */
  start(): Promise<void> {
    this.started = true
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
    this.opened = Date.now()
    const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`)
    this.ws = ws
    ws.binaryType = 'arraybuffer'
    // a connection that hangs half-made is dropped and tried again, not waited on for as long as the browser would
    // (patient on a slow line: a few round trips more, and longer after each try that ran out of time, so a slow link never loops)
    this.helloTimer = setTimeout(() => {
      this.slowTries = Math.min(this.slowTries + 1, 4)
      this.drop(ws)
    }, HELLO_MS * (1 + this.slowTries) + this.rtt * 4)
    ws.onopen = () => ws.send(JSON.stringify({ t: 'auth', token: this.token, since: this.epoch ? { epoch: this.epoch, seq: this.seq } : undefined }))
    ws.onmessage = (ev) => {
      this.lastRx = Date.now()
      // a picture of the PC's screen
      if (typeof ev.data !== 'string') return screenBus.frame(ev.data as ArrayBuffer)
      let m: Msg
      try {
        m = JSON.parse(ev.data) as Msg
      } catch {
        return
      }
      if (m.t === 'pong') {
        const took = Date.now() - this.lastPing
        this.rtt = this.rtt ? Math.round(this.rtt * 0.75 + took * 0.25) : took
        return
      }
      if (m.t === 'screen') return screenBus.message(m as unknown as Record<string, unknown>)
      if (m.t === 'ready') return this.up(ws, m)
      if (m.t === 'res' && m.id !== undefined) {
        const p = this.pending.get(m.id)
        this.pending.delete(m.id)
        if (!p) return
        if (m.ok) {
          writeSnap(p.channel, p.args, m.value)
          p.resolve(m.value)
        } else p.reject(new Error(m.error || 'Failed'))
        return
      }
      if (m.t === 'ev' || m.t === 'evs') {
        // a numbered delivery already received (sent again after a cut) is skipped
        if (typeof m.s === 'number') {
          if (m.s <= this.seq) return
          this.seq = m.s
        }
        if (m.t === 'ev' && m.channel) this.emit(m.channel, m.data)
        else for (const [channel, data] of m.list ?? []) this.emit(channel, data)
      }
    }
    ws.onclose = (ev) => this.lost(ws, ev.code, ev.reason)
  }

  private emit(channel: string, data: unknown): void {
    this.remember(channel, data)
    for (const cb of this.listeners.get(channel) || []) cb(data)
  }

  /** Keeps the current state of turns and questions (see `state`). */
  private remember(channel: string, data: unknown): void {
    if (channel !== 'jolty:event' || !data || typeof data !== 'object') return
    const e = data as Record<string, unknown>
    const sid = String(e.sessionId ?? '')
    if (e.type === 'status' && sid) {
      if (e.status === 'running') this.state.set(`status|${sid}`, { channel, data: e, at: this.state.get(`status|${sid}`)?.at ?? Date.now() - (Number(e.ageMs) || 0) })
      else {
        this.state.delete(`status|${sid}`)
        for (const [k, v] of this.state) if (v.data.type === 'permission' && v.data.sessionId === sid) this.state.delete(k)
      }
    } else if (e.type === 'permission') {
      const id = (e.request as { id?: string } | undefined)?.id
      if (id) this.state.set(`ask|${id}`, { channel, data: e, at: Date.now() })
    } else if (e.type === 'permissionResolved' && typeof e.requestId === 'string') this.state.delete(`ask|${e.requestId}`)
  }

  private up(ws: WebSocket, m: Msg): void {
    clearTimeout(this.helloTimer)
    this.connectMs = Date.now() - this.opened
    const back = this.everReady
    const sameRun = m.epoch !== undefined && m.epoch === this.epoch
    screenBus.attach((msg) => ws.readyState === 1 && ws.send(JSON.stringify(msg)))
    // what was missed comes right after this when the PC still has it; otherwise counting starts again from the PC's number
    if (!m.resumed) {
      this.seq = m.seq ?? 0
      // the PC tells again what runs now: what was kept from before may have ended while the phone was away
      this.state.clear()
    }
    this.epoch = m.epoch
    this.ready = true
    this.everReady = true
    this.delay = 400
    this.failed = 0
    this.slowTries = 0
    this.onState(true)
    this.onVersion(m.version)
    this.onReady()
    if (this.offlineShown) {
      this.offlineShown = false
      clearOffline()
    }
    // actions whose answer was lost: sent again with their id to the same run of Jolty (which then does not do them twice);
    // a Jolty that restarted cannot tell, so the user is told instead of risking a double send
    for (const { p } of this.held.splice(0)) {
      if (sameRun && p.k) this.send(p)
      else p.reject(new Error('Connection to the PC lost'))
    }
    for (const w of this.waiters.splice(0)) w()
    // while the phone was away, events were missed and the PC could not replay them: the page catches up (remote/phone.ts), keeping what is typed
    if ((back && !m.resumed) || this.optimistic) {
      this.optimistic = false
      window.dispatchEvent(new Event('jolty:resync'))
    }
    this.first?.()
    this.first = undefined
    if (this.refreshing) {
      this.refreshing = false
      window.dispatchEvent(new Event('jolty:refreshed'))
    }
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

  private lost(ws: WebSocket, code: number, reason: string): void {
    if (this.ws !== ws) return
    this.ws = undefined
    clearTimeout(this.helloTimer)
    const wasUp = this.ready
    this.ready = false
    if (wasUp) this.onState(false)
    screenBus.message({ t: 'screen', op: 'ended', reason: 'link' })
    // what was in the air: reads go again when the line is back, actions wait for it with their id
    const redo: Pending[] = []
    for (const p of this.pending.values()) {
      if (SAFE.test(p.channel)) redo.push(p)
      else if (p.k) this.held.push({ p, until: Date.now() + HOLD_MS })
      else p.reject(new Error('Connection to the PC lost'))
    }
    this.pending.clear()
    for (const p of redo) void this.issue(p.channel, p.args, false).then(p.resolve, p.reject)
    if (code === 4401 && reason === 'revoked') {
      // revoked at the PC: the one way a phone is unpaired; what it kept of the PC goes with the key
      for (const k of Object.keys(localStorage)) if (k.startsWith(SNAP)) localStorage.removeItem(k)
      const forgot = dropKey()
      this.stopped = true
      if (!this.everReady || this.optimistic) return this.fail?.(new Error('This phone is no longer paired. Open the pairing link from Jolty again.'))
      void forgot.then(() => location.reload())
      return
    }
    if (code === 4401 && !this.everReady) {
      // the PC does not know the key now: the pairing screen is offered, and the key is kept and tried again behind it (boot.ts)
      this.stopped = true
      return this.fail?.(new Error('unknown key'))
    }
    // the PC does not answer (off, asleep, no Tailscale): the page says so and offers to start it, the tries go on behind it
    if (!this.everReady && ++this.failed >= 2 && !this.offlineShown) {
      this.offlineShown = true
      offlineScreen(() => {
        this.delay = 400
        this.check()
      }, this.optimistic)
    }
    // a key the PC does not know while the page is up (its list could not be read for a moment) is waited out, more slowly
    const cap = code === 4401 ? 15_000 : 4000
    this.retryTimer = setTimeout(() => this.open(), this.delay + Math.random() * this.delay * 0.5)
    this.delay = Math.min(Math.round(this.delay * 1.7), cap)
  }

  /** The phone is back in view: a line that looks up is asked to prove it, one that is down is remade now. */
  private check(): void {
    const ws = this.ws
    if (this.ready && ws) {
      this.probe(ws)
      return
    }
    // no line and none on its way (closed for the back-forward cache, or a timer the system froze): made now
    if (!ws && this.started && !this.stopped) {
      this.delay = 400
      this.open()
    } else if (ws && ws.readyState === WebSocket.CONNECTING) {
      // a try made while the network was changing: start over on the new one
      this.drop(ws)
    }
  }

  /** How long a ping may take before the line counts as dead: a few round trips, and longer while an answer is on its way. */
  private patience(): number {
    const base = Math.max(4000, this.rtt * 3 + 1500)
    return this.pending.size ? Math.max(base, 15_000) : base
  }

  private probe(ws: WebSocket): void {
    const sent = Date.now()
    this.lastPing = sent
    if (ws.readyState === 1) ws.send(JSON.stringify({ t: 'ping' }))
    setTimeout(() => {
      if (this.ws === ws && this.ready && this.lastRx < sent) this.drop(ws)
    }, this.patience())
  }

  private beat(): void {
    const now = Date.now()
    for (const h of this.held.filter((x) => x.until < now)) {
      this.held.splice(this.held.indexOf(h), 1)
      h.p.reject(new Error('Connection to the PC lost'))
    }
    const ws = this.ws
    if (!ws || !this.ready || document.visibilityState === 'hidden') return
    if (now - this.lastRx > Math.max(SILENT_MS, this.patience())) return this.drop(ws)
    if (now - this.lastPing > 10_000) this.probe(ws)
  }

  private whenReady(): Promise<void> {
    return this.ready ? Promise.resolve() : new Promise((resolve) => this.waiters.push(resolve))
  }

  /** A far or slow line (round trip measured by pings, or guessed from how long connecting took: about three round trips). */
  slow(): boolean {
    return Math.max(this.rtt, this.connectMs / 3) > 300
  }

  call = <T>(channel: string, ...args: unknown[]): Promise<T> => this.issue<T>(channel, args, true)

  private send(p: Pending): void {
    const id = ++this.id
    this.pending.set(id, p)
    this.ws?.send(JSON.stringify({ t: 'call', id, channel: p.channel, args: p.args, k: p.k }))
  }

  private async issue<T>(channel: string, args: unknown[], fromSnapshot: boolean): Promise<T> {
    if (!this.ready && fromSnapshot) {
      // the last picture the PC gave answers while the line is being made: the page opens at once, and is refreshed when the PC answers
      const snap = readSnap(channel, args)
      if (snap) return snap.value as T
    }
    // an action made while the line is down waits for it (it is sent once the PC answers, with its id)
    while (!this.ready || this.ws?.readyState !== 1) {
      // up but closing: give the close a moment to land instead of spinning on it
      if (this.ready) await new Promise((r) => setTimeout(r, 50))
      else await this.whenReady()
    }
    return new Promise<T>((resolve, reject) => {
      this.send({ resolve: resolve as (v: unknown) => void, reject, channel, args, k: SAFE.test(channel) ? undefined : newKey() })
    })
  }

  listen = (channel: string, cb: (data: unknown) => void): (() => void) => {
    const set = this.listeners.get(channel) || new Set()
    set.add(cb)
    this.listeners.set(channel, set)
    // a page that subscribes after the line was up still learns what runs and what waits for a yes
    if (channel === 'jolty:event') for (const { data, at } of [...this.state.values()]) cb(data.type === 'status' ? { ...data, ageMs: Date.now() - at } : data)
    return () => set.delete(cb)
  }
}
