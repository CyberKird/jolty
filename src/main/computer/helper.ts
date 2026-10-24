// The native helper process: compiled once with the csc.exe that ships with Windows, started when the first
// chat turns computer control on, one for the whole app, stopped (by PID) when the app quits.
// Protocol: one JSON object per line, requests {id, cmd, ...}, answers {id, ok, ...}, events {event}.
import { execFile, spawn, type ChildProcess } from 'child_process'
import { createHash } from 'crypto'
import { EventEmitter } from 'events'
import fs from 'fs'
import path from 'path'
import { ProfileProcesses } from '../engines/profile-processes'
import { HELPER_SOURCE, HELPER_VERSION } from './helper-source'
import type { Ev } from './plan'

export interface WinInfo {
  hwnd: number
  title: string
  cls: string
  pid: number
  exe: string
  path: string
  x: number
  y: number
  w: number
  h: number
  minimized: boolean
  maximized: boolean
  focused: boolean
  z: number
}

export interface Rect {
  x: number
  y: number
  w: number
  h: number
}

export interface HelperState {
  x: number
  y: number
  foreground: WinInfo | null
  secure: boolean
  idleMs: number
  virtual: Rect
}

export interface PlayResult {
  done: number
  total: number
  reason: 'ok' | 'abort' | 'user' | 'foreground'
  lateAvgMs: number
  lateMaxMs: number
  x: number
  y: number
  fg: number
}

export interface UiNode {
  d: number
  type: string
  name: string
  id: string
  cls: string
  x: number
  y: number
  w: number
  h: number
  enabled: boolean
  focus: boolean
  offscreen: boolean
  password: boolean
  value?: string
}

export interface FocusedElement {
  type: string
  name: string
  id: string
  cls: string
  pid: number
  password: boolean
}

/** What the service needs from the machine. The real one is NativeInput; tests bring a fake. */
export interface InputBackend {
  start(): Promise<void>
  stop(): Promise<void>
  state(): Promise<HelperState>
  windows(): Promise<WinInfo[]>
  windowAt(x: number, y: number): Promise<WinInfo | null>
  focus(hwnd: number): Promise<boolean>
  play(events: Ev[], opts?: { guard?: number; allowUser?: boolean }): Promise<PlayResult>
  focused(): Promise<FocusedElement | null>
  uiTree(hwnd: number, maxNodes: number, maxDepth: number): Promise<{ nodes: UiNode[]; truncated: boolean; error?: string }>
  launch(target: string): Promise<number>
  abort(): Promise<void>
  idleMs(): Promise<number>
  setKillKey(vk: number, mods: number): Promise<void>
  /** the kill chord was pressed on the keyboard */
  onKill(cb: () => void): void
}

