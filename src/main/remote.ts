import crypto from 'crypto'
import fs from 'fs'
import http from 'http'
import zlib from 'zlib'
import path from 'path'
import type { Duplex } from 'stream'
import { WebSocketServer, type WebSocket } from 'ws'
import { getLang } from '@shared/i18n'
import type { RemoteStatus, WakeConfig, WakeStatus, WakeTest } from '@shared/remote'
import { DEFAULT_PORT, DeviceStore, same, type Stored, type Who } from './remote-devices'
import { CUT_BACKLOG, EventLog, Once, Outbox, coalesce, send as sendEvents } from './remote-events'
import { PhoneMedia, type Shrink } from './remote-media'
import { remoteArgs } from './remote-policy'
import { lanMacs, validAgentUrl } from './remote-wake'
import type { RemoteScreen, ScreenClient } from './remote-screen'
import * as tailscale from './remote-tailscale'
import { loadSettings } from './store'

// Lets a paired phone use this PC's Jolty: the same page as the desktop window, over a WebSocket that carries the
// same channels as the window's IPC. The server only listens on this PC (127.0.0.1); Tailscale Serve puts HTTPS
// in front of it for the tailnet, so nothing is open to the internet or the local network.

declare const __JOLTY_VERSION__: string | undefined

const PAIR_MINUTES = 5
const MAX_MESSAGE = 30 * 1024 * 1024

type Handler = (...args: unknown[]) => unknown

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.glb': 'model/gltf-binary',
  '.wasm': 'application/wasm'
}

/** What makes the page installable on a phone's home screen and lets it use the whole screen. */
const PHONE_HEAD = [
  '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover, interactive-widget=resizes-content" />',
  '<link rel="manifest" href="/manifest.webmanifest" />',
  '<link rel="apple-touch-icon" href="/apple-touch-icon.png" />',
  '<meta name="apple-mobile-web-app-capable" content="yes" />',
  '<meta name="mobile-web-app-capable" content="yes" />',
  '<meta name="apple-mobile-web-app-title" content="Jolty Remote" />',
  '<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />',
  '<meta name="theme-color" content="#060709" />'
].join('')

/** the dictionary chunks of the interface languages (named like "de-AbCd1234.js"): a phone keeps only its own */
const LOCALE_CHUNK = /^(ar|de|en|es|fr|hi|id|it|ja|ko|pt-BR)-[\w-]{8}\.js$/

const COOKIE = 'jolty_dev'

/** The phone's key as the cookie carries it. */
function cookieToken(req: http.IncomingMessage): string | undefined {
  return new RegExp(`(?:^|;\\s*)${COOKIE}=([\\w-]+)`).exec(String(req.headers.cookie || ''))?.[1]
}

/** Only this PC itself and tailnet names are served: a page on another site cannot reach the server through DNS tricks. */
function hostOk(host: string | undefined): boolean {
  if (!/^[a-z0-9.-]+(:\d{1,5})?$/i.test(host || '')) return false
  const h = (host || '').toLowerCase().replace(/:\d+$/, '')
  return h === '127.0.0.1' || h === 'localhost' || h.endsWith('.ts.net')
}

export class Remote {
  private handlers = new Map<string, Handler>()
  private server?: http.Server
  private wss?: WebSocketServer
  private clients = new Set<{ ws: WebSocket; device: string; out: Outbox }>()
  private events = new EventLog()
  private media = new PhoneMedia()
  /** per phone: the actions it sent, so one sent again after a lost answer is not done twice */
  private once = new Map<string, Once>()
  private pairing?: { code: string; until: number }
  private failures: number[] = []
  private url?: string
  private error?: string

  constructor(
    private onChange: () => void = () => undefined,
    private root = path.join(__dirname, '../renderer')
  ) {}

  private screen?: RemoteScreen

