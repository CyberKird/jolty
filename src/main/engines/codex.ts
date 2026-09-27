import { randomUUID } from 'crypto'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { shell } from 'electron'
import type {
  AccountStatus,
  Attachment,
  ChatItem,
  ExternalSession,
  FileDiff,
  LimitWindow,
  ModelOption,
  PermissionDecision,
  PermissionMode,
  Profile,
  RateLimitSnapshot,
  SessionMeta
} from '@shared/types'
import { codexEnv, codexExecutable, prepareProfileDir } from '../runtime'
import { getSecret } from '../store'
import { truncate } from './format'
import { JsonRpcProcess, type RpcNotification, type RpcRequest } from './jsonrpc'
import type { EngineDriver, EngineHost, EngineSession } from './types'

// Loose views of the app-server payloads (the full types come from `codex app-server generate-ts`).
/* eslint-disable @typescript-eslint/no-explicit-any */
type Any = any

const MODES: Record<PermissionMode, { approvalPolicy: string; sandbox: 'read-only' | 'workspace-write' | 'danger-full-access' }> = {
  ask: { approvalPolicy: 'untrusted', sandbox: 'workspace-write' },
  autoEdit: { approvalPolicy: 'on-request', sandbox: 'workspace-write' },
  plan: { approvalPolicy: 'on-request', sandbox: 'read-only' },
  full: { approvalPolicy: 'never', sandbox: 'danger-full-access' }
}

function sandboxPolicy(mode: PermissionMode, cwd: string): Any {
  const sandbox = MODES[mode].sandbox
  if (sandbox === 'read-only') return { type: 'readOnly', networkAccess: false }
  if (sandbox === 'danger-full-access') return { type: 'dangerFullAccess' }
  return { type: 'workspaceWrite', writableRoots: [cwd], networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false }
}

function windowLabel(mins: number | null | undefined, fallback: string): string {
  if (!mins) return fallback
  if (mins % 1440 === 0) return mins === 1440 ? '24 ore' : `${mins / 1440} zile`
  if (mins % 60 === 0) return `${mins / 60} ore`
  return `${mins} min`
}

function toMs(t: number | null | undefined): number | undefined {
  if (!t) return undefined
  return t < 1e12 ? t * 1000 : t
}

export function codexLimitSnapshot(profileId: string, snap: Any): RateLimitSnapshot {
  const windows: LimitWindow[] = []
  if (snap?.primary) windows.push({ label: windowLabel(snap.primary.windowDurationMins, 'Principală'), usedPercent: snap.primary.usedPercent, resetsAt: toMs(snap.primary.resetsAt) })
  if (snap?.secondary) windows.push({ label: windowLabel(snap.secondary.windowDurationMins, 'Secundară'), usedPercent: snap.secondary.usedPercent, resetsAt: toMs(snap.secondary.resetsAt) })
  const notes: string[] = []
  if (snap?.planType) notes.push(`Plan: ${snap.planType}`)
  if (snap?.credits?.balance != null) notes.push(`Credite: ${snap.credits.balance}`)
  if (snap?.rateLimitReachedType) notes.push('Limita a fost atinsă')
  return { profileId, windows, note: notes.join(' · ') || undefined, updatedAt: Date.now() }
}

function toolStatus(s: string | undefined): 'running' | 'done' | 'error' {
  if (s === 'completed') return 'done'
  if (s === 'failed' || s === 'declined') return 'error'
  return 'running'
}

