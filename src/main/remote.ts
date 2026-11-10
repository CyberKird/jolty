import crypto from 'crypto'
import fs from 'fs'
import http from 'http'
import path from 'path'
import type { Duplex } from 'stream'
import { WebSocketServer, type WebSocket } from 'ws'
import { getLang } from '@shared/i18n'
import type { RemoteDevice, RemoteStatus, WakeConfig, WakeStatus, WakeTest } from '@shared/remote'
import { remoteArgs } from './remote-policy'
import { lanMacs, validAgentUrl } from './remote-wake'
import type { RemoteScreen, ScreenClient } from './remote-screen'
import * as tailscale from './remote-tailscale'
import { dataDir, loadSettings } from './store'

// Lets a paired phone use this PC's Jolty: the same page as the desktop window, over a WebSocket that carries the
// same channels as the window's IPC. The server only listens on this PC (127.0.0.1); Tailscale Serve puts HTTPS
// in front of it for the tailnet, so nothing is open to the internet or the local network.

declare const __JOLTY_VERSION__: string | undefined

const DEFAULT_PORT = 47821
const PAIR_MINUTES = 5
const MAX_MESSAGE = 30 * 1024 * 1024

interface Stored {
  enabled: boolean
  port: number
  devices: Array<RemoteDevice & { hash: string }>
  /** the wake agent: where, and the secret shared with it */
  wake?: { url: string; token: string }
}

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
  '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />',
  '<link rel="manifest" href="/manifest.webmanifest" />',
  '<link rel="apple-touch-icon" href="/apple-touch-icon.png" />',
  '<meta name="apple-mobile-web-app-capable" content="yes" />',
  '<meta name="mobile-web-app-capable" content="yes" />',
  '<meta name="apple-mobile-web-app-title" content="Jolty" />',
  '<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />',
  '<meta name="theme-color" content="#060709" />'
].join('')

const sha = (s: string): string => crypto.createHash('sha256').update(s).digest('hex')

