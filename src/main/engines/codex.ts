import os from 'os'
import { shell } from 'electron'
import type {
  AccountStatus,
  Attachment,
  ChatItem,
  ExternalSession,
  LimitWindow,
  ModelOption,
  Profile,
  RateLimitSnapshot,
  SessionMeta
} from '@shared/types'
import { CODEX_PRIVATE_ARGS, codexEnv, codexExecutable, prepareProfileDir } from '../runtime'
import { getSecret } from '../store'
import { JsonRpcProcess, type RpcNotification, type RpcRequest } from './jsonrpc'
import type { EngineDriver, EngineHost, EngineSession } from './types'
import { codexItem, saveImages } from './codex-items'
import { CodexSession, type ThreadListener } from './codex-session'

export { codexItem } from './codex-items'

// Loose views of the app-server payloads (the full types come from `codex app-server generate-ts`).
/* eslint-disable @typescript-eslint/no-explicit-any */
type Any = any

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
    const rpc = new JsonRpcProcess(exe, ['app-server', ...CODEX_PRIVATE_ARGS], codexEnv(this.profile, exe))
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
