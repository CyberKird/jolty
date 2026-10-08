import { randomUUID } from 'crypto'
import type { Attachment, FileDiff, PermissionDecision, PermissionMode, Profile, SessionMeta } from '@shared/types'
import { BROWSER_BLOCKED_TOOLS, browserPrompt, BROWSER_READ_TOOLS, BROWSER_SERVER, browserServer } from '../browser'
import { codexItem, planItemSteps, saveImages } from './codex-items'
import { JsonRpcProcess, type RpcRequest } from './jsonrpc'
import { PLAN_RULES, WRITING_RULES } from './prompt'
import type { EngineHost, EngineSession } from './types'
import { tr } from '@shared/i18n'

type Any = any

const MODES: Record<PermissionMode, { approvalPolicy: string; sandbox: 'read-only' | 'workspace-write' | 'danger-full-access' }> = {
  auto: { approvalPolicy: 'on-request', sandbox: 'workspace-write' },
  ask: { approvalPolicy: 'untrusted', sandbox: 'workspace-write' },
  autoEdit: { approvalPolicy: 'on-request', sandbox: 'workspace-write' },
  plan: { approvalPolicy: 'on-request', sandbox: 'read-only' },
  project: { approvalPolicy: 'never', sandbox: 'workspace-write' },
  full: { approvalPolicy: 'never', sandbox: 'danger-full-access' }
}

function sandboxPolicy(mode: PermissionMode, cwd: string): Any {
  const sandbox = MODES[mode].sandbox
  if (sandbox === 'read-only') return { type: 'readOnly', networkAccess: false }
  if (sandbox === 'danger-full-access') return { type: 'dangerFullAccess' }
  return { type: 'workspaceWrite', writableRoots: [cwd], networkAccess: mode === 'project', excludeTmpdirEnvVar: false, excludeSlashTmp: false }
}

interface Usage {
  totalTokens: number
  inputTokens: number
  cachedInputTokens: number
  cacheWriteInputTokens: number
  outputTokens: number
}

export interface ThreadListener {
  onNotification(method: string, p: Any): void
  onRequest(r: RpcRequest): boolean
  onServerExit(reason: string): void
}

export interface CodexConnection {
  rpc?: JsonRpcProcess
  get(): Promise<JsonRpcProcess>
  sessions: Map<string, ThreadListener>
}

export class CodexSession implements EngineSession, ThreadListener {
  private threadId?: string
  private threadStarting?: Promise<JsonRpcProcess>
  private turnId?: string
  private completedTurns = new Set<string>()
  private startPending = 0
  private operation = 0
  private pendingIdle = false
  private stopRequested = false
  private interruptSent?: string
  private activityVersion = 0
  private status: 'idle' | 'running' | 'error' = 'idle'
  private hasStructuredPlan = false
  private pending = new Map<string, number | string>()
  private liveOutput = new Map<string, string>()
  private diffs = new Map<string, FileDiff[]>()
  private running = new Map<string, Any>()
  private lastTotal?: Usage
  private turnUsage: Usage = { totalTokens: 0, inputTokens: 0, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 0 }
  private overrides: Record<string, unknown> = {}
  private effortSent = false
  private flushTimer?: NodeJS.Timeout

  constructor(
    readonly meta: SessionMeta,
    private profile: Profile,
    private host: EngineHost,
    private server: CodexConnection
  ) {}

  private notice(text: string, level: 'info' | 'warn' | 'error'): void {
    this.host.emit({ type: 'item', sessionId: this.meta.id, item: { kind: 'notice', id: randomUUID(), text, level } })
  }

  private setStatus(status: 'idle' | 'running' | 'error', error?: string): void {
    if (this.status === status && !error) return
    this.status = status
    this.host.emit({ type: 'status', sessionId: this.meta.id, status, ...(error ? { error } : {}) })
  }