function same(a: string, b: string): boolean {
  const x = Buffer.from(a)
  const y = Buffer.from(b)
  return x.length === y.length && crypto.timingSafeEqual(x, y)
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
  private clients = new Set<{ ws: WebSocket; device: string }>()
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
  private working = new Set<string>()
  private asking = new Map<string, unknown>()

  private track(e: { type?: string; sessionId?: string; status?: string; request?: { id?: string }; requestId?: string }): void {
    if (!e.sessionId) return
    if (e.type === 'status') {
      if (e.status === 'running') this.working.add(e.sessionId)
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
    if (!this.clients.size) return
    const msg = JSON.stringify({ t: 'ev', channel, data })
    for (const c of this.clients) if (c.ws.readyState === 1) c.ws.send(msg)
  }

  private load(): Stored {
    try {
      const j = JSON.parse(fs.readFileSync(path.join(dataDir(), 'remote.json'), 'utf8')) as Partial<Stored>
      return { enabled: j.enabled === true, port: Number(j.port) || DEFAULT_PORT, devices: Array.isArray(j.devices) ? j.devices : [], wake: j.wake && typeof j.wake.token === 'string' ? j.wake : undefined }
    } catch {
      return { enabled: false, port: DEFAULT_PORT, devices: [] }
    }
  }

  private save(s: Stored): void {
    const file = path.join(dataDir(), 'remote.json')
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const tmp = `${file}.${process.pid}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(s, null, 2), { mode: 0o600 })
    fs.renameSync(tmp, file)
  }

  /** Called once the app is ready: starts the server again when the user left it on. */
  async init(): Promise<void> {
    if (this.load().enabled) await this.listen().catch((e: unknown) => (this.error = e instanceof Error ? e.message : String(e)))
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
    const s = this.load()
    this.save({ ...s, devices: s.devices.filter((d) => d.id !== id) })
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
    const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE })
    server.on('upgrade', (req, socket, head) => this.upgrade(req, socket, head, wss))
    wss.on('connection', (ws) => this.connection(ws))
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

  private connection(ws: WebSocket): void {
    let device: string | undefined
    let client: { ws: WebSocket; device: string } | undefined
    const waiting = setTimeout(() => ws.close(4401, 'no key'), 5000)
    const alive = setInterval(() => {
      if (ws.readyState === 1) ws.ping()
    }, 25_000)
    const reply = (v: unknown): void => {
      if (ws.readyState === 1) ws.send(JSON.stringify(v))
    }
    const view: ScreenClient = {
      id: crypto.randomBytes(6).toString('hex'),
      send: reply,
      sendBinary: (data) => ws.readyState === 1 && ws.send(data, { binary: true }),
      backlog: () => ws.bufferedAmount
    }
    ws.on('close', () => {
      clearTimeout(waiting)
      clearInterval(alive)
      if (client && this.clients.delete(client)) this.onChange()
      this.screen?.drop(view)
    })
    ws.on('message', (raw) => {
      let m: { t?: string; token?: string; id?: number; channel?: string; args?: unknown }
      try {
        m = JSON.parse(String(raw))
      } catch {
        return
      }
      if (!device) {
        if (m.t !== 'auth' || typeof m.token !== 'string') return ws.close(4401, 'no key')
        device = this.deviceFor(m.token)
        if (!device) return ws.close(4401, 'unknown key')
        clearTimeout(waiting)
        client = { ws, device }
        this.clients.add(client)
        this.onChange()
        reply({ t: 'ready', lang: getLang() })
        // the turns running now and the questions waiting for a yes, as the events that would have told it
        for (const id of this.working) reply({ t: 'ev', channel: 'jolty:event', data: { type: 'status', sessionId: id, status: 'running' } })
        for (const ev of this.asking.values()) reply({ t: 'ev', channel: 'jolty:event', data: ev })
        return
      }
      if (m.t === 'screen') {
        if (this.screen) this.screen.handle(view, m as Record<string, unknown>)
        else reply({ t: 'screen', op: 'denied', reason: 'none' })
        return
      }
      if (m.t !== 'call' || typeof m.channel !== 'string' || typeof m.id !== 'number') return
      void this.run(m.channel, m.args).then(
        (value) => reply({ t: 'res', id: m.id, ok: true, value: value === undefined ? null : value }),
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

  private deviceFor(token: string): string | undefined {
    const s = this.load()
    const hash = sha(token)
    const d = s.devices.find((x) => same(x.hash, hash))
    if (!d) return undefined
    if (!d.lastSeen || Date.now() - d.lastSeen > 3_600_000) {
      d.lastSeen = Date.now()
      this.save(s)
    }
    return d.id
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
    this.pairing = undefined
    const token = crypto.randomBytes(32).toString('base64url')
    const s = this.load()
    const label = typeof name === 'string' && name.trim() ? name.trim().slice(0, 40) : 'Phone'
    s.devices.push({ id: crypto.randomBytes(6).toString('hex'), name: label, created: Date.now(), lastSeen: Date.now(), hash: sha(token) })
    this.save(s)
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
    if (url.pathname === '/api/pair' && req.method === 'POST') {
      let body = ''
      req.on('data', (c: Buffer) => {
        body += c
        if (body.length > 2000) req.destroy()
      })
      req.on('end', () => {
        try {
          const j = JSON.parse(body) as { code?: unknown; name?: unknown }
          const out = this.claim(j.code, j.name)
          if (!out) return end(403, '{"error":"Code not valid or expired"}', 'application/json')
          end(200, JSON.stringify(out), 'application/json')
        } catch {
          end(400, '{"error":"Bad request"}', 'application/json')
        }
      })
      return
    }
    if (url.pathname === '/lang.js') return end(200, `window.joltyLang=${JSON.stringify(getLang())};`, 'text/javascript; charset=utf-8')
    if (req.method !== 'GET' && req.method !== 'HEAD') return end(405)
    this.file(url.pathname, req.headers.host || '', end)
  }

  private file(pathname: string, host: string, end: (code: number, body?: string | Buffer, type?: string, extra?: Record<string, string>) => void): void {
    let rel: string
    try {
      rel = decodeURIComponent(pathname)
    } catch {
      return end(400)
    }
    const target = path.resolve(this.root, '.' + (rel === '/' ? '/index.html' : rel))
    if (target !== this.root && !target.startsWith(this.root + path.sep)) return end(403)
    fs.readFile(target, (err, data) => {
      if (err) return end(404, 'Not found')
      const ext = path.extname(target).toLowerCase()
      if (target.endsWith(`${path.sep}index.html`)) return end(200, this.page(data.toString('utf8'), host), MIME['.html'])
      // the kept pages are named after the version, so an update replaces them
      if (rel === '/sw.js') return end(200, data.toString('utf8').replace('__VERSION__', typeof __JOLTY_VERSION__ === 'string' ? __JOLTY_VERSION__ : 'dev'), MIME['.js'], { 'Cache-Control': 'no-cache', 'Service-Worker-Allowed': '/' })
      const cache = rel.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache'
      end(200, data, MIME[ext] || 'application/octet-stream', { 'Cache-Control': cache })
    })
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
