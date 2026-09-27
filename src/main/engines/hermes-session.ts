import { randomUUID } from 'crypto'
import type { Attachment, PermissionDecision, PermissionMode, Profile, SessionMeta } from '@shared/types'
import type { EngineHost, EngineSession } from './types'
import { JsonRpcProcess, type RpcRequest } from './jsonrpc'
import { count, HermesEvents, list, object, str, toolDiffs, type AcpObject } from './hermes-events'

export type HermesLaunch = () => JsonRpcProcess

export async function initializeHermes(rpc: JsonRpcProcess): Promise<AcpObject> {
  return object(await rpc.request('initialize', {
    protocolVersion: 1, clientInfo: { name: 'jolty', version: '0.2.1' }, clientCapabilities: {}
  }))
}

export function hermesMode(mode: PermissionMode): string {
  if (mode === 'plan') throw new Error('Hermes ACP nu oferă un mod Plan protejat. Alege aprobarea editărilor.')
  return mode === 'autoEdit' ? 'accept_edits' : mode === 'full' ? 'dont_ask' : 'default'
}

type Pending = { rpcId: number | string; options: AcpObject[]; timer: NodeJS.Timeout }

export class HermesSession implements EngineSession {
  private rpc?: JsonRpcProcess
  private ready?: Promise<JsonRpcProcess>
  private sessionId?: string
  private loading = false
  private busy = false
  private closed = false
  private cancelled = false
  private pending = new Map<string, Pending>()
  private events: HermesEvents

  constructor(readonly meta: SessionMeta, private profile: Profile, private host: EngineHost, private launch: HermesLaunch) {
    this.events = new HermesEvents(meta.id, (e) => host.emit(e))
  }

  private async ensure(): Promise<JsonRpcProcess> {
    if (this.closed) throw new Error('Conversația Hermes este închisă.')
    if (this.ready) return this.ready
    this.ready = this.connect().catch((error) => {
      this.rpc?.kill()
      this.rpc = undefined
      this.ready = undefined
      throw error
    })
    return this.ready
  }

  private async connect(): Promise<JsonRpcProcess> {
    hermesMode(this.meta.permissionMode)
    if (this.meta.browser) throw new Error('Conectarea la browserul Jolty nu este disponibilă pentru Hermes.')
    const rpc = this.launch()
    this.rpc = rpc
    rpc.on('request', (r: RpcRequest) => this.onRequest(r))
    rpc.on('notification', (n) => {
      const p = object(n.params)
      if (n.method === 'session/update' && p.sessionId === this.sessionId && !this.loading) this.events.update(p.update)
    })
    rpc.on('exit', () => {
      if (this.rpc !== rpc) return
      this.resolvePending()
      this.ready = undefined
      this.rpc = undefined
    })
    const init = await initializeHermes(rpc)
    if (init.protocolVersion !== 1) throw new Error('Versiunea ACP oferită de Hermes nu este compatibilă.')
    this.sessionId = this.meta.engineSessionId
    this.loading = true
    try {
      const params = { cwd: this.meta.cwd, mcpServers: [] }
      const response = this.sessionId
        ? await rpc.request('session/load', { ...params, sessionId: this.sessionId })
        : await rpc.request('session/new', params)
      if (!response || typeof response !== 'object') throw new Error('Hermes nu a găsit conversația. Reimportă istoricul înainte să continui.')
      const state = object(response)
      if (!this.sessionId) this.sessionId = str(state.sessionId)
      if (!this.sessionId) throw new Error('Hermes nu a creat conversația.')
      const currentModel = str(object(state.models).currentModelId)
      this.meta.engineSessionId = this.sessionId
      if (this.meta.model && this.meta.model !== currentModel) await rpc.request('session/set_model', { sessionId: this.sessionId, modelId: this.meta.model })
      else if (!this.meta.model) this.meta.model = currentModel || undefined
      await rpc.request('session/set_mode', { sessionId: this.sessionId, modeId: hermesMode(this.meta.permissionMode) })
      this.host.emit({ type: 'meta', sessionId: this.meta.id, meta: this.meta })
      return rpc
    } finally {
      this.loading = false
    }
  }