/** Converts one app-server thread item into a Jolty chat item (undefined = not shown). */
export function codexItem(item: Any, liveOutput?: string): ChatItem | undefined {
  switch (item?.type) {
    case 'userMessage': {
      const text = (item.content || []).filter((c: Any) => c.type === 'text').map((c: Any) => c.text).join('\n')
      return text ? { kind: 'user', id: item.id, text } : undefined
    }
    case 'agentMessage':
      return { kind: 'assistant', id: item.id, text: item.text || '' }
    case 'reasoning':
      return { kind: 'reasoning', id: item.id, text: (item.summary || []).join('\n\n') }
    case 'plan':
      return { kind: 'reasoning', id: item.id, text: item.text || '' }
    case 'commandExecution':
      return {
        kind: 'tool',
        id: item.id,
        name: 'Shell',
        title: `$ ${item.command}`,
        command: item.command,
        status: toolStatus(item.status),
        output: truncate(item.aggregatedOutput ?? liveOutput ?? '')
      }
    case 'fileChange': {
      const diffs: FileDiff[] = (item.changes || []).map((c: Any) => ({ path: c.path, kind: c.kind?.type || 'update', diff: truncate(c.diff || '', 30000) }))
      return { kind: 'tool', id: item.id, name: 'Edit', title: `Editează ${diffs.map((d) => d.path).join(', ')}`, status: toolStatus(item.status), diffs }
    }
    case 'mcpToolCall':
      return {
        kind: 'tool',
        id: item.id,
        name: `${item.server}/${item.tool}`,
        title: `${item.server} / ${item.tool}`,
        status: toolStatus(item.status),
        input: item.arguments,
        output: item.error ? String(item.error.message ?? JSON.stringify(item.error)) : item.result ? truncate(JSON.stringify(item.result.content ?? item.result, null, 2)) : undefined
      }
    case 'webSearch':
      return { kind: 'tool', id: item.id, name: 'WebSearch', title: `Caută pe web: ${item.query ?? ''}`, status: 'done' }
    case 'contextCompaction':
      return { kind: 'notice', id: item.id, text: 'Conversația a fost compactată ca să încapă în context.', level: 'info' }
    default:
      return undefined
  }
}

interface Usage {
  totalTokens: number
  inputTokens: number
  cachedInputTokens: number
  cacheWriteInputTokens: number
  outputTokens: number
}

interface ThreadListener {
  onNotification(method: string, p: Any): void
  onRequest(r: RpcRequest): boolean
  onServerExit(reason: string): void
}

/** Writes pasted images to temp files: app-server takes images by path. */
function saveImages(images: Attachment[]): string[] {
  const dir = path.join(os.tmpdir(), 'jolty-images')
  fs.mkdirSync(dir, { recursive: true })
  return images.map((img) => {
    const ext = img.mime.split('/')[1]?.replace('jpeg', 'jpg') || 'png'
    const file = path.join(dir, `${randomUUID()}.${ext}`)
    fs.writeFileSync(file, Buffer.from(img.data, 'base64'))
    return file
  })
}

/** Collects the answer of a one-off, tool-less thread (used to describe images). */
class OneShot implements ThreadListener {
  text = ''
  done: Promise<string>
  private resolve!: (t: string) => void
  private reject!: (e: Error) => void

  constructor() {
    this.done = new Promise((res, rej) => {
      this.resolve = res
      this.reject = rej
    })
  }

  onNotification(method: string, p: Any): void {
    if (method === 'item/completed' && p.item?.type === 'agentMessage') this.text += (this.text ? '\n' : '') + (p.item.text || '')
    if (method === 'turn/completed') {
      if (p.turn?.status === 'failed') this.reject(new Error(p.turn.error?.message || 'descrierea a eșuat'))
      else this.resolve(this.text.trim())
    }
  }

  onRequest(): boolean {
    return false
  }

  onServerExit(reason: string): void {
    this.reject(new Error(reason))
  }
}

// ---------------------------------------------------------------------------
// One app-server process per profile (its own CODEX_HOME, so its own login)
// ---------------------------------------------------------------------------
class CodexServer {
  rpc?: JsonRpcProcess
  private starting?: Promise<JsonRpcProcess>
  readonly sessions = new Map<string, ThreadListener>()
  private loginWaiters: ((ok: boolean, error?: string) => void)[] = []
  private importWaiters = new Map<string, () => void>()

  constructor(
    public profile: Profile,
    private onLimits: (s: RateLimitSnapshot) => void
  ) {}

  async get(): Promise<JsonRpcProcess> {
    if (this.rpc && !this.rpc.exited) return this.rpc
    if (!this.starting) this.starting = this.spawn().finally(() => (this.starting = undefined))
    return this.starting
  }

  private async spawn(): Promise<JsonRpcProcess> {
    const exe = codexExecutable()
    if (!exe) throw new Error('Nu găsesc Codex (binarul inclus lipsește)')
    prepareProfileDir(this.profile)
    const rpc = new JsonRpcProcess(exe, ['app-server'], codexEnv(this.profile, exe))
    rpc.on('notification', (n: RpcNotification) => this.onNotification(n))
    rpc.on('request', (r: RpcRequest) => this.onRequest(rpc, r))
    rpc.on('exit', (reason: string) => {
      if (this.rpc === rpc) this.rpc = undefined
      for (const s of this.sessions.values()) s.onServerExit(reason)
      this.sessions.clear()
    })
    await rpc.request('initialize', {
      clientInfo: { name: 'jolty', title: 'Jolty', version: '0.1.0' },
      capabilities: { experimentalApi: true, requestAttestation: false }
    })
    rpc.notify('initialized')
    this.rpc = rpc
    if (this.profile.auth === 'apiKey') {
      const acct = await rpc.request<Any>('account/read', {})
      const key = getSecret(this.profile.id)
      if (!acct?.account && key) await rpc.request('account/login/start', { type: 'apiKey', apiKey: key })
    }
    return rpc
  }

