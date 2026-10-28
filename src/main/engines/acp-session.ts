import { randomUUID } from 'crypto'
import { noQuestions, type Attachment, type PermissionDecision, type PermissionMode, type Profile, type SessionMeta } from '@shared/types'
import { loadSettings } from '../store'
import { touchesSecretFile } from './secret-files'
import type { EngineHost, EngineSession } from './types'
import { JsonRpcProcess, type RpcRequest } from './jsonrpc'
import { count, AcpEvents, list, object, str, toolDiffs, type AcpObject } from './acp-events'
import { HERMES, type AcpAgent } from './acp-agent'
import { acpBrowserServers, acpComputerServers, acpJoltyServers } from '../browser-mcp'
import { tr } from '@shared/i18n'

export type AcpLaunch = (mode: PermissionMode, browser: boolean, computer: boolean) => JsonRpcProcess

export async function initializeAcp(rpc: JsonRpcProcess): Promise<AcpObject> {
  return object(await rpc.request('initialize', {
    protocolVersion: 1, clientInfo: { name: 'jolty', version: '0.2.1' }, clientCapabilities: {}
  }))
}

type Pending = { rpcId: number | string; options: AcpObject[]; timer: NodeJS.Timeout }

export class AcpSession implements EngineSession {
  private rpc?: JsonRpcProcess
  private ready?: Promise<JsonRpcProcess>
  private sessionId?: string
  private loading = false
  private busy = false
  private closed = false
  private cancelled = false
  /** the process was started with other approvals or browser than the chat has now: the next message restarts it */
  private stale = false
  private pending = new Map<string, Pending>()
  private events: AcpEvents

  constructor(readonly meta: SessionMeta, private profile: Profile, private host: EngineHost, private launch: AcpLaunch, private agent: AcpAgent = HERMES) {
    this.events = new AcpEvents(meta.id, (e) => host.emit(e), agent.name)
  }

  private async ensure(): Promise<JsonRpcProcess> {
    if (this.closed) throw new Error(tr("Conversația {agent} este închisă.", { agent: this.agent.name }))
    if (this.stale) {
      this.stale = false
      this.rpc?.kill()
      this.rpc = undefined
      this.ready = undefined
    }
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
    const modeId = this.agent.modeId(this.meta.permissionMode)
    if (this.meta.browser && !this.agent.browser) throw new Error(tr("Conectarea la browserul Jolty nu este disponibilă pentru {agent}.", { agent: this.agent.name }))
    if (this.meta.computer && !this.agent.browser) throw new Error(tr("Controlul PC-ului nu este disponibil pentru {agent}.", { agent: this.agent.name }))
    const browser = Boolean(this.meta.browser)
    const computer = Boolean(this.meta.computer)
    const rpc = this.launch(this.meta.permissionMode, browser, computer)
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
    const init = await initializeAcp(rpc)
    if (init.protocolVersion !== 1) throw new Error(tr("Versiunea ACP oferită de {agent} nu este compatibilă.", { agent: this.agent.name }))
    this.sessionId = this.meta.engineSessionId
    this.loading = true
    try {
      const params = { cwd: this.meta.cwd, mcpServers: [...(browser ? acpBrowserServers(this.meta.id) : []), ...(computer ? acpComputerServers(this.meta.id) : []), ...(this.agent.joltyTools ? acpJoltyServers(this.meta.id) : [])] }
      const response = this.sessionId
        ? await rpc.request('session/load', { ...params, sessionId: this.sessionId })
        : await rpc.request('session/new', params)
      if (!response || typeof response !== 'object') throw new Error(tr("{agent} nu a găsit conversația. Reimportă istoricul înainte să continui.", { agent: this.agent.name }))
      const state = object(response)
      if (!this.sessionId) this.sessionId = str(state.sessionId)
      if (!this.sessionId) throw new Error(tr("{agent} nu a creat conversația.", { agent: this.agent.name }))
      const currentModel = this.agent.currentModel(state)
      this.meta.engineSessionId = this.sessionId
      if (this.meta.model && this.meta.model !== currentModel) await this.agent.setModel(rpc, this.sessionId, this.meta.model)
      else if (!this.meta.model) this.meta.model = currentModel || undefined
      await this.applyEffort(rpc)
      await this.agent.setMode(rpc, this.sessionId, modeId)
      this.host.emit({ type: 'meta', sessionId: this.meta.id, meta: this.meta })
      return rpc
    } finally {
      this.loading = false
    }
  }