  private finishTurn(id = this.turnId, terminalStatus = 'failed'): void {
    if (id) {
      this.completedTurns.add(id)
      if (this.completedTurns.size > 32) this.completedTurns.delete(this.completedTurns.values().next().value!)
    }
    this.turnId = undefined
    this.startPending = 0
    this.activityVersion++
    if (this.flushTimer) clearTimeout(this.flushTimer)
    this.flushTimer = undefined
    for (const [itemId, raw] of this.running) {
      const item = codexItem({ ...raw, status: terminalStatus, aggregatedOutput: this.liveOutput.get(itemId) || raw.aggregatedOutput })
      if (item) this.host.emit({ type: 'item', sessionId: this.meta.id, item })
    }
    this.running.clear()
    this.liveOutput.clear()
    for (const requestId of this.pending.keys()) this.host.emit({ type: 'permissionResolved', sessionId: this.meta.id, requestId })
    this.pending.clear()
  }

  private requestFailed(err: unknown, version: number, submitted: boolean): void {
    const message = err instanceof Error ? err.message : String(err)
    if (submitted && this.pendingIdle) { this.finishTurn(); this.setStatus('idle') }
    // A request timeout says nothing about a turn already observed on the event stream.
    if (this.activityVersion !== version && this.status !== 'error') this.notice(message, 'warn')
    else {
      this.notice(message, 'error')
      this.setStatus('error', message)
    }
  }

  private async ensureThread(): Promise<JsonRpcProcess> {
    if (this.threadStarting) return this.threadStarting
    this.threadStarting = this.startThread()
    try {
      return await this.threadStarting
    } finally {
      this.threadStarting = undefined
    }
  }

  private async startThread(): Promise<JsonRpcProcess> {
    const rpc = await this.server.get()
    if (this.threadId) return rpc
    const mode = MODES[this.meta.permissionMode]
    const common = {
      cwd: this.meta.cwd,
      model: this.meta.model || null,
      approvalPolicy: mode.approvalPolicy,
      sandbox: mode.sandbox,
      developerInstructions: this.meta.browser ? `${WRITING_RULES} ${PLAN_RULES} ${browserPrompt()}` : `${WRITING_RULES} ${PLAN_RULES}`,
      ...(this.meta.browser ? { config: { mcp_servers: { [BROWSER_SERVER]: this.browserConfig() } } } : {})
    }
    const resp = this.meta.engineSessionId
      ? await rpc.request<Any>('thread/resume', { threadId: this.meta.engineSessionId, ...common })
      : await rpc.request<Any>('thread/start', common)
    this.threadId = resp.thread.id as string
    this.server.sessions.set(this.threadId, this)
    this.meta.engineSessionId = this.threadId
    this.meta.model = resp.model
    this.host.emit({ type: 'meta', sessionId: this.meta.id, meta: this.meta })
    return rpc
  }

  async send(text: string, images: Attachment[] = []): Promise<void> {
    if (this.startPending || this.status === 'running') throw new Error(tr("Conversația lucrează deja. Pune mesajul în așteptare."))
    const operation = ++this.operation
    this.startPending = operation
    this.stopRequested = false
    this.pendingIdle = false
    let submitted = false
    const version = this.activityVersion
    this.setStatus('running')
    try {
      const rpc = await this.ensureThread()
      if (this.stopRequested) { this.setStatus('idle'); return }
      const input = [...saveImages(images).map((p) => ({ type: 'localImage', path: p })), { type: 'text', text, text_elements: [] }]
      if (this.meta.effort && !this.effortSent) {
        this.overrides.effort = this.meta.effort
        this.effortSent = true
      }
      const params = { threadId: this.threadId, input, ...this.overrides }
      this.overrides = {}
      this.pendingIdle = false
      submitted = true
      const r = await rpc.request<Any>('turn/start', params)
      if (this.operation !== operation) return
      const turn = r?.turn
      if (turn?.id && !this.completedTurns.has(turn.id) && !this.turnId) {
        this.turnId = turn.id
        if (turn.status && turn.status !== 'inProgress') this.onNotification('turn/completed', { turn })
      }
      if (this.pendingIdle) { this.finishTurn(); this.setStatus('idle') }
      if (this.stopRequested) await this.interrupt()
    } catch (err) {
      if (this.operation === operation) this.requestFailed(err, version, submitted)
    } finally { if (this.startPending === operation) this.startPending = 0 }
  }