  private onNotification({ method, params }: RpcNotification): void {
    const p = params as Any
    if (method === 'account/login/completed') {
      for (const w of this.loginWaiters.splice(0)) w(Boolean(p?.success), p?.error ?? undefined)
      return
    }
    if (method === 'account/rateLimits/updated') {
      this.onLimits(codexLimitSnapshot(this.profile.id, p?.rateLimits))
      return
    }
    if (method === 'externalAgentConfig/import/completed') {
      this.importWaiters.get(p?.importId)?.()
      return
    }
    const threadId = p?.threadId
    if (threadId) this.sessions.get(threadId)?.onNotification(method, p)
  }

  private onRequest(rpc: JsonRpcProcess, r: RpcRequest): void {
    const threadId = (r.params as Any)?.threadId
    const s = threadId ? this.sessions.get(threadId) : undefined
    if (s && s.onRequest(r)) return
    if (r.method === 'item/tool/requestUserInput') rpc.respond(r.id, { answers: {} })
    else if (r.method === 'execCommandApproval' || r.method === 'applyPatchApproval') rpc.respond(r.id, { decision: { denied: { rejection: 'Neacceptat de Jolty' } } })
    else rpc.respondError(r.id, 'Jolty nu suportă această cerere')
  }

  waitForLogin(timeoutMs: number): Promise<{ ok: boolean; error?: string }> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve({ ok: false, error: 'Autentificarea a expirat' }), timeoutMs)
      this.loginWaiters.push((ok, error) => {
        clearTimeout(timer)
        resolve({ ok, error })
      })
    })
  }

  waitForImport(importId: string, timeoutMs: number): Promise<void> {
    return new Promise((resolve) => {
      const done = (): void => {
        clearTimeout(timer)
        this.importWaiters.delete(importId)
        resolve()
      }
      const timer = setTimeout(done, timeoutMs)
      this.importWaiters.set(importId, done)
    })
  }

  kill(): void {
    this.rpc?.kill()
  }
}

