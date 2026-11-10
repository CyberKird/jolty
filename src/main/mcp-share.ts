// The user's own MCP servers (the stdio ones in ~/.claude.json) run once for the whole app instead of once per chat.
// Every chat, whatever the engine, gets an http address on Jolty's local server under the server's own name, so the
// tools keep their names. The real server starts on the first tool call (until then its tool list comes from a cache),
// is shared by all chats, and stops after it has been idle for a while.
import { execFile, spawn, type ChildProcess } from 'child_process'
import crypto from 'crypto'
import fs from 'fs'
import os from 'os'
import path from 'path'

type Msg = Record<string, unknown>

export interface StdioServer {
  command: string
  args: string[]
  env: Record<string, string>
}

/** The user's MCP configuration. JOLTY_CLAUDE_JSON lets a test point at its own file: os.homedir() ignores HOME on Windows. */
const claudeJsonPath = (): string => process.env.JOLTY_CLAUDE_JSON || path.join(os.homedir(), '.claude.json')

/** what the local server accepts in its address */
const SHAREABLE_NAME = /^[A-Za-z0-9_.-]{1,80}$/
const LIST_TTL = 12 * 3600_000
const START_TIMEOUT = 120_000
const CALL_TIMEOUT = 10 * 60_000
export const IDLE_MS = 10 * 60_000

// ------------------------------------------------------------------ the user's configuration
const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [])

/** `${VAR}` and `${VAR:-default}`, the way Claude Code reads its MCP configuration */
const expand = (s: string): string => s.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g, (_m, k: string, d?: string) => process.env[k] ?? d ?? '')

let parsed: { file: string; mtime: number; servers: Record<string, StdioServer> } | undefined

/** The stdio servers of ~/.claude.json (the user scope). Remote servers cost no process, project servers belong to one folder: Claude Code keeps both. */
export function userStdioServers(file = claudeJsonPath()): Record<string, StdioServer> {
  try {
    const mtime = fs.statSync(file).mtimeMs
    if (parsed?.file === file && parsed.mtime === mtime) return parsed.servers
    const raw = (JSON.parse(fs.readFileSync(file, 'utf8')) as { mcpServers?: Record<string, Record<string, unknown>> }).mcpServers || {}
    const servers: Record<string, StdioServer> = {}
    for (const [name, s] of Object.entries(raw)) {
      if (!SHAREABLE_NAME.test(name) || !s || typeof s.command !== 'string' || (s.type && s.type !== 'stdio')) continue
      const env: Record<string, string> = {}
      for (const [k, v] of Object.entries((s.env as Record<string, unknown>) || {})) if (typeof v === 'string') env[k] = expand(v)
      servers[name] = { command: expand(s.command), args: strings(s.args).map(expand), env }
    }
    parsed = { file, mtime, servers }
    return servers
  } catch {
    return {}
  }
}

/** Every MCP server name of ~/.claude.json (the user scope), whatever its type: the connectors a chat can switch off. */
export function userServerNames(file = claudeJsonPath()): string[] {
  try {
    return Object.keys((JSON.parse(fs.readFileSync(file, 'utf8')) as { mcpServers?: Record<string, unknown> }).mcpServers || {})
  } catch {
    return []
  }
}

// ------------------------------------------------------------------ starting a server
/** Windows: `npx` is npx.cmd, which only cmd.exe can run; a plain name is looked up in PATH with PATHEXT like cmd does. */
function resolveWindows(command: string, env: NodeJS.ProcessEnv): string {
  const exts = (env.PATHEXT || '.COM;.EXE;.BAT;.CMD').toLowerCase().split(';')
  const own = exts.includes(path.extname(command).toLowerCase())
  const dirs = /[\\/]/.test(command) ? [''] : (env.PATH || env.Path || '').split(';')
  for (const dir of dirs) for (const ext of own ? [''] : exts) {
    const f = path.join(dir, command + ext)
    try {
      if (fs.statSync(f).isFile()) return f
    } catch { /* next candidate */ }
  }
  return command
}