  onNotification(method: string, p: Any): void {
    const sid = this.meta.id
    if (p.turnId && (this.completedTurns.has(p.turnId) || (this.turnId && p.turnId !== this.turnId))) return
    if (p.turnId && /^(item\/|turn\/plan\/)/.test(method)) {
      this.pendingIdle = false
      this.turnId = p.turnId
      this.activityVersion++
      this.setStatus('running')
      if (this.stopRequested) void this.interrupt().catch((err) => this.notice(String(err), 'warn'))
    }
    switch (method) {
      case 'thread/status/changed':
        if (p.status?.type === 'active') {
          this.pendingIdle = false
          this.activityVersion++
          this.setStatus('running')
        } else if (p.status?.type === 'idle' || p.status?.type === 'notLoaded') {
          if (this.startPending && !this.turnId) { this.pendingIdle = true; return }
          this.finishTurn()
          this.setStatus('idle')
        } else if (p.status?.type === 'systemError') {
          this.finishTurn()
          this.setStatus('error', tr("Conversația Codex s-a oprit cu o eroare."))
        }
        return
      case 'turn/started':
        if (this.completedTurns.has(p.turn?.id)) return
        this.turnId = p.turn?.id
        this.pendingIdle = false
        this.activityVersion++
        this.interruptSent = undefined
        this.hasStructuredPlan = false
        this.turnUsage = { totalTokens: 0, inputTokens: 0, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 0 }
        this.setStatus('running')
        if (this.stopRequested) void this.interrupt().catch((err) => this.notice(String(err), 'warn'))
        return
      case 'turn/completed': {
        const t = p.turn
        if (this.completedTurns.has(t?.id) && (this.startPending || this.turnId)) return
        if (this.turnId && t?.id !== this.turnId) return
        if (t?.status === 'failed' && t.error) this.notice(t.error.message, 'error')
        if (t?.status === 'interrupted') this.notice('Oprit.', 'info')
        if (this.turnUsage.totalTokens > 0) {
          this.host.recordUsage({
            profileId: this.profile.id,
            engine: 'codex',
            model: this.meta.model || 'necunoscut',
            inputTokens: this.turnUsage.inputTokens,
            outputTokens: this.turnUsage.outputTokens,
            cacheReadTokens: this.turnUsage.cachedInputTokens,
            cacheWriteTokens: this.turnUsage.cacheWriteInputTokens,
            ts: Date.now()
          })
        }
        this.turnUsage = { totalTokens: 0, inputTokens: 0, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 0 }
        this.finishTurn(t?.id, t?.status === 'completed' ? 'completed' : 'failed')
        this.setStatus(t?.status === 'failed' ? 'error' : 'idle', t?.status === 'failed' ? t.error?.message : undefined)
        return
      }
      case 'item/started':
      case 'item/completed': {
        const item = p.item?.type === 'contextCompaction' && method === 'item/started'
          ? { kind: 'notice' as const, id: p.item.id, text: tr("Compactez conversația. Răspunsul continuă după compactare."), level: 'info' as const }
          : codexItem(p.item, this.liveOutput.get(p.item?.id))
        if (!item || p.item?.type === 'userMessage') return
        if (item.kind === 'tool' && item.diffs) this.diffs.set(item.id, item.diffs)
        if (method === 'item/completed') {
          this.liveOutput.delete(item.id)
          this.running.delete(item.id)
          if (p.item?.type === 'fileChange') {
            for (const c of p.item.changes || []) {
              this.host.emit({ type: 'draft', sessionId: sid, toolId: `${item.id}:${c.path}`, name: 'Edit', path: c.path, content: c.diff || '', done: true })
            }
          }
        } else if (item.kind === 'tool') {
          this.running.set(item.id, p.item)
        }
        // an empty reasoning summary only clutters the chat
        if (item.kind === 'reasoning' && !item.text && method === 'item/completed') return
        this.host.emit({ type: 'item', sessionId: sid, item })
        if (method === 'item/completed' && p.item?.type === 'plan' && p.item.text && !this.hasStructuredPlan) {
          this.host.emit({ type: 'plan', sessionId: sid, steps: planItemSteps(String(p.item.text)) })
        }
        return
      }
      case 'turn/plan/updated':
        this.hasStructuredPlan = true
        this.host.emit({
          type: 'plan',
          sessionId: sid,
          steps: (p.plan || []).map((st: Any) => ({ text: st.step, status: st.status === 'completed' ? 'done' : st.status === 'inProgress' ? 'active' : 'pending' }))
        })
        return
      case 'item/fileChange/patchUpdated':
        for (const c of p.changes || []) {
          this.host.emit({ type: 'draft', sessionId: sid, toolId: `${p.itemId}:${c.path}`, name: 'Edit', path: c.path, content: c.diff || '', done: false })
        }
        return
      case 'item/agentMessage/delta':
        this.host.emit({ type: 'delta', sessionId: sid, itemId: p.itemId, kind: 'assistant', delta: p.delta })
        return
      case 'item/reasoning/summaryTextDelta':
        this.host.emit({ type: 'delta', sessionId: sid, itemId: p.itemId, kind: 'reasoning', delta: p.delta })
        return
      case 'item/commandExecution/outputDelta': {
        this.liveOutput.set(p.itemId, (this.liveOutput.get(p.itemId) || '') + p.delta)
        if (!this.flushTimer) this.flushTimer = setTimeout(() => this.flushOutput(), 300)
        return
      }
      case 'thread/tokenUsage/updated': {
        const last = p.tokenUsage?.last as Record<string, number> | undefined
        if (last) {
          const used = last.totalTokens || (last.inputTokens || 0) + (last.outputTokens || 0)
          this.host.emit({ type: 'context', sessionId: sid, used, window: p.tokenUsage?.modelContextWindow || undefined })
        }
        const total = p.tokenUsage?.total as Usage | undefined
        if (!total) return
        const prev = this.lastTotal
        for (const k of Object.keys(this.turnUsage) as (keyof Usage)[]) {
          const delta = prev && total[k] >= prev[k] ? total[k] - prev[k] : prev ? total[k] : (p.tokenUsage?.last?.[k] ?? 0)
          this.turnUsage[k] += delta
        }
        this.lastTotal = total
        return
      }
      case 'serverRequest/resolved': {
        for (const [id, rpcId] of this.pending) {
          if (String(rpcId) === String(p.requestId)) {
            this.pending.delete(id)
            this.host.emit({ type: 'permissionResolved', sessionId: sid, requestId: id })
          }
        }
        return
      }
      case 'error':
        this.notice(p.willRetry ? tr("Reîncerc: {v0}", { v0: p.error?.message }) : p.error?.message || tr("Eroare Codex"), p.willRetry ? 'warn' : 'error')
        return
      default:
        return
    }
  }