  /** The PC's screen for the phone (remote-screen.ts); without it a phone's screen requests are refused. */
  useScreen(screen: RemoteScreen): void {
    this.screen = screen
  }

  /** The agent's address and the secret it shares with the phones; the secret is made on first use. */
  async wakeStatus(): Promise<WakeStatus> {
    const s = this.load()
    const wake = s.wake ?? { url: '', token: crypto.randomBytes(24).toString('base64url') }
    if (!s.wake) this.save({ ...s, wake })
    return { url: wake.url, token: wake.token, origin: (await this.status()).url ?? '', macs: lanMacs() }
  }

  async wakeSet(url: string): Promise<WakeStatus> {
    const clean = url.trim() ? validAgentUrl(url) : ''
    const s = this.load()
    const wake = s.wake ?? { url: '', token: crypto.randomBytes(24).toString('base64url') }
    this.save({ ...s, wake: { ...wake, url: clean } })
    return this.wakeStatus()
  }

  /** Asks the agent from this PC: it answers with the MAC it was started with, so a typo shows at once. */
  async wakeTest(): Promise<WakeTest> {
    const w = (await this.wakeStatus())
    if (!w.url) return { ok: false, error: 'No agent address yet' }
    try {
      const res = await fetch(`${w.url}/ping`, { headers: { Authorization: `Bearer ${w.token}` }, signal: AbortSignal.timeout(8000) })
      if (res.status === 401) return { ok: false, error: 'The agent is running with another secret: start it again with the command from here' }
      if (!res.ok) return { ok: false, error: `The agent answered ${res.status}` }
      return { ok: true, mac: String(((await res.json()) as { mac?: string }).mac || '') }
    } catch {
      return { ok: false, error: 'Cannot reach the agent: is it running, and is `tailscale serve` set up on that device?' }
    }
  }

  /** What a paired phone keeps; null while it is not set up. */
  wakeConfig(): WakeConfig | null {
    const w = this.load().wake
    return w?.url ? { url: w.url, token: w.token } : null
  }

  /** The kill key, or Stop at the PC. */
  stopScreen(): void {
    this.screen?.stopAll('stopped')
  }

  /** The desktop registers each IPC channel here too, so the phone reaches the very same code. */
  register(channel: string, fn: Handler): void {
    this.handlers.set(channel, fn)
  }

  /** What is happening now, kept from the events: a phone that connects (or comes back) mid-turn has to learn it, as it never saw the event. */
  private working = new Map<string, number>()
  private asking = new Map<string, unknown>()

  private track(e: { type?: string; sessionId?: string; status?: string; request?: { id?: string }; requestId?: string }): void {
    if (!e.sessionId) return
    if (e.type === 'status') {
      if (e.status === 'running') {
        if (!this.working.has(e.sessionId)) this.working.set(e.sessionId, Date.now())
      }
      else {
        this.working.delete(e.sessionId)
        for (const [id, ev] of this.asking) if ((ev as { sessionId?: string }).sessionId === e.sessionId) this.asking.delete(id)
      }
    } else if (e.type === 'permission' && e.request?.id) this.asking.set(e.request.id, e)
    else if (e.type === 'permissionResolved' && e.requestId) this.asking.delete(e.requestId)
  }

  /** Pushes an event (a streamed chunk, a status) to every connected phone. */
  broadcast(channel: string, data: unknown): void {
    if (channel === 'jolty:event' && data && typeof data === 'object') this.track(data as Parameters<Remote['track']>[0])
    // numbered and kept even with no phone connected: a phone that comes back asks for what it missed
    const phone = this.media.event(channel, data)
    const d = phone as { type?: string; delta?: string }
    const size = d && d.type === 'delta' && typeof d.delta === 'string' ? d.delta.length + 120 : (JSON.stringify(phone)?.length ?? 8)
    const ev = this.events.add(channel, phone, size)
    for (const c of this.clients) if (c.ws.readyState === 1) c.out.push(ev)
  }

