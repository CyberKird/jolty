// The local end of the Jolty browser bridge: one HTTP/WebSocket server on 127.0.0.1.
//  - the browser extension connects to /ext (WebSocket) and proves itself with the token
//  - models reach the browser tools through /mcp/<chat id> (MCP over HTTP), with the same token as a Bearer
// Nothing here touches Electron, so it can be tested on its own.
import { EventEmitter } from 'events'
import crypto from 'crypto'
import http from 'http'
import { WebSocket, WebSocketServer } from 'ws'

export const FIRST_PORT = 47820
export const PORT_COUNT = 10

export interface ExtInfo {
  version: string
  agent: string
}

interface Conn {
  ws: WebSocket
  info?: ExtInfo
  ready: boolean
}

interface Pending {
  resolve: (v: unknown) => void
  reject: (e: Error) => void
  timer: NodeJS.Timeout
  conn: Conn
}

export interface HubOptions {
  /** the shared secret: the extension sends it in its hello, models send it as a Bearer token */
  token: () => string
  /** version of the extension files Jolty ships: an older connected extension is told to reload */
  bundledVersion: () => string
  /** a JSON-RPC message for the model-facing MCP server of one chat; undefined = a notification, no reply */
  mcp: (sid: string, message: Record<string, unknown>) => Promise<Record<string, unknown> | undefined>
  log?: (m: string) => void
}

const safeEqual = (a: string, b: string): boolean => {
  const x = Buffer.from(a)
  const y = Buffer.from(b)
  return x.length === y.length && crypto.timingSafeEqual(x, y)
}

export interface HubEvents {
  status: [connected: boolean]
  event: [tabId: number, method: string, params: Record<string, unknown>, sessionId?: string]
  detached: [tabId: number, reason: string]
  tabRemoved: [tabId: number]
  tabCreated: [tab: { id: number; windowId: number; url: string; title: string }, openerTabId?: number]
}

export class BrowserHub extends EventEmitter {
  port = 0
  private server?: http.Server
  private wss = new WebSocketServer({ noServer: true, maxPayload: 256 * 1024 * 1024 })
  private conns: Conn[] = []
  private pending = new Map<number, Pending>()
  private seq = 0

  constructor(private opts: HubOptions) {
    super()
  }

  /** Listens on the first free port of the range the extension scans. */
  async start(): Promise<number> {
    if (this.server) return this.port
    for (let i = 0; i < PORT_COUNT; i++) {
      const port = FIRST_PORT + i
      const server = http.createServer((req, res) => void this.onHttp(req, res))
      server.on('upgrade', (req, socket, head) => this.onUpgrade(req, socket, head))
      const ok = await new Promise<boolean>((resolve) => {
        server.once('error', () => resolve(false))
        server.listen(port, '127.0.0.1', () => resolve(true))
      })
      if (ok) {
        this.server = server
        this.port = port
        server.on('error', (e) => this.opts.log?.('hub: ' + e.message))
        return port
      }
      server.close()
    }
    throw new Error(`no free port in ${FIRST_PORT}-${FIRST_PORT + PORT_COUNT - 1}`)
  }

  async stop(): Promise<void> {
    for (const c of this.conns) c.ws.close()
    this.conns = []
    for (const p of this.pending.values()) {
      clearTimeout(p.timer)
      p.reject(new Error('Jolty is closing'))
    }
    this.pending.clear()
    await new Promise<void>((r) => (this.server ? this.server.close(() => r()) : r()))
    this.server = undefined
    this.port = 0
  }

  get connected(): boolean {
    return this.active() !== undefined
  }

  get extension(): ExtInfo | undefined {
    return this.active()?.info
  }

  private active(): Conn | undefined {
    for (let i = this.conns.length - 1; i >= 0; i--) if (this.conns[i].ready && this.conns[i].ws.readyState === WebSocket.OPEN) return this.conns[i]
    return undefined
  }