// shortcut: cmd.exe quoting covers spaces and the usual shell characters, not every exotic argument; revisit if a server fails to start only on Windows
const quote = (a: string): string => (/[\s"&|<>^()%!]/.test(a) ? `"${a.replace(/"/g, '""')}"` : a)

function launch(cfg: StdioServer): ChildProcess {
  const env = { ...process.env, ...cfg.env }
  const stdio: ['pipe', 'pipe', 'pipe'] = ['pipe', 'pipe', 'pipe']
  if (process.platform !== 'win32') return spawn(cfg.command, cfg.args, { env, stdio })
  const exe = resolveWindows(cfg.command, env)
  if (/\.(cmd|bat)$/i.test(exe)) return spawn(env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `"${[exe, ...cfg.args].map(quote).join(' ')}"`], { env, stdio, windowsHide: true, windowsVerbatimArguments: true })
  return spawn(exe, cfg.args, { env, stdio, windowsHide: true })
}

/** npx and cmd.exe start the real server as a child, so the whole tree goes. */
function killTree(proc: ChildProcess): void {
  if (!proc.pid || proc.exitCode !== null) return
  if (process.platform === 'win32') execFile('taskkill.exe', ['/PID', String(proc.pid), '/T', '/F'], { windowsHide: true, timeout: 5000 }, () => {})
  else proc.kill('SIGTERM')
}

interface Pending {
  resolve: (m: Msg) => void
  reject: (e: Error) => void
  timer: NodeJS.Timeout
}

/** One running server: JSON-RPC lines over its stdin and stdout. */
class Child {
  private proc: ChildProcess
  private pending = new Map<number, Pending>()
  private seq = 0
  private buf = ''
  private err = ''
  private busy = 0
  private idle?: NodeJS.Timeout
  dead = false
  instructions?: string
  ready: Promise<void>

  constructor(private name: string, cfg: StdioServer, private idleMs: number, private onExit: () => void, private log?: (m: string) => void) {
    this.proc = launch(cfg)
    this.proc.stdout!.setEncoding('utf8')
    this.proc.stdout!.on('data', (d: string) => this.read(d))
    this.proc.stderr!.setEncoding('utf8')
    this.proc.stderr!.on('data', (d: string) => {
      this.err = (this.err + d).slice(-2000)
    })
    this.proc.stdin!.on('error', () => {})
    this.proc.on('error', (e) => this.exit(e.message))
    this.proc.on('exit', (code) => this.exit(`exited (${code})`))
    this.ready = this.handshake()
  }

  private async handshake(): Promise<void> {
    const r = await this.rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'jolty', version: '1' } }, START_TIMEOUT)
    if (r.error) throw new Error(`${this.name}: ${(r.error as { message?: string }).message || 'initialize failed'}`)
    this.instructions = (r.result as { instructions?: string } | undefined)?.instructions
    this.write({ jsonrpc: '2.0', method: 'notifications/initialized' })
  }

  private write(m: Msg): void {
    if (!this.dead) this.proc.stdin!.write(JSON.stringify(m) + '\n')
  }

  private read(chunk: string): void {
    this.buf += chunk
    for (let i = this.buf.indexOf('\n'); i >= 0; i = this.buf.indexOf('\n')) {
      const line = this.buf.slice(0, i).trim()
      this.buf = this.buf.slice(i + 1)
      if (!line) continue
      let m: Msg
      try {
        m = JSON.parse(line)
      } catch {
        continue // a server that prints logs on stdout
      }
      const p = typeof m.id === 'number' && !m.method ? this.pending.get(m.id) : undefined
      if (!p) continue // its own notifications and requests: there is no client on this side to answer
      clearTimeout(p.timer)
      this.pending.delete(m.id as number)
      p.resolve(m)
    }
  }

  private exit(why: string): void {
    if (this.dead) return
    this.dead = true
    clearTimeout(this.idle)
    const msg = `MCP server ${this.name} ${why}${this.err ? ': ' + this.err.trim().split('\n').slice(-3).join(' | ') : ''}`
    this.log?.(msg)
    for (const p of this.pending.values()) {
      clearTimeout(p.timer)
      p.reject(new Error(msg))
    }
    this.pending.clear()
    this.onExit()
  }

  private rpc(method: string, params: unknown, timeoutMs: number): Promise<Msg> {
    return new Promise((resolve, reject) => {
      if (this.dead) return reject(new Error(`MCP server ${this.name} is not running`))
      const id = ++this.seq
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`MCP server ${this.name}: ${method} did not answer in ${Math.round(timeoutMs / 1000)}s`))
      }, timeoutMs)
      this.pending.set(id, { resolve, reject, timer })
      this.write({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) })
    })
  }

  /** A request after the handshake; the idle clock stops while it runs. */
  async request(method: string, params: unknown, timeoutMs = CALL_TIMEOUT): Promise<Msg> {
    await this.ready
    clearTimeout(this.idle)
    this.busy++
    try {
      return await this.rpc(method, params, timeoutMs)
    } finally {
      this.busy--
      if (!this.busy) this.idle = setTimeout(() => this.stop(), this.idleMs)
    }
  }

  async listTools(): Promise<unknown[]> {
    const tools: unknown[] = []
    let cursor: string | undefined
    do {
      const r = await this.request('tools/list', cursor ? { cursor } : undefined, START_TIMEOUT)
      if (r.error) throw new Error(`${this.name}: ${(r.error as { message?: string }).message || 'tools/list failed'}`)
      const res = (r.result || {}) as { tools?: unknown[]; nextCursor?: string }
      tools.push(...(res.tools || []))
      cursor = res.nextCursor
    } while (cursor)
    return tools
  }

  stop(): void {
    this.exit('stopped')
    killTree(this.proc)
  }
}

// ------------------------------------------------------------------ the shared set
interface Listed {
  hash: string
  at: number
  tools: unknown[]
  instructions?: string
}

export interface ShareOptions {
  servers: () => Record<string, StdioServer>
  /** where the tool lists are remembered, so a server nobody calls never has to start */
  cacheFile: () => string
  idleMs?: number
  log?: (m: string) => void
}

export class McpShare {
  private children = new Map<string, Promise<Child>>()
  private lists: Record<string, Listed> | undefined

  constructor(private o: ShareOptions) {}

  /** The names with a running process right now. */
  async running(): Promise<string[]> {
    const live: string[] = []
    for (const [name, c] of this.children) if (!(await c.catch(() => undefined))?.dead) live.push(name)
    return live
  }

  async stop(): Promise<void> {
    const all = [...this.children.values()]
    this.children.clear()
    for (const c of all) (await c.catch(() => undefined))?.stop()
  }

  private hash(cfg: StdioServer): string {
    return crypto.createHash('sha1').update(JSON.stringify(cfg)).digest('hex').slice(0, 12)
  }

  private cached(name: string, cfg: StdioServer): Listed | undefined {
    if (!this.lists) {
      try {
        this.lists = JSON.parse(fs.readFileSync(this.o.cacheFile(), 'utf8'))
      } catch {
        this.lists = {}
      }
    }
    const l = this.lists![name]
    return l && l.hash === this.hash(cfg) ? l : undefined
  }

  private remember(name: string, cfg: StdioServer, tools: unknown[], instructions?: string): void {
    this.lists = { ...(this.lists || {}), [name]: { hash: this.hash(cfg), at: Date.now(), tools, instructions } }
    try {
      const file = this.o.cacheFile()
      fs.mkdirSync(path.dirname(file), { recursive: true })
      const tmp = `${file}.${process.pid}.tmp`
      fs.writeFileSync(tmp, JSON.stringify(this.lists))
      fs.renameSync(tmp, file)
    } catch {
      // the cache only saves a start; losing it is not an error
    }
  }

  private child(name: string, cfg: StdioServer): Promise<Child> {
    let p = this.children.get(name)
    if (p) return p
    const c = new Child(name, cfg, this.o.idleMs ?? IDLE_MS, () => this.children.delete(name), this.o.log)
    p = c.ready.then(() => {
      // a fresh start is the moment to refresh the remembered list, in the background
      void c.listTools().then((tools) => this.remember(name, cfg, tools, c.instructions)).catch(() => {})
      return c
    })
    this.children.set(name, p)
    p.catch(() => {
      if (this.children.get(name) === p) this.children.delete(name)
      c.stop()
    })
    return p
  }

  private async tools(name: string, cfg: StdioServer): Promise<unknown[]> {
    const hit = this.cached(name, cfg)
    if (hit && Date.now() - hit.at < LIST_TTL) return hit.tools
    try {
      const c = await this.child(name, cfg)
      const tools = await c.listTools()
      this.remember(name, cfg, tools, c.instructions)
      return tools
    } catch (e) {
      if (hit) return hit.tools // the list from earlier is better than a server shown as broken
      throw e
    }
  }

  /** One JSON-RPC message for the server `name`, as the engines send it; undefined = a notification, no reply. */
  async handle(name: string, msg: Msg): Promise<Msg | undefined> {
    const id = msg.id
    if (id === undefined || id === null) return undefined
    const ok = (result: unknown): Msg => ({ jsonrpc: '2.0', id, result })
    const fail = (code: number, message: string): Msg => ({ jsonrpc: '2.0', id, error: { code, message } })
    const cfg = this.o.servers()[name]
    if (!cfg) return fail(-32602, `Unknown MCP server ${name}`)
    const method = String(msg.method || '')
    try {
      if (method === 'initialize') {
        const instructions = this.cached(name, cfg)?.instructions
        const asked = (msg.params as { protocolVersion?: string } | undefined)?.protocolVersion
        return ok({ protocolVersion: asked || '2025-06-18', capabilities: { tools: {} }, serverInfo: { name, version: '1' }, ...(instructions ? { instructions } : {}) })
      }
      if (method === 'ping') return ok({})
      if (method === 'tools/list') return ok({ tools: await this.tools(name, cfg) })
      if (method === 'tools/call') {
        const r = await (await this.child(name, cfg)).request('tools/call', msg.params)
        return r.error ? { jsonrpc: '2.0', id, error: r.error } : ok(r.result)
      }
      return fail(-32601, 'Method not found')
    } catch (e) {
      return fail(-32603, e instanceof Error ? e.message : String(e))
    }
  }
}