// ---------------------------------------------------------------------------
// One Codex thread shown as a Jolty session
// ---------------------------------------------------------------------------
class CodexSession implements EngineSession, ThreadListener {
  private threadId?: string
  private turnId?: string
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
    private server: CodexServer
  ) {}

  private notice(text: string, level: 'info' | 'warn' | 'error'): void {
    this.host.emit({ type: 'item', sessionId: this.meta.id, item: { kind: 'notice', id: randomUUID(), text, level } })
  }

  private async ensureThread(): Promise<JsonRpcProcess> {
    const rpc = await this.server.get()
    if (this.threadId) return rpc
    const mode = MODES[this.meta.permissionMode]
    const common = { cwd: this.meta.cwd, model: this.meta.model || null, approvalPolicy: mode.approvalPolicy, sandbox: mode.sandbox }
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
    this.host.emit({ type: 'status', sessionId: this.meta.id, status: 'running' })
    try {
      const rpc = await this.ensureThread()
      const input = [...saveImages(images).map((p) => ({ type: 'localImage', path: p })), { type: 'text', text, text_elements: [] }]
      if (this.meta.effort && !this.effortSent) {
        this.overrides.effort = this.meta.effort
        this.effortSent = true
      }
      const params = { threadId: this.threadId, input, ...this.overrides }
      this.overrides = {}
      const r = await rpc.request<Any>('turn/start', params)
      this.turnId = r?.turn?.id
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      this.notice(message, 'error')
      this.host.emit({ type: 'status', sessionId: this.meta.id, status: 'error', error: message })
    }
  }

  onNotification(method: string, p: Any): void {
    const sid = this.meta.id
    switch (method) {
      case 'turn/started':
        this.turnId = p.turn?.id
        this.turnUsage = { totalTokens: 0, inputTokens: 0, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 0 }
        this.host.emit({ type: 'status', sessionId: sid, status: 'running' })
        return
      case 'turn/completed': {
        const t = p.turn
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
        this.turnId = undefined
        this.host.emit({ type: 'status', sessionId: sid, status: 'idle' })
        return
      }
      case 'item/started':
      case 'item/completed': {
        const item = codexItem(p.item, this.liveOutput.get(p.item?.id))
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
        } else if (p.item?.type === 'commandExecution') {
          this.running.set(item.id, p.item)
        }
        // an empty reasoning summary only clutters the chat
        if (item.kind === 'reasoning' && !item.text && method === 'item/completed') return
        this.host.emit({ type: 'item', sessionId: sid, item })
        return
      }
      case 'turn/plan/updated':
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
        this.notice(p.willRetry ? `Reîncerc: ${p.error?.message}` : p.error?.message || 'Eroare Codex', p.willRetry ? 'warn' : 'error')
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
        request: { id, toolName: 'Edit', title: 'Modificări de fișiere', detail: p.reason || undefined, diffs: this.diffs.get(p.itemId), canAllowForSession: true }
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

  async interrupt(): Promise<void> {
    if (!this.threadId || !this.turnId) return
    const rpc = await this.server.get()
    await rpc.request('turn/interrupt', { threadId: this.threadId, turnId: this.turnId })
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

  async setPermissionMode(mode: PermissionMode): Promise<void> {
    this.meta.permissionMode = mode
    this.overrides.approvalPolicy = MODES[mode].approvalPolicy
    this.overrides.sandboxPolicy = sandboxPolicy(mode, this.meta.cwd)
  }

  onServerExit(reason: string): void {
    this.effortSent = false
    this.threadId = undefined
    this.turnId = undefined
    for (const id of this.pending.keys()) this.host.emit({ type: 'permissionResolved', sessionId: this.meta.id, requestId: id })
    this.pending.clear()
    this.notice(reason, 'error')
    this.host.emit({ type: 'status', sessionId: this.meta.id, status: 'error', error: reason })
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

// ---------------------------------------------------------------------------
// Driver
// ---------------------------------------------------------------------------
export class CodexDriver implements EngineDriver {
  private servers = new Map<string, CodexServer>()
  onLimits: (s: RateLimitSnapshot) => void = () => {}

  private server(profile: Profile): CodexServer {
    let s = this.servers.get(profile.id)
    if (!s) {
      s = new CodexServer(profile, (snap) => this.onLimits(snap))
      this.servers.set(profile.id, s)
    }
    s.profile = profile
    return s
  }

  /** Stops the profile's app-server so the next call starts it with fresh settings. */
  reset(profileId: string): void {
    this.servers.get(profileId)?.kill()
    this.servers.delete(profileId)
  }

  createSession(profile: Profile, meta: SessionMeta, host: EngineHost): EngineSession {
    return new CodexSession(meta, profile, host, this.server(profile))
  }

  async status(profile: Profile): Promise<AccountStatus> {
    try {
      const rpc = await this.server(profile).get()
      const r = await rpc.request<Any>('account/read', {})
      const a = r?.account
      if (!a) return { profileId: profile.id, loggedIn: false }
      if (a.type === 'chatgpt') return { profileId: profile.id, loggedIn: true, email: a.email ?? undefined, plan: a.planType ?? undefined, detail: 'Cont ChatGPT' }
      return { profileId: profile.id, loggedIn: true, detail: a.type === 'apiKey' ? 'Cheie API OpenAI' : a.type }
    } catch (err) {
      return { profileId: profile.id, loggedIn: false, error: err instanceof Error ? err.message : String(err) }
    }
  }

  async login(profile: Profile): Promise<AccountStatus> {
    const server = this.server(profile)
    const rpc = await server.get()
    if (profile.auth === 'apiKey') {
      const key = getSecret(profile.id)
      if (!key) throw new Error('Adaugă întâi cheia API OpenAI')
      await rpc.request('account/login/start', { type: 'apiKey', apiKey: key })
      return this.status(profile)
    }
    const r = await rpc.request<Any>('account/login/start', { type: 'chatgpt' })
    const done = server.waitForLogin(10 * 60 * 1000)
    if (r?.authUrl) await shell.openExternal(r.authUrl)
    const result = await done
    const status = await this.status(profile)
    return result.ok ? status : { ...status, error: result.error }
  }

  async logout(profile: Profile): Promise<AccountStatus> {
    const rpc = await this.server(profile).get()
    await rpc.request('account/logout', {})
    return this.status(profile)
  }

  async models(profile: Profile): Promise<ModelOption[]> {
    const rpc = await this.server(profile).get()
    const out: ModelOption[] = []
    let cursor: string | null = null
    for (let page = 0; page < 5; page++) {
      const r: Any = await rpc.request('model/list', cursor ? { cursor } : {})
      for (const m of r?.data || []) {
        if (m.hidden) continue
        out.push({
          id: m.model,
          label: m.displayName || m.model,
          description: m.description,
          isDefault: Boolean(m.isDefault),
          vision: Array.isArray(m.inputModalities) ? m.inputModalities.includes('image') : undefined,
          efforts: (m.supportedReasoningEfforts || []).map((e: Any) => e.reasoningEffort),
          defaultEffort: m.defaultReasoningEffort || undefined
        })
      }
      cursor = r?.nextCursor ?? null
      if (!cursor) break
    }
    return out
  }

  async externalSessions(profile: Profile, cwd?: string): Promise<ExternalSession[]> {
    const rpc = await this.server(profile).get()
    const r = await rpc.request<Any>('thread/list', cwd ? { cwd, limit: 40 } : { limit: 200 })
    return (r?.data || []).map((t: Any) => ({
      engine: 'codex',
      profileId: profile.id,
      engineSessionId: t.id,
      title: t.name || t.preview || t.id,
      cwd: t.cwd,
      updatedAt: (t.updatedAt || t.createdAt || 0) * 1000
    }))
  }

  async history(profile: Profile, engineSessionId: string): Promise<ChatItem[]> {
    const rpc = await this.server(profile).get()
    const r = await rpc.request<Any>('thread/read', { threadId: engineSessionId, includeTurns: true })
    const items: ChatItem[] = []
    for (const turn of r?.thread?.turns || []) {
      for (const it of turn.items || []) {
        const item = codexItem(it)
        if (item && !(item.kind === 'reasoning' && !item.text)) items.push(item)
      }
    }
    return items
  }

  async limits(profile: Profile): Promise<RateLimitSnapshot | undefined> {
    const rpc = await this.server(profile).get()
    const r = await rpc.request<Any>('account/rateLimits/read', {})
    return r?.rateLimits ? codexLimitSnapshot(profile.id, r.rateLimits) : undefined
  }

  /** Asks a Codex model to describe images for a model that cannot see them. */
  async describe(profile: Profile, images: Attachment[], prompt: string): Promise<string> {
    const server = this.server(profile)
    const rpc = await server.get()
    const t = await rpc.request<Any>('thread/start', { cwd: os.tmpdir(), ephemeral: true, approvalPolicy: 'never', sandbox: 'read-only' })
    const threadId = t.thread.id as string
    const shot = new OneShot()
    server.sessions.set(threadId, shot)
    try {
      const input = [...saveImages(images).map((p) => ({ type: 'localImage', path: p })), { type: 'text', text: prompt, text_elements: [] }]
      await rpc.request('turn/start', { threadId, input })
      return await Promise.race([shot.done, new Promise<string>((_, rej) => setTimeout(() => rej(new Error('descrierea a expirat')), 180000))])
    } finally {
      server.sessions.delete(threadId)
    }
  }

  /** Codex's own importer for Claude Code settings, skills, MCP servers and sessions. */
  async importDetect(profile: Profile, cwd?: string): Promise<{ items: Any[] }> {
    const rpc = await this.server(profile).get()
    const r = await rpc.request<Any>('externalAgentConfig/detect', { includeHome: true, cwds: cwd ? [cwd] : null })
    return { items: r?.items || [] }
  }

  async importRun(profile: Profile, cwd?: string, itemTypes?: string[]): Promise<void> {
    const server = this.server(profile)
    const rpc = await server.get()
    const { items } = await this.importDetect(profile, cwd)
    const chosen = itemTypes?.length ? items.filter((i) => itemTypes.includes(i.itemType)) : items
    if (!chosen.length) return
    const r = await rpc.request<Any>('externalAgentConfig/import', { migrationItems: chosen })
    if (r?.importId) await server.waitForImport(r.importId, 5 * 60 * 1000)
  }

  async shutdown(): Promise<void> {
    for (const s of this.servers.values()) s.kill()
    this.servers.clear()
  }
}