export const csc = (): string => path.join(process.env.WINDIR || 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe')

/** Compiles the helper into `dir` (once per source version) and returns the executable. */
export async function compileHelper(dir: string): Promise<string> {
  const hash = createHash('sha1').update(HELPER_SOURCE).digest('hex').slice(0, 8)
  const exe = path.join(dir, `helper-${HELPER_VERSION}-${hash}.exe`)
  if (fs.existsSync(exe)) return exe
  if (!fs.existsSync(csc())) throw new Error('The .NET Framework compiler (csc.exe) was not found, so the computer helper cannot be built.')
  fs.mkdirSync(dir, { recursive: true })
  const src = exe.replace(/\.exe$/, '.cs')
  fs.writeFileSync(src, HELPER_SOURCE)
  const wpf = path.join(path.dirname(csc()), 'WPF')
  await new Promise<void>((resolve, reject) => {
    execFile(
      csc(),
      ['-nologo', '-target:exe', '-platform:x64', '-optimize+', `-out:${exe}`, `-lib:${wpf}`, '-r:System.Web.Extensions.dll', '-r:UIAutomationClient.dll', '-r:UIAutomationTypes.dll', '-r:WindowsBase.dll', '-r:System.Core.dll', src],
      { windowsHide: true, timeout: 90000 },
      (err, out, errOut) => (err ? reject(new Error(`Building the computer helper failed: ${String(out || errOut).slice(0, 600)}`)) : resolve())
    )
  })
  // older builds are no longer needed
  for (const f of fs.readdirSync(dir)) if (/^helper-/.test(f) && !f.startsWith(path.basename(exe, '.exe'))) try { fs.rmSync(path.join(dir, f)) } catch { /* in use: next time */ }
  return exe
}

interface Pending {
  resolve: (v: Record<string, unknown>) => void
  reject: (e: Error) => void
  timer: NodeJS.Timeout
}

export class NativeInput extends EventEmitter implements InputBackend {
  private child?: ChildProcess
  private starting?: Promise<void>
  private pending = new Map<number, Pending>()
  private seq = 0
  private buf = ''
  private killCb: Array<() => void> = []
  private killKey?: { vk: number; mods: number }
  private readonly procs = new ProfileProcesses()

  constructor(private dir: () => string) {
    super()
  }

  get pid(): number | undefined {
    return this.child?.pid
  }

  onKill(cb: () => void): void {
    this.killCb.push(cb)
  }

  start(): Promise<void> {
    this.starting ??= this.boot().catch((e) => {
      this.starting = undefined
      throw e
    })
    return this.starting
  }

  private async boot(): Promise<void> {
    if (process.platform !== 'win32') throw new Error('Computer control works on Windows only.')
    const exe = await compileHelper(this.dir())
    const child = spawn(exe, [], { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true })
    this.procs.track('computer', child)
    this.child = child
    child.stdout!.setEncoding('utf8')
    child.stdout!.on('data', (d: string) => this.onData(d))
    child.stdin!.on('error', () => undefined)
    child.once('exit', () => {
      if (this.child !== child) return
      this.child = undefined
      this.starting = undefined
      for (const [id, p] of this.pending) {
        clearTimeout(p.timer)
        p.reject(new Error('The computer helper stopped.'))
        this.pending.delete(id)
      }
    })
    await this.call('hello', {}, 8000)
    if (this.killKey) await this.call('killkey', this.killKey)
  }

  private onData(chunk: string): void {
    this.buf += chunk
    let i: number
    while ((i = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, i).trim()
      this.buf = this.buf.slice(i + 1)
      if (!line) continue
      let msg: Record<string, unknown>
      try {
        msg = JSON.parse(line)
      } catch {
        continue
      }
      if (msg.event === 'kill') {
        for (const cb of this.killCb) cb()
        continue
      }
      const p = this.pending.get(msg.id as number)
      if (!p) continue
      this.pending.delete(msg.id as number)
      clearTimeout(p.timer)
      if (msg.ok === false) p.reject(new Error(String(msg.error || 'helper error')))
      else p.resolve(msg)
    }
  }

  private call<T = Record<string, unknown>>(cmd: string, params: Record<string, unknown> = {}, timeoutMs = 20000): Promise<T> {
    const child = this.child
    const stdin = child?.stdin
    if (!stdin || stdin.destroyed) return Promise.reject(new Error('The computer helper is not running.'))
    const id = ++this.seq
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`${cmd} did not answer in ${Math.round(timeoutMs / 1000)}s`))
      }, timeoutMs)
      this.pending.set(id, { resolve: resolve as (v: Record<string, unknown>) => void, reject, timer })
      stdin.write(JSON.stringify({ id, cmd, ...params }) + '\n', (err) => {
        if (!err) return
        clearTimeout(timer)
        this.pending.delete(id)
        reject(err)
      })
    })
  }

  private async ready(): Promise<void> {
    await this.start()
  }

  async stop(): Promise<void> {
    const child = this.child
    this.child = undefined
    this.starting = undefined
    if (!child) return
    try {
      child.stdin?.end()
    } catch {
      /* already closed */
    }
    // by PID, never by name
    await this.procs.stop('computer').catch(() => undefined)
  }

  async state(): Promise<HelperState> {
    await this.ready()
    return (await this.call('state')) as unknown as HelperState
  }

  async windows(): Promise<WinInfo[]> {
    await this.ready()
    return ((await this.call('windows')) as unknown as { value: WinInfo[] }).value
  }

  async windowAt(x: number, y: number): Promise<WinInfo | null> {
    await this.ready()
    return ((await this.call('windowAt', { x, y })) as unknown as { window: WinInfo | null }).window
  }

  async focus(hwnd: number): Promise<boolean> {
    await this.ready()
    return ((await this.call('focus', { hwnd })) as unknown as { focused: boolean }).focused
  }

  async play(events: Ev[], opts: { guard?: number; allowUser?: boolean } = {}): Promise<PlayResult> {
    await this.ready()
    const end = events.reduce((m, e) => Math.max(m, e[1] + (e[0] === 'c' ? e[3] : 0)), 0)
    return (await this.call('play', { events, ...(opts.guard ? { guard: opts.guard } : {}), ...(opts.allowUser ? { allowUser: true } : {}) }, end + 15000)) as unknown as PlayResult
  }

  async focused(): Promise<FocusedElement | null> {
    await this.ready()
    return ((await this.call('focused', {}, 6000)) as unknown as { element: FocusedElement | null }).element
  }

  async uiTree(hwnd: number, maxNodes: number, maxDepth: number): Promise<{ nodes: UiNode[]; truncated: boolean; error?: string }> {
    await this.ready()
    return (await this.call('uitree', { hwnd, maxNodes, maxDepth }, 15000)) as never
  }

  async launch(target: string): Promise<number> {
    await this.ready()
    return ((await this.call('launch', { target })) as unknown as { pid: number }).pid
  }

  async abort(): Promise<void> {
    if (!this.child) return
    await this.call('abort', {}, 3000).catch(() => undefined)
  }

  async idleMs(): Promise<number> {
    await this.ready()
    return ((await this.call('idle', {}, 3000)) as unknown as { idleMs: number }).idleMs
  }

  async setKillKey(vk: number, mods: number): Promise<void> {
    this.killKey = { vk, mods }
    if (this.child) await this.call('killkey', this.killKey, 3000).catch(() => undefined)
  }
}