  /** Streams running command output to the chat a few times per second. */
  private flushOutput(): void {
    this.flushTimer = undefined
    for (const [id, raw] of this.running) {
      const item = codexItem(raw, this.liveOutput.get(id))
      if (item) this.host.emit({ type: 'item', sessionId: this.meta.id, item })
    }
  }

  onRequest(r: RpcRequest): boolean {
    const p = r.params as Any
    if (r.method === 'item/commandExecution/requestApproval') {
      const id = randomUUID()
      this.pending.set(id, r.id)
      this.host.emit({
        type: 'permission',
        sessionId: this.meta.id,
        request: { id, toolName: 'Shell', title: `$ ${p.command ?? ''}`, detail: p.reason || undefined, canAllowForSession: true }
      })
      return true
    }
    if (r.method === 'item/fileChange/requestApproval') {
      const id = randomUUID()
      this.pending.set(id, r.id)
      this.host.emit({
        type: 'permission',
        sessionId: this.meta.id,
        request: { id, toolName: 'Edit', title: tr("Modificări de fișiere"), detail: p.reason || undefined, diffs: this.diffs.get(p.itemId), canAllowForSession: true }
      })
      return true
    }
    return false
  }

  respond(requestId: string, decision: PermissionDecision): void {
    const rpcId = this.pending.get(requestId)
    if (rpcId === undefined) return
    this.pending.delete(requestId)
    const value = decision === 'allow' ? 'accept' : decision === 'allowSession' ? 'acceptForSession' : 'decline'
    this.server.rpc?.respond(rpcId, { decision: value })
    this.host.emit({ type: 'permissionResolved', sessionId: this.meta.id, requestId })
  }