  /** Pictures in the phone's conversations are made smaller with this (the PC passes Electron's image tools). */
  useImages(shrink: Shrink): void {
    this.media.useShrink(shrink)
  }

  private devices = new DeviceStore()

  private load(): Stored {
    return this.devices.load()
  }

  private save(s: Stored): void {
    this.devices.save(s)
  }

  /** Called once the app is ready: starts the server again when the user left it on. */
  async init(waitMs = 1000): Promise<void> {
    // the list cannot be read yet (held by the old process during an update, a drive not mounted yet): waited for, for up
    // to ten minutes, instead of leaving the phones without a server until the next start of Jolty
    for (let waited = 0; this.load() && this.devices.degraded && waited < 600_000; waited += waitMs) await new Promise((r) => setTimeout(r, waitMs))
    if (!this.load().enabled) return
    // after an update the old process can still hold the port for a few seconds: try again before giving up
    for (let attempt = 0; attempt < 12; attempt++) {
      try {
        await this.listen()
        this.error = undefined
        return
      } catch (e) {
        this.error = e instanceof Error ? e.message : String(e)
        if (!/already used/.test(this.error)) return
        await new Promise((r) => setTimeout(r, 2500))
      }
    }
  }

  async status(): Promise<RemoteStatus> {
    const s = this.load()
    const ts = await tailscale.info()
    // JOLTY_REMOTE_URL: tests (and a PC behind its own HTTPS address) say where the phone opens the page
    if (process.env.JOLTY_REMOTE_URL) this.url = process.env.JOLTY_REMOTE_URL
    else if (this.server && ts.state === 'ready') this.url = await tailscale.served(s.port)
    return {
      enabled: s.enabled,
      running: Boolean(this.server?.listening),
      port: s.port,
      tailscale: ts.state,
      url: this.url,
      devices: s.devices.map(({ id, name, created, lastSeen }) => ({ id, name, created, lastSeen, online: [...this.clients].some((c) => c.device === id) })),
      screen: { allowed: loadSettings().remoteScreen === true, viewers: this.screen?.viewing() ?? 0 },
      error: this.error
    }
  }

  async enable(on: boolean): Promise<RemoteStatus> {
    const s = this.load()
    this.error = undefined
    if (on) {
      try {
        await this.listen()
        this.url = await tailscale.serve(s.port)
        this.save({ ...s, enabled: true })
      } catch (e) {
        this.error = e instanceof Error ? e.message : String(e)
        await this.stop()
      }
    } else {
      await this.stop()
      await tailscale.unserve(s.port)
      this.url = undefined
      this.pairing = undefined
      this.save({ ...s, enabled: false })
    }
    this.onChange()
    return this.status()
  }

  /** A one-time code the phone enters (or opens as a link) to receive its own key. It expires in a few minutes. */
  startPairing(): { code: string; link?: string; minutes: number } {
    const code = crypto.randomBytes(5).toString('hex').toUpperCase()
    this.pairing = { code, until: Date.now() + PAIR_MINUTES * 60_000 }
    return { code, link: this.url ? `${this.url}/#pair=${code}` : undefined, minutes: PAIR_MINUTES }
  }

  revoke(id: string): void {
    this.devices.revoke(id)
    for (const c of this.clients) if (c.device === id) c.ws.close(4401, 'revoked')
    this.onChange()
  }

  /** Cuts every phone off at once, without removing their pairing. */
  disconnectAll(): void {
    for (const c of this.clients) c.ws.close(4000, 'disconnected')
  }