  async send(text: string, images: Attachment[] = []): Promise<void> {
    // Stop shows "idle" at once, the turn ends a moment later: a message sent in between waits for it
    for (let i = 0; this.cancelled && this.busy && i < 80; i++) await new Promise((r) => setTimeout(r, 100))
    if (this.busy) throw new Error(tr("{agent} lucrează deja în această conversație.", { agent: this.agent.name }))
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
          profileId: this.profile.id, engine: this.agent.engine, model: this.meta.model || this.agent.name,
          inputTokens: Math.max(0, count(usage.inputTokens) - cacheRead), outputTokens: count(usage.outputTokens),
          cacheReadTokens: cacheRead, cacheWriteTokens: 0, ts: Date.now()
        })
      }
      this.host.emit({ type: 'status', sessionId: this.meta.id, status: 'idle' })
    } catch (err) {
      // a turn Stop had to end by killing the agent is a stop, not an error
      if (this.cancelled) return
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
      rpc.respondError(request.id, tr("Metodă ACP client nesuportată"))
      return
    }
    if (!this.busy || this.cancelled || this.closed || p.sessionId !== this.sessionId) {
      rpc.respond(request.id, { outcome: { outcome: 'cancelled' } })
      return
    }
    const id = randomUUID()
    const tool = object(p.toolCall)
    const options = list(p.options).filter((o) => typeof o.optionId === 'string')
    // OpenCode in "No questions" asks nothing; the one exception is a secret file while "ask before touching secret files" is on
    const once = options.find((o) => o.kind === 'allow_once')
    if (once && this.agent.engine === 'opencode' && noQuestions(this.meta.permissionMode) && (loadSettings().protectSecretFiles === false || !touchesSecretFile({ ...object(tool.rawInput), locations: tool.locations }))) {
      rpc.respond(request.id, { outcome: { outcome: 'selected', optionId: once.optionId } })
      return
    }
    const timer = setTimeout(() => this.respond(id, 'deny'), 55000)
    this.pending.set(id, { rpcId: request.id, options, timer })
    this.host.emit({ type: 'permission', sessionId: this.meta.id, request: {
      id, toolName: str(tool.kind) || this.agent.name, title: str(tool.title) || tr("Aprobare {agent}", { agent: this.agent.name }),
      detail: typeof tool.rawInput === 'object' ? JSON.stringify(tool.rawInput, null, 2) : undefined,
      diffs: toolDiffs(tool.content), canAllowForSession: options.some(this.agent.sessionAllow)
    } })
  }

  respond(id: string, decision: PermissionDecision): void {
    const pending = this.pending.get(id)
    if (!pending) return
    this.pending.delete(id)
    clearTimeout(pending.timer)
    const selected = decision === 'allowSession'
      ? pending.options.find(this.agent.sessionAllow)
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
    // an agent that ignores the cancel (a tool that never returns) is ended with its child processes; the next message starts it again
    const rpc = this.rpc
    if (this.busy && rpc) {
      setTimeout(() => {
        if (!this.busy || !this.cancelled || this.rpc !== rpc || this.closed) return
        this.rpc = undefined
        this.ready = undefined
        void rpc.stop().catch(() => rpc.kill())
      }, 4000)
    }
  }

  async setModel(model: string): Promise<void> {
    if (this.busy) throw new Error(tr("Oprește răspunsul {agent} înainte să schimbi modelul.", { agent: this.agent.name }))
    if (this.sessionId) {
      const rpc = await this.ensure()
      await this.agent.setModel(rpc, this.sessionId, model)
      this.meta.model = model
      await this.applyEffort(rpc)
    }
    this.meta.model = model
  }

  async setPermissionMode(mode: PermissionMode): Promise<void> {
    const modeId = this.agent.modeId(mode)
    if (this.busy) throw new Error(tr("Oprește răspunsul {agent} înainte să schimbi permisiunile.", { agent: this.agent.name }))
    // approvals are set when the process starts: the next message reconnects and loads the same conversation
    if (this.agent.restartOnMode) this.stale = true
    else if (this.sessionId) await this.agent.setMode(await this.ensure(), this.sessionId, modeId)
    this.meta.permissionMode = mode
  }

  /** A new model starts on its own default level, so the chat's level goes on again; one the model lacks is dropped. */
  private async applyEffort(rpc: JsonRpcProcess): Promise<void> {
    if (!this.meta.effort || !this.agent.setEffort || !this.sessionId) return
    try { await this.agent.setEffort(rpc, this.sessionId, this.meta.effort) } catch { this.meta.effort = undefined }
  }

  async setEffort(effort: string): Promise<void> {
    if (effort && !this.agent.setEffort) throw new Error(tr("{agent} folosește efortul din configurația proprie.", { agent: this.agent.name }))
    this.meta.effort = effort || undefined
    if (this.agent.setEffort && this.sessionId) await this.agent.setEffort(await this.ensure(), this.sessionId, effort)
  }

  async setBrowser(on: boolean): Promise<void> {
    if (on && this.agent.browser) {
      if (!this.meta.browser) this.stale = true
      this.meta.browser = true
      return
    }
    if (!on && this.agent.browser) {
      if (this.meta.browser) this.stale = true
      this.meta.browser = undefined
      return
    }
    if (on) throw new Error(tr("{agent} folosește uneltele proprii de browser; conectarea la browserul Jolty nu este disponibilă.", { agent: this.agent.name }))
    this.meta.browser = undefined
  }

  async setComputer(on: boolean): Promise<void> {
    if (on && !this.agent.browser) throw new Error(tr("Controlul PC-ului nu este disponibil pentru {agent}.", { agent: this.agent.name }))
    if (Boolean(this.meta.computer) !== on) this.stale = true
    this.meta.computer = on || undefined
  }

  async compact(): Promise<void> {
    if (!this.agent.compactCommand) throw new Error(tr("{agent} își comprimă singur conversația.", { agent: this.agent.name }))
    const sessionId = this.meta.id
    this.host.emit({ type: 'compacting', sessionId, active: true })
    try {
      await this.send(this.agent.compactCommand)
    } finally {
      // the agent has no signal of its own: the command ending is the end of the compaction
      this.host.emit({ type: 'compacting', sessionId, active: false })
    }
  }
  async rewind(): Promise<never> { throw new Error(tr("{agent} nu păstrează copii ale fișierelor pe mesaj. Folosește git pentru a reveni.", { agent: this.agent.name })) }

  async close(): Promise<void> {
    this.closed = true
    await this.interrupt()
    this.rpc?.kill()
    this.ready = undefined
  }
}