  async rewind(_id: string, _dryRun?: boolean): Promise<{ files: string[]; insertions: number; deletions: number }> {
    throw new Error(tr("Codex nu păstrează copii ale fișierelor pe mesaj. Folosește git pentru a reveni."))
  }

  async compact(): Promise<void> {
    if (this.startPending || this.status === 'running') throw new Error(tr("Conversația lucrează deja."))
    const operation = ++this.operation
    this.startPending = operation
    this.stopRequested = false
    this.pendingIdle = false
    let submitted = false
    const version = this.activityVersion
    this.setStatus('running')
    try {
      const rpc = await this.ensureThread()
      if (this.stopRequested) { this.setStatus('idle'); return }
      this.pendingIdle = false
      submitted = true
      await rpc.request('thread/compact/start', { threadId: this.threadId })
      if (this.operation === operation && this.pendingIdle) { this.finishTurn(); this.setStatus('idle') }
    } catch (err) {
      if (this.operation === operation) this.requestFailed(err, version, submitted)
    } finally { if (this.startPending === operation) this.startPending = 0 }
  }

  async interrupt(): Promise<void> {
    this.stopRequested = true
    if (!this.threadId || !this.turnId) return
    const turnId = this.turnId
    if (this.interruptSent === turnId) return
    this.interruptSent = turnId
    const rpc = await this.server.get()
    try {
      await rpc.request('turn/interrupt', { threadId: this.threadId, turnId })
    } catch (err) {
      if (this.completedTurns.has(turnId)) return
      this.interruptSent = undefined
      throw err
    }
  }

  async setModel(model: string): Promise<void> {
    this.meta.model = model
    this.overrides.model = model
  }

  async setEffort(effort: string): Promise<void> {
    this.meta.effort = effort
    this.overrides.effort = effort
    this.effortSent = true
  }

  /** The Playwright server for this thread; reading pages runs on its own outside Manual mode. */
  private browserConfig(): Record<string, unknown> {
    const tools = this.meta.permissionMode === 'ask' ? {} : Object.fromEntries(BROWSER_READ_TOOLS.map((t) => [t, { approval_mode: 'approve' }]))
    return { ...browserServer(), disabled_tools: BROWSER_BLOCKED_TOOLS, tools }
  }

  async setBrowser(on: boolean): Promise<void> {
    if (Boolean(this.meta.browser) === on) return
    this.meta.browser = on
    // thread config is fixed at start: the next message resumes the same thread with the new servers
    if (!this.turnId) this.threadId = undefined
  }

  async setPermissionMode(mode: PermissionMode): Promise<void> {
    this.meta.permissionMode = mode
    this.overrides.approvalPolicy = MODES[mode].approvalPolicy
    this.overrides.sandboxPolicy = sandboxPolicy(mode, this.meta.cwd)
  }

  onServerExit(reason: string): void {
    this.effortSent = false
    this.threadId = undefined
    this.finishTurn()
    this.notice(reason, 'error')
    this.setStatus('error', reason)
  }

  async close(): Promise<void> {
    if (this.flushTimer) clearTimeout(this.flushTimer)
    for (const [id, rpcId] of this.pending) {
      this.server.rpc?.respond(rpcId, { decision: 'cancel' })
      this.pending.delete(id)
    }
    if (this.threadId) {
      this.server.sessions.delete(this.threadId)
      try {
        await this.server.rpc?.request('thread/unsubscribe', { threadId: this.threadId }, 5000)
      } catch {
        // the thread stays on disk either way
      }
    }
    this.threadId = undefined
  }
}