  /** Asks the extension to do something and waits for the answer. */
  request<T = unknown>(method: string, params: Record<string, unknown> = {}, timeoutMs = 30000): Promise<T> {
    const conn = this.active()
    if (!conn) return Promise.reject(new Error('The Jolty browser extension is not connected.'))
    const id = ++this.seq
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`${method} did not answer in ${Math.round(timeoutMs / 1000)}s`))
      }, timeoutMs)
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer, conn })
      conn.ws.send(JSON.stringify({ id, method, params }), (err) => {
        if (!err) return
        clearTimeout(timer)
        this.pending.delete(id)
        reject(err)
      })
    })
  }

  cdp<T = Record<string, unknown>>(tabId: number, method: string, params: Record<string, unknown> = {}, sessionId?: string, timeoutMs = 30000): Promise<T> {
    return this.request<T>('cdp', { tabId, method, params, ...(sessionId ? { sessionId } : {}) }, timeoutMs)
  }

  // ------------------------------------------------------------------ HTTP (hello + MCP)
  /** Only a request addressed to this very server: a web page that rebinds a DNS name to 127.0.0.1 sends another Host. */
  private hostOk(req: http.IncomingMessage): boolean {
    return /^(127\.0\.0\.1|localhost|\[::1\]):\d+$/i.test(String(req.headers.host || ''))
  }

  private async onHttp(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    if (!this.hostOk(req)) {
      res.writeHead(421).end()
      return
    }
    const url = new URL(req.url || '/', 'http://127.0.0.1')
    // no CORS headers anywhere: a web page must not be able to talk to this server, only the extension and the engines can
    if (req.method === 'GET' && url.pathname === '/jolty-hello') {
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ app: 'jolty', v: 1 }))
      return
    }
    const m = /^\/mcp\/([A-Za-z0-9_.-]{1,80})$/.exec(url.pathname)
    if (!m) {
      res.writeHead(404).end()
      return
    }
    const bearer = /^Bearer (.+)$/.exec(String(req.headers.authorization || ''))?.[1] || ''
    if (!bearer || !safeEqual(bearer, this.opts.token())) {
      res.writeHead(401).end()
      return
    }
    if (req.method !== 'POST') {
      // no server-initiated stream: the client falls back to plain request / response
      res.writeHead(405, { allow: 'POST' }).end()
      return
    }
    let body = ''
    req.setEncoding('utf8')
    for await (const chunk of req) {
      body += chunk as string
      if (body.length > 20 * 1024 * 1024) {
        res.writeHead(413).end()
        return
      }
    }
    let message: unknown
    try {
      message = JSON.parse(body)
    } catch {
      res.writeHead(400).end()
      return
    }
    try {
      const batch = Array.isArray(message)
      const replies: Record<string, unknown>[] = []
      for (const item of (batch ? message : [message]) as unknown[]) {
        const r = await this.opts.mcp(m[1], item as Record<string, unknown>)
        if (r) replies.push(r)
      }
      if (!replies.length) {
        res.writeHead(202).end()
        return
      }
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(batch ? replies : replies[0]))
    } catch (e) {
      this.opts.log?.('mcp: ' + (e instanceof Error ? e.stack : String(e)))
      res.writeHead(500).end()
    }
  }

  // ------------------------------------------------------------------ the extension
  private onUpgrade(req: http.IncomingMessage, socket: import('stream').Duplex, head: Buffer): void {
    const origin = String(req.headers.origin || '')
    if (!this.hostOk(req) || new URL(req.url || '/', 'http://127.0.0.1').pathname !== '/ext' || !origin.startsWith('chrome-extension://')) {
      socket.destroy()
      return
    }
    this.wss.handleUpgrade(req, socket, head, (ws) => this.onExtension(ws))
  }

  private onExtension(ws: WebSocket): void {
    const conn: Conn = { ws, ready: false }
    // an unknown caller gets 5 seconds to prove itself
    const gate = setTimeout(() => ws.close(4401, 'no hello'), 5000)
    ws.on('message', (data) => {
      let msg: Record<string, unknown>
      try {
        msg = JSON.parse(String(data))
      } catch {
        return
      }
      if (!conn.ready) {
        if (msg.type !== 'hello' || typeof msg.token !== 'string' || !safeEqual(msg.token, this.opts.token())) {
          ws.send(JSON.stringify({ type: 'reject', reason: 'wrong token: let Jolty install the extension again' }))
          ws.close(4401, 'bad token')
          return
        }
        clearTimeout(gate)
        conn.ready = true
        conn.info = { version: String(msg.version || ''), agent: String(msg.agent || '') }
        this.conns.push(conn)
        ws.send(JSON.stringify({ type: 'ready', bundled: this.opts.bundledVersion() }))
        this.emit('status', true)
        return
      }
      this.onMessage(conn, msg)
    })
    ws.on('close', () => {
      clearTimeout(gate)
      const had = this.conns.includes(conn)
      this.conns = this.conns.filter((c) => c !== conn)
      for (const [id, p] of this.pending) {
        if (p.conn !== conn) continue
        clearTimeout(p.timer)
        this.pending.delete(id)
        p.reject(new Error('The Jolty browser extension disconnected.'))
      }
      if (had) this.emit('status', this.connected)
    })
    ws.on('error', () => ws.close())
  }

  private onMessage(conn: Conn, msg: Record<string, unknown>): void {
    if (msg.type === 'ping') {
      conn.ws.send('{"type":"pong"}')
      return
    }
    if (typeof msg.id === 'number') {
      const p = this.pending.get(msg.id)
      if (!p) return
      this.pending.delete(msg.id)
      clearTimeout(p.timer)
      const err = msg.error as { message?: string } | undefined
      if (err) p.reject(new Error(err.message || 'extension error'))
      else p.resolve(msg.result)
      return
    }
    if (msg.type === 'event') this.emit('event', msg.tabId as number, msg.method as string, (msg.params || {}) as Record<string, unknown>, msg.sessionId as string | undefined)
    else if (msg.type === 'detached') this.emit('detached', msg.tabId as number, String(msg.reason || ''))
    else if (msg.type === 'tabRemoved') this.emit('tabRemoved', msg.tabId as number)
    else if (msg.type === 'tabCreated') this.emit('tabCreated', msg.tab as never, msg.openerTabId as number | undefined)
  }

  /** Tells every connected extension to reload itself (after Jolty replaced its files). */
  reloadExtension(): void {
    for (const c of this.conns) c.ws.send('{"type":"reload"}')
  }
}