  async stop(): Promise<void> {
    this.disconnectAll()
    this.wss?.close()
    this.wss = undefined
    const server = this.server
    this.server = undefined
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()))
  }

  private listen(): Promise<void> {
    if (this.server?.listening) return Promise.resolve()
    const { port } = this.load()
    const server = http.createServer((req, res) => this.serve(req, res))
    // text messages (transcripts, lists) are compressed: on a poor connection that is most of the wait; pictures and video are sent as they are
    const wss = new WebSocketServer({
      noServer: true,
      maxPayload: MAX_MESSAGE,
      perMessageDeflate: { threshold: 512, zlibDeflateOptions: { level: 3 }, serverNoContextTakeover: true, clientNoContextTakeover: true, concurrencyLimit: 4 }
    })
    server.on('upgrade', (req, socket, head) => this.upgrade(req, socket, head, wss))
    wss.on('connection', (ws, req) => this.connection(ws, req))
    this.wss = wss
    this.server = server
    return new Promise((resolve, reject) => {
      server.once('error', (e: NodeJS.ErrnoException) => {
        this.server = undefined
        reject(new Error(e.code === 'EADDRINUSE' ? `Port ${port} is already used by another program` : e.message))
      })
      server.listen(port, '127.0.0.1', () => resolve())
    })
  }

  private upgrade(req: http.IncomingMessage, socket: Duplex, head: Buffer, wss: WebSocketServer): void {
    const origin = req.headers.origin
    let originHost = ''
    try {
      originHost = origin ? new URL(origin).host : ''
    } catch {
      // malformed Origin: refused below
    }
    if (req.url !== '/ws' || !hostOk(req.headers.host) || (origin && originHost !== req.headers.host)) {
      socket.destroy()
      return
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req))
  }

  private connection(ws: WebSocket, req: http.IncomingMessage): void {
    let device: string | undefined
    let client: { ws: WebSocket; device: string; out: Outbox } | undefined
    // a slow line can take a while to deliver the first message: that is not a wrong key (4408 is retried by the phone, 4401 is not)
    const waiting = setTimeout(() => ws.close(4408, 'no key'), 20_000)
    // a phone that went away without closing (out of signal, the browser killed) is found by its silence and cut, so nothing
    // piles up for it; one so far behind that what waits for it is huge is cut too, and catches up when it connects again
    let heard = Date.now()
    ws.on('pong', () => (heard = Date.now()))
    const alive = setInterval(() => {
      if (ws.readyState !== 1) return
      if (Date.now() - heard > 50_000 || ws.bufferedAmount > CUT_BACKLOG) return ws.terminate()
      ws.ping()
    }, 20_000)
    const reply = (v: unknown): void => {
      if (ws.readyState === 1) ws.send(JSON.stringify(v))
    }
    const out = new Outbox({ send: (text) => ws.readyState === 1 && ws.send(text), backlog: () => ws.bufferedAmount })
    const view: ScreenClient = {
      id: crypto.randomBytes(6).toString('hex'),
      send: reply,
      sendBinary: (data) => ws.readyState === 1 && ws.send(data, { binary: true, compress: false }),
      backlog: () => ws.bufferedAmount
    }
    ws.on('close', () => {
      clearTimeout(waiting)
      clearInterval(alive)
      out.stop()
      if (client && this.clients.delete(client)) this.onChange()
      this.screen?.drop(view)
    })
    ws.on('message', (raw) => {
      heard = Date.now()
      let m: { t?: string; token?: string; id?: number; channel?: string; args?: unknown; k?: unknown; since?: { epoch?: unknown; seq?: unknown } }
      try {
        m = JSON.parse(String(raw))
      } catch {
        return
      }
      if (!device) {
        if (m.t !== 'auth' || typeof m.token !== 'string') return ws.close(4400, 'bad first message')
        // the key is kept in the phone's storage and, set by this server, in a cookie: either one names the phone (a storage that was cleared,
        // or a cookie that expired, is not "unpaired"). Only a key revoked at the PC is told "revoked"; a list that cannot be read now is "try again".
        const who = this.devices.whoOf([m.token, cookieToken(req)])
        if (who === 'unavailable') return ws.close(1013, 'try again')
        if (who === 'revoked') return ws.close(4401, 'revoked')
        if (who === 'unknown') return ws.close(4401, 'unknown key')
        device = who.id
        clearTimeout(waiting)
        client = { ws, device, out }
        this.clients.add(client)
        this.onChange()
        // a phone coming back says the number of the last event it got: when this run still has what came after, it gets exactly that
        const missed = m.since ? this.events.since(m.since.epoch, m.since.seq) : undefined
        reply({ t: 'ready', lang: getLang(), version: typeof __JOLTY_VERSION__ === 'string' ? __JOLTY_VERSION__ : 'dev', epoch: this.events.epoch, seq: this.events.seq, resumed: Boolean(missed) })
        if (missed) {
          if (missed.length) sendEvents(out.sink, coalesce(missed.map((e) => [e.channel, e.data, e.seq])))
          return
        }
        // the turns running now and the questions waiting for a yes, as the events that would have told it
        for (const [id, since] of this.working) reply({ t: 'ev', channel: 'jolty:event', data: { type: 'status', sessionId: id, status: 'running', ageMs: Date.now() - since } })
        for (const ev of this.asking.values()) reply({ t: 'ev', channel: 'jolty:event', data: ev })
        return
      }
      // the phone checks the line is alive (a connection that went quiet in a pocket says nothing when it dies)
      if (m.t === 'ping') return reply({ t: 'pong' })
      if (m.t === 'screen') {
        if (this.screen) this.screen.handle(view, m as Record<string, unknown>)
        else reply({ t: 'screen', op: 'denied', reason: 'none' })
        return
      }
      if (m.t !== 'call' || typeof m.channel !== 'string' || typeof m.id !== 'number') return
      const channel = m.channel
      let once = this.once.get(device)
      if (!once) this.once.set(device, (once = new Once()))
      void once.run(m.k, () => this.run(channel, m.args)).then(
        (value) => reply({ t: 'res', id: m.id, ok: true, value: value === undefined ? null : this.media.result(channel, value) }),
        (e: unknown) => reply({ t: 'res', id: m.id, ok: false, error: e instanceof Error ? e.message : String(e) })
      )
    })
  }

  private async run(channel: string, args: unknown): Promise<unknown> {
    const checked = remoteArgs(channel, args)
    const fn = this.handlers.get(channel)
    if (!fn) throw new Error(`Not available: ${channel}`)
    return fn(...checked)
  }

  private locked(): boolean {
    const now = Date.now()
    this.failures = this.failures.filter((t) => now - t < 60_000)
    return this.failures.length >= 5
  }

  private claim(code: unknown, name: unknown): { token: string } | undefined {
    if (this.locked() || typeof code !== 'string' || !this.pairing || Date.now() > this.pairing.until || !same(this.pairing.code, code.trim().toUpperCase())) {
      this.failures.push(Date.now())
      return undefined
    }
    const label = typeof name === 'string' && name.trim() ? name.trim().slice(0, 40) : 'Phone'
    // the code is used up only once the phone is written down (a list that cannot be read now keeps the code for another try)
    const { token } = this.devices.add(label)
    this.pairing = undefined
    this.onChange()
    return { token }
  }

  private serve(req: http.IncomingMessage, res: http.ServerResponse): void {
    const headers = { 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'X-Frame-Options': 'DENY', 'Cache-Control': 'no-store' }
    const end = (code: number, body: string | Buffer = '', type = 'text/plain; charset=utf-8', extra: Record<string, string> = {}): void => {
      res.writeHead(code, { ...headers, 'Content-Type': type, ...extra })
      res.end(body)
    }
    if (!hostOk(req.headers.host)) return end(421, 'Wrong host')
    const url = new URL(req.url || '/', 'http://x')
    const secure = req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : ''
    const keep = (token: string): Record<string, string> => ({ 'Set-Cookie': `${COOKIE}=${token}; Path=/; Max-Age=31536000; HttpOnly; SameSite=Strict${secure}` })
    const body = (then: (j: Record<string, unknown>) => void): void => {
      let text = ''
      req.on('data', (c: Buffer) => {
        text += c
        if (text.length > 2000) req.destroy()
      })
      req.on('end', () => {
        let j: unknown
        try {
          j = JSON.parse(text)
        } catch {
          return end(400, '{"error":"Bad request"}', 'application/json')
        }
        if (!j || typeof j !== 'object') return end(400, '{"error":"Bad request"}', 'application/json')
        then(j as Record<string, unknown>)
      })
    }
    if (url.pathname === '/api/pair' && req.method === 'POST') {
      return body((j) => {
        let out: { token: string } | undefined
        try {
          out = this.claim(j.code, j.name)
        } catch {
          return end(503, '{"error":"Try again in a moment"}', 'application/json')
        }
        if (!out) return end(403, '{"error":"Code not valid or expired"}', 'application/json')
        end(200, JSON.stringify(out), 'application/json', keep(out.token))
      })
    }
    // is this phone still paired? GET asks by the cookie alone; POST brings the key the phone keeps and renews the cookie with it, so the
    // cookie and the phone's own copies keep each other alive. "revoked" is the only answer after which the phone forgets its key.
    if (url.pathname === '/api/session' && (req.method === 'GET' || req.method === 'POST')) {
      const answer = (who: Who, token?: string): void => {
        if (typeof who === 'object') return end(200, '{"ok":true}', 'application/json', token ? keep(token) : {})
        if (who === 'unavailable') return end(503, '{"ok":false,"retry":true}', 'application/json')
        end(401, JSON.stringify({ ok: false, revoked: who === 'revoked' }), 'application/json', who === 'revoked' ? { 'Set-Cookie': `${COOKIE}=; Path=/; Max-Age=0; HttpOnly; SameSite=Strict${secure}` } : {})
      }
      if (req.method === 'GET') return answer(this.devices.whoOf([cookieToken(req)]))
      return body((j) => {
        const token = typeof j.token === 'string' ? j.token : ''
        const who = this.devices.whoOf([token])
        answer(typeof who === 'object' || !cookieToken(req) ? who : this.devices.whoOf([token, cookieToken(req)]), typeof who === 'object' ? token : undefined)
      })
    }
    // the version tells the page it is an old copy kept on the phone (after an update of Jolty): it then loads the new one
    // a picture of a conversation, made smaller for the phone (remote-media.ts): the link itself is the permission
    if (url.pathname.startsWith('/api/img/') && req.method === 'GET') {
      const img = this.media.serve(url.pathname)
      return img ? end(200, img.data, img.mime, { 'Cache-Control': 'private, max-age=31536000, immutable' }) : end(404, 'Not found')
    }
    if (url.pathname === '/lang.js') return end(200, `window.joltyLang=${JSON.stringify(getLang())};window.joltyVersion=${JSON.stringify(typeof __JOLTY_VERSION__ === 'string' ? __JOLTY_VERSION__ : 'dev')};`, 'text/javascript; charset=utf-8')
    if (req.method !== 'GET' && req.method !== 'HEAD') return end(405)
    this.file(url.pathname, req.headers.host || '', req, end)
  }

  private file(pathname: string, host: string, req: http.IncomingMessage, end: (code: number, body?: string | Buffer, type?: string, extra?: Record<string, string>) => void): void {
    let rel: string
    try {
      rel = decodeURIComponent(pathname)
    } catch {
      return end(400)
    }
    if (rel === '/shell.json') return end(200, JSON.stringify(this.shellFiles()), 'application/json', { 'Cache-Control': 'no-cache' })
    const target = path.resolve(this.root, '.' + (rel === '/' ? '/index.html' : rel))
    if (target !== this.root && !target.startsWith(this.root + path.sep)) return end(403)
    fs.readFile(target, (err, data) => {
      if (err) return end(404, 'Not found')
      const ext = path.extname(target).toLowerCase()
      const type = MIME[ext] || 'application/octet-stream'
      let body: Buffer | string = data
      let cache = rel.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache'
      if (target.endsWith(`${path.sep}index.html`)) body = this.page(data.toString('utf8'), host)
      // the kept pages are named after the version, so an update replaces them
      else if (rel === '/sw.js') {
        body = data.toString('utf8').replace('__VERSION__', typeof __JOLTY_VERSION__ === 'string' ? __JOLTY_VERSION__ : 'dev')
        cache = 'no-cache'
      }
      this.send(req, body, type, cache, `${target}:${data.length}`, end, rel === '/sw.js' ? { 'Service-Worker-Allowed': '/' } : {})
    })
  }

  /** Compressed copies of the text files, kept: a phone on a weak connection downloads a fifth of the bytes. */
  private packed = new Map<string, { br?: Buffer; gz?: Buffer }>()

  private send(req: http.IncomingMessage, body: Buffer | string, type: string, cache: string, key: string, end: (code: number, body?: string | Buffer, type?: string, extra?: Record<string, string>) => void, more: Record<string, string> = {}): void {
    const raw = typeof body === 'string' ? Buffer.from(body) : body
    const etag = `"${crypto.createHash('sha1').update(raw).digest('base64url').slice(0, 22)}"`
    const extra: Record<string, string> = { 'Cache-Control': cache, ETag: etag, Vary: 'Accept-Encoding', ...more }
    if (req.headers['if-none-match'] === etag) return end(304, '', type, extra)
    const text = /^(text\/|application\/(json|manifest\+json|wasm)|image\/svg)/.test(type) && raw.length > 1024
    if (!text) return end(200, raw, type, extra)
    const accept = String(req.headers['accept-encoding'] || '')
    const k = `${key}:${etag}`
    let hit = this.packed.get(k)
    if (!hit) {
      if (this.packed.size > 400) this.packed.clear()
      hit = {}
      this.packed.set(k, hit)
    }
    if (/\bbr\b/.test(accept)) {
      hit.br ??= zlib.brotliCompressSync(raw, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 8, [zlib.constants.BROTLI_PARAM_SIZE_HINT]: raw.length } })
      return end(200, hit.br, type, { ...extra, 'Content-Encoding': 'br' })
    }
    if (/\bgzip\b/.test(accept)) {
      hit.gz ??= zlib.gzipSync(raw, { level: 9 })
      return end(200, hit.gz, type, { ...extra, 'Content-Encoding': 'gzip' })
    }
    end(200, raw, type, extra)
  }

  /** What the phone keeps for the page to open at once (and while the PC is off): the built files, without the heavy ones a phone never shows. */
  private shellFiles(): string[] {
    try {
      const lang = getLang()
      // the other languages' dictionaries (named like "de-AbCd1234.js") and the 3D character are not kept
      return fs
        .readdirSync(path.join(this.root, 'assets'))
        .filter((f) => !/^(Rig3D|ragdoll)-/.test(f))
        .filter((f) => !LOCALE_CHUNK.test(f) || f.startsWith(`${lang}-`))
        .map((f) => `/assets/${f}`)
    } catch {
      return []
    }
  }

  /** The wake agent's address, allowed in the page's security policy so the phone can ask it while the PC is off. */
  private agentOrigin(): string {
    try {
      const u = this.load().wake?.url
      return u ? ` ${new URL(u).origin}` : ''
    } catch {
      return ''
    }
  }

  /** The desktop page, with the phone's connection allowed in its security policy and the language set before the app loads. */
  private page(html: string, host: string): string {
    return html
      .replace("connect-src 'self' blob:", `connect-src 'self' blob: wss://${host} ws://${host}${this.agentOrigin()}`)
      .replace('<head>', `<head><script src="/lang.js"></script>${PHONE_HEAD}`)
  }
}