  async send(text: string, images: Attachment[] = []): Promise<void> {
    if (this.busy) throw new Error('Hermes lucrează deja în această conversație.')
    this.busy = true
    this.cancelled = false
    this.events.reset()
    this.host.emit({ type: 'status', sessionId: this.meta.id, status: 'running' })
    try {
      const rpc = await this.ensure()
      if (this.cancelled || this.closed) return
      const prompt = [{ type: 'text', text }, ...images.map((i) => ({ type: 'image', mimeType: i.mime, data: i.data || '' }))]
      const result = object(await rpc.request('session/prompt', { sessionId: this.sessionId, prompt }, 60 * 60 * 1000))
      if (result.usage) {
        const usage = object(result.usage)
        const cacheRead = Math.min(count(usage.inputTokens), count(usage.cachedReadTokens))
        this.host.recordUsage({
          profileId: this.profile.id, engine: 'hermes', model: this.meta.model || 'Hermes',
          inputTokens: Math.max(0, count(usage.inputTokens) - cacheRead), outputTokens: count(usage.outputTokens),
          cacheReadTokens: cacheRead, cacheWriteTokens: 0, ts: Date.now()
        })
      }
      this.host.emit({ type: 'status', sessionId: this.meta.id, status: 'idle' })
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err)
      if (!this.closed) this.host.emit({ type: 'status', sessionId: this.meta.id, status: 'error', error })
      if (/session\/prompt: fără răspuns/.test(error)) { this.rpc?.kill(); this.ready = undefined }
      throw err
    } finally {
      this.busy = false
      this.resolvePending()
      if (this.cancelled && !this.closed) this.host.emit({ type: 'status', sessionId: this.meta.id, status: 'idle' })
    }
  }

  private onRequest(request: RpcRequest): void {
    const rpc = this.rpc
    if (!rpc) return
    const p = object(request.params)
    if (request.method !== 'session/request_permission') {
      rpc.respondError(request.id, 'Metodă ACP client nesuportată')
      return
    }
    if (!this.busy || this.cancelled || this.closed || p.sessionId !== this.sessionId) {
      rpc.respond(request.id, { outcome: { outcome: 'cancelled' } })
      return
    }
    const id = randomUUID()
    const tool = object(p.toolCall)
    const options = list(p.options).filter((o) => typeof o.optionId === 'string')
    const timer = setTimeout(() => this.respond(id, 'deny'), 55000)
    this.pending.set(id, { rpcId: request.id, options, timer })
    this.host.emit({ type: 'permission', sessionId: this.meta.id, request: {
      id, toolName: str(tool.kind) || 'Hermes', title: str(tool.title) || 'Aprobare Hermes',
      detail: typeof tool.rawInput === 'object' ? JSON.stringify(tool.rawInput, null, 2) : undefined,
      diffs: toolDiffs(tool.content), canAllowForSession: options.some((o) => o.optionId === 'allow_session')
    } })
  }

  respond(id: string, decision: PermissionDecision): void {
    const pending = this.pending.get(id)
    if (!pending) return
    this.pending.delete(id)
    clearTimeout(pending.timer)
    const selected = decision === 'allowSession'
      ? pending.options.find((o) => o.optionId === 'allow_session')
      : pending.options.find((o) => o.kind === (decision === 'allow' ? 'allow_once' : 'reject_once'))
    if (this.rpc && !this.rpc.exited) this.rpc.respond(pending.rpcId, { outcome: selected
      ? { outcome: 'selected', optionId: selected.optionId } : { outcome: 'cancelled' } })
    this.host.emit({ type: 'permissionResolved', sessionId: this.meta.id, requestId: id })
  }

  private resolvePending(): void {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer)
      if (this.rpc && !this.rpc.exited) this.rpc.respond(pending.rpcId, { outcome: { outcome: 'cancelled' } })
      this.host.emit({ type: 'permissionResolved', sessionId: this.meta.id, requestId: id })
    }
    this.pending.clear()
  }

  async interrupt(): Promise<void> {
    this.cancelled = true
    this.resolvePending()
    if (this.rpc && !this.rpc.exited && this.sessionId) this.rpc.notify('session/cancel', { sessionId: this.sessionId })
  }

  async setModel(model: string): Promise<void> {
    if (this.busy) throw new Error('Oprește răspunsul Hermes înainte să schimbi modelul.')
    if (this.sessionId) await (await this.ensure()).request('session/set_model', { sessionId: this.sessionId, modelId: model })
    this.meta.model = model
  }

  async setPermissionMode(mode: PermissionMode): Promise<void> {
    const modeId = hermesMode(mode)
    if (this.busy) throw new Error('Oprește răspunsul Hermes înainte să schimbi permisiunile.')
    if (this.sessionId) await (await this.ensure()).request('session/set_mode', { sessionId: this.sessionId, modeId })
    this.meta.permissionMode = mode
  }

  async setEffort(effort: string): Promise<void> {
    if (effort) throw new Error('Hermes folosește efortul din configurația proprie.')
    this.meta.effort = undefined
  }

  async setBrowser(on: boolean): Promise<void> {
    if (on) throw new Error('Hermes folosește uneltele proprii de browser; conectarea la browserul Jolty nu este disponibilă.')
    this.meta.browser = undefined
  }

  async compact(): Promise<void> { await this.send('/compact') }
  async rewind(): Promise<never> { throw new Error('Hermes nu păstrează copii ale fișierelor pe mesaj. Folosește git pentru a reveni.') }

  async close(): Promise<void> {
    this.closed = true
    await this.interrupt()
    this.rpc?.kill()
    this.ready = undefined
  }
}
