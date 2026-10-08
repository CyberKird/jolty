import { spawn, type ChildProcessWithoutNullStreams } from 'child_process'
import { EventEmitter } from 'events'
import { tr } from '@shared/i18n'

export interface RpcRequest {
  id: number | string
  method: string
  params: unknown
}

export interface RpcNotification {
  method: string
  params: unknown
}

/** Newline-delimited JSON-RPC over a child process's stdio (the protocol `codex app-server` speaks). */
export class JsonRpcProcess extends EventEmitter {
  private proc: ChildProcessWithoutNullStreams
  private nextId = 1
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; method: string }>()
  private buffer = ''
  private stderrTail = ''
  exited = false

  constructor(exe: string, args: string[], env: Record<string, string>) {
    super()
    this.proc = spawn(exe, args, { env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
    this.proc.stdout.setEncoding('utf8')
    this.proc.stdout.on('data', (chunk: string) => this.onData(chunk))
    this.proc.stderr.setEncoding('utf8')
    this.proc.stderr.on('data', (chunk: string) => {
      this.stderrTail = (this.stderrTail + chunk).slice(-4000)
      if (process.env.JOLTY_DEBUG) console.error('[codex]', chunk)
    })
    this.proc.on('error', (err) => this.onExit(err.message))
    this.proc.on('exit', (code) => this.onExit(`Codex s-a oprit (cod ${code}). ${this.stderrTail.trim().split('\n').slice(-3).join(' ')}`))
  }

  private onExit(reason: string): void {
    if (this.exited) return
    this.exited = true
    for (const p of this.pending.values()) p.reject(new Error(reason))
    this.pending.clear()
    this.emit('exit', reason)
  }

  private onData(chunk: string): void {
    this.buffer += chunk
    let nl: number
    while ((nl = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, nl).trim()
      this.buffer = this.buffer.slice(nl + 1)
      if (!line) continue
      let msg: Record<string, unknown>
      try {
        msg = JSON.parse(line)
      } catch {
        continue
      }
      this.dispatch(msg)
    }
  }

  private dispatch(msg: Record<string, unknown>): void {
    const hasId = msg.id !== undefined && msg.id !== null
    if (hasId && ('result' in msg || 'error' in msg)) {
      const p = this.pending.get(Number(msg.id))
      if (!p) return
      this.pending.delete(Number(msg.id))
      if (msg.error) {
        const e = msg.error as { message?: string }
        p.reject(new Error(`${p.method}: ${e.message || JSON.stringify(e)}`))
      } else {
        p.resolve(msg.result)
      }
    } else if (hasId && typeof msg.method === 'string') {
      this.emit('request', { id: msg.id, method: msg.method, params: msg.params } as RpcRequest)
    } else if (typeof msg.method === 'string') {
      this.emit('notification', { method: msg.method, params: msg.params } as RpcNotification)
    }
  }

  private write(obj: unknown): void {
    if (this.exited) throw new Error(tr("Codex nu mai rulează"))
    this.proc.stdin.write(JSON.stringify(obj) + '\n')
  }

  request<T = unknown>(method: string, params: unknown = {}, timeoutMs = 120000): Promise<T> {
    const id = this.nextId++
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error(tr("{method}: fără răspuns de la Codex", { method })))
      }, timeoutMs)
      this.pending.set(id, {
        method,
        resolve: (v) => {
          clearTimeout(timer)
          resolve(v as T)
        },
        reject: (e) => {
          clearTimeout(timer)
          reject(e)
        }
      })
      try {
        this.write({ id, method, params })
      } catch (err) {
        this.pending.delete(id)
        clearTimeout(timer)
        reject(err as Error)
      }
    })
  }

  notify(method: string, params?: unknown): void {
    this.write(params === undefined ? { method } : { method, params })
  }

  respond(id: number | string, result: unknown): void {
    this.write({ id, result })
  }

  respondError(id: number | string, message: string): void {
    this.write({ id, error: { code: -32000, message } })
  }

  kill(): void {
    if (!this.exited) this.proc.kill()
  }
}
