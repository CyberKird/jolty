import { execFile } from 'child_process'
import { randomUUID } from 'crypto'
import fs from 'fs'
import type {
  AccountStatus,
  ChatEvent,
  ChatItem,
  EngineKind,
  ExternalSession,
  ModelOption,
  PermissionDecision,
  PermissionMode,
  Profile,
  ProfileInput,
  RateLimitSnapshot,
  SessionMeta,
  StartSessionInput,
  TurnUsage,
  UsageSummary
} from '@shared/types'
import { ClaudeDriver } from './engines/claude'
import { CodexDriver } from './engines/codex'
import type { EngineDriver, EngineHost, EngineSession } from './engines/types'
import { claudeSettingsOverride } from './runtime'
import * as store from './store'

const COLORS = ['#d97757', '#10a37f', '#6c8cff', '#e0a23b', '#c060d0', '#3bb3c3', '#e05a7a', '#8fb339']

const DEFAULT_PROFILES: Profile[] = [
  { id: 'claude-main', name: 'Claude (contul principal)', engine: 'claude', auth: 'subscription', isDefaultDir: true, color: COLORS[0] },
  { id: 'codex-main', name: 'Codex (contul principal)', engine: 'codex', auth: 'subscription', isDefaultDir: true, color: COLORS[1] }
]

export const ENGINE_NAMES: Record<EngineKind, string> = { claude: 'Claude Code', codex: 'Codex' }

function gitState(cwd: string): Promise<string> {
  const run = (args: string[]): Promise<string> =>
    new Promise((resolve) => execFile('git', args, { cwd, timeout: 5000, windowsHide: true }, (err, out) => resolve(err ? '' : String(out))))
  return Promise.all([run(['status', '--short']), run(['diff', '--stat']), run(['log', '--oneline', '-5'])]).then(([status, diff, log]) =>
    [status && `git status --short:\n${status}`, diff && `git diff --stat:\n${diff}`, log && `ultimele commit-uri:\n${log}`].filter(Boolean).join('\n')
  )
}

/** The text a new engine receives when a conversation moves to it. */
export function handoffPrompt(src: SessionMeta, srcProfile: Profile | undefined, items: ChatItem[], git: string): string {
  const parts: string[] = []
  for (const it of items) {
    if (it.kind === 'user') parts.push(`[Utilizator]\n${it.text}`)
    else if (it.kind === 'assistant' && it.text.trim()) parts.push(`[Asistent]\n${it.text}`)
    else if (it.kind === 'tool') parts.push(`[Unealtă] ${it.title} (${it.status})`)
  }
  let transcript = parts.join('\n\n')
  if (transcript.length > 40000) transcript = '...(începutul a fost scurtat)\n' + transcript.slice(-40000)
  return [
    `Preiei o conversație începută în ${ENGINE_NAMES[src.engine]}${srcProfile ? ` (profilul „${srcProfile.name}”)` : ''}, în același proiect: ${src.cwd}`,
    '',
    'Istoricul conversației:',
    '<conversatie>',
    transcript || '(gol)',
    '</conversatie>',
    '',
    'Starea curentă din git:',
    '<git>',
    git || '(nu e un repository git sau nu există modificări)',
    '</git>',
    '',
    'Citește contextul, verifică fișierele dacă e nevoie și continuă de unde a rămas conversația, fără să repeți munca deja făcută. Răspunde întâi pe scurt cu ce ai înțeles că urmează.'
  ].join('\n')
}

export class Jolty {
  readonly claude = new ClaudeDriver()
  readonly codex = new CodexDriver()
  private live = new Map<string, EngineSession>()
  private transcripts = new Map<string, ChatItem[]>()
  private saveTimers = new Map<string, NodeJS.Timeout>()

  constructor(private send: (e: ChatEvent) => void) {
    this.codex.onLimits = (s) => this.recordLimits(s)
    if (store.loadProfiles().length === 0) store.saveProfiles(DEFAULT_PROFILES)
  }

  private driver(engine: EngineKind): EngineDriver {
    return engine === 'claude' ? this.claude : this.codex
  }

  // -------------------------------------------------------------------------
  // Profiles
  // -------------------------------------------------------------------------
  profiles(): Profile[] {
    const secrets = new Set(store.loadProfiles().filter((p) => store.getSecret(p.id)).map((p) => p.id))
    return store.loadProfiles().map((p) => ({ ...p, hasSecret: secrets.has(p.id) }))
  }

  profile(id: string): Profile {
    const p = store.loadProfiles().find((x) => x.id === id)
    if (!p) throw new Error('Profil inexistent')
    return p
  }

  createProfile(input: ProfileInput): Profile {
    const all = store.loadProfiles()
    if (input.engine === 'codex' && input.auth === 'endpoint') throw new Error('Endpoint-urile compatibile sunt disponibile doar pentru motorul Claude Code')
    const profile: Profile = {
      id: randomUUID().slice(0, 8),
      name: input.name.trim() || 'Profil nou',
      engine: input.engine,
      auth: input.auth,
      // Claude API-key/endpoint profiles reuse ~/.claude (settings, skills, MCP); logins need their own folder.
      isDefaultDir: input.engine === 'claude' && input.auth !== 'subscription',
      baseUrl: input.baseUrl?.trim() || undefined,
      models: input.models?.map((m) => m.trim()).filter(Boolean),
      color: COLORS[all.length % COLORS.length]
    }
    store.saveProfiles([...all, profile])
    if (input.secret) store.setSecret(profile.id, input.secret.trim())
    return profile
  }

  updateProfile(id: string, patch: Partial<ProfileInput>): Profile {
    const all = store.loadProfiles()
    const p = all.find((x) => x.id === id)
    if (!p) throw new Error('Profil inexistent')
    if (patch.name !== undefined) p.name = patch.name.trim() || p.name
    if (patch.baseUrl !== undefined) p.baseUrl = patch.baseUrl.trim() || undefined
    if (patch.models !== undefined) p.models = patch.models.map((m) => m.trim()).filter(Boolean)
    if (patch.secret !== undefined) store.setSecret(id, patch.secret.trim() || undefined)
    store.saveProfiles(all)
    if (p.engine === 'codex') this.codex.reset(id)
    return p
  }

  removeProfile(id: string): void {
    if (DEFAULT_PROFILES.some((d) => d.id === id)) throw new Error('Profilurile principale nu se pot șterge')
    const p = this.profile(id)
    for (const s of store.loadSessions().filter((x) => x.profileId === id)) this.removeSession(s.id)
    if (p.engine === 'codex') this.codex.reset(id)
    store.setSecret(id, undefined)
    const dir = store.profileDir(p)
    if (dir) fs.rmSync(dir, { recursive: true, force: true })
    store.saveProfiles(store.loadProfiles().filter((x) => x.id !== id))
  }

  async status(id: string): Promise<AccountStatus> {
    const p = this.profile(id)
    const s = await this.driver(p.engine).status(p)
    if (p.engine === 'claude') {
      const warn = claudeSettingsOverride(p)
      if (warn) return { ...s, error: warn }
    }
    return s
  }

  login(id: string): Promise<AccountStatus> {
    const p = this.profile(id)
    return this.driver(p.engine).login(p)
  }

  logout(id: string): Promise<AccountStatus> {
    const p = this.profile(id)
    return this.driver(p.engine).logout(p)
  }

  models(id: string): Promise<ModelOption[]> {
    const p = this.profile(id)
    return this.driver(p.engine).models(p)
  }

  // -------------------------------------------------------------------------
  // Events from engines
  // -------------------------------------------------------------------------
  private host(): EngineHost {
    return {
      emit: (e) => this.onEngineEvent(e),
      recordUsage: (u) => this.recordUsage(u),
      recordLimits: (s) => this.recordLimits(s)
    }
  }

  private recordUsage(u: TurnUsage): void {
    store.appendUsage(u)
  }

  private recordLimits(s: RateLimitSnapshot): void {
    store.saveLimit(s)
    this.send({ type: 'limits', snapshot: s })
  }

  private transcript(sessionId: string): ChatItem[] {
    let t = this.transcripts.get(sessionId)
    if (!t) {
      t = store.loadTranscript(sessionId)
      this.transcripts.set(sessionId, t)
    }
    return t
  }

  private scheduleSave(sessionId: string): void {
    if (this.saveTimers.has(sessionId)) return
    this.saveTimers.set(
      sessionId,
      setTimeout(() => {
        this.saveTimers.delete(sessionId)
        store.saveTranscript(sessionId, this.transcript(sessionId))
      }, 800)
    )
  }

  private onEngineEvent(e: ChatEvent): void {
    if (e.type === 'item') {
      const t = this.transcript(e.sessionId)
      const i = t.findIndex((x) => x.id === e.item.id)
      if (i >= 0) t[i] = { ...e.item }
      else t.push({ ...e.item })
      this.scheduleSave(e.sessionId)
    } else if (e.type === 'delta') {
      const t = this.transcript(e.sessionId)
      const it = t.find((x) => x.id === e.itemId)
      if (it && (it.kind === 'assistant' || it.kind === 'reasoning')) it.text += e.delta
      else t.push({ kind: e.kind, id: e.itemId, text: e.delta })
      this.scheduleSave(e.sessionId)
    } else if (e.type === 'meta') {
      this.saveMeta(e.meta)
    }
    this.send(e)
  }

  // -------------------------------------------------------------------------
  // Sessions
  // -------------------------------------------------------------------------
  sessions(): SessionMeta[] {
    return store.loadSessions().sort((a, b) => b.updatedAt - a.updatedAt)
  }

  private meta(id: string): SessionMeta {
    const m = store.loadSessions().find((s) => s.id === id)
    if (!m) throw new Error('Conversație inexistentă')
    return m
  }

  private saveMeta(meta: SessionMeta): void {
    const all = store.loadSessions()
    const i = all.findIndex((s) => s.id === meta.id)
    meta.updatedAt = Date.now()
    if (i >= 0) all[i] = { ...all[i], ...meta }
    else all.push(meta)
    store.saveSessions(all)
  }

  async externalSessions(profileId: string, cwd: string): Promise<ExternalSession[]> {
    const p = this.profile(profileId)
    const known = new Set(store.loadSessions().map((s) => s.engineSessionId).filter(Boolean))
    const list = await this.driver(p.engine).externalSessions(p, cwd)
    return list.filter((s) => !known.has(s.engineSessionId))
  }

  async startSession(input: StartSessionInput): Promise<SessionMeta> {
    const p = this.profile(input.profileId)
    const now = Date.now()
    const meta: SessionMeta = {
      id: randomUUID(),
      profileId: p.id,
      engine: p.engine,
      cwd: input.cwd,
      title: input.title || 'Conversație nouă',
      model: input.model,
      permissionMode: input.permissionMode,
      engineSessionId: input.resumeEngineSessionId,
      createdAt: now,
      updatedAt: now
    }
    if (input.resumeEngineSessionId) {
      try {
        const items = await this.driver(p.engine).history(p, input.resumeEngineSessionId, input.cwd)
        this.transcripts.set(meta.id, items)
        store.saveTranscript(meta.id, items)
      } catch (err) {
        this.transcripts.set(meta.id, [{ kind: 'notice', id: randomUUID(), text: `Nu am putut încărca istoricul: ${err instanceof Error ? err.message : err}`, level: 'warn' }])
      }
    }
    this.saveMeta(meta)
    return meta
  }

  history(sessionId: string): ChatItem[] {
    return this.transcript(sessionId)
  }

  private liveSession(sessionId: string): EngineSession {
    let s = this.live.get(sessionId)
    if (!s) {
      const meta = this.meta(sessionId)
      const p = this.profile(meta.profileId)
      s = this.driver(p.engine).createSession(p, meta, this.host())
      this.live.set(sessionId, s)
    }
    return s
  }

  async sendMessage(sessionId: string, text: string): Promise<void> {
    const s = this.liveSession(sessionId)
    if (s.meta.title === 'Conversație nouă') {
      s.meta.title = text.replace(/\s+/g, ' ').trim().slice(0, 60) || s.meta.title
      this.saveMeta(s.meta)
      this.send({ type: 'meta', sessionId, meta: s.meta })
    }
    await s.send(text)
    this.saveMeta(s.meta)
  }

  async interrupt(sessionId: string): Promise<void> {
    await this.live.get(sessionId)?.interrupt()
  }

  async setModel(sessionId: string, model: string): Promise<void> {
    const s = this.live.get(sessionId)
    if (s) await s.setModel(model)
    const meta = s?.meta || this.meta(sessionId)
    meta.model = model
    this.saveMeta(meta)
  }

  async setPermissionMode(sessionId: string, mode: PermissionMode): Promise<void> {
    const s = this.live.get(sessionId)
    if (s) await s.setPermissionMode(mode)
    const meta = s?.meta || this.meta(sessionId)
    meta.permissionMode = mode
    this.saveMeta(meta)
  }

  respond(sessionId: string, requestId: string, decision: PermissionDecision): void {
    this.live.get(sessionId)?.respond(requestId, decision)
  }

  async handoff(sessionId: string, targetProfileId: string): Promise<SessionMeta> {
    const src = this.meta(sessionId)
    const srcProfile = store.loadProfiles().find((p) => p.id === src.profileId)
    const prompt = handoffPrompt(src, srcProfile, this.transcript(sessionId), await gitState(src.cwd))
    const meta = await this.startSession({
      profileId: targetProfileId,
      cwd: src.cwd,
      permissionMode: src.permissionMode,
      title: `${src.title} (continuare)`
    })
    meta.handoffFrom = src.id
    this.saveMeta(meta)
    this.transcript(meta.id).push({ kind: 'notice', id: randomUUID(), text: `Continuare din „${src.title}” (${ENGINE_NAMES[src.engine]}).`, level: 'info' })
    await this.sendMessage(meta.id, prompt)
    return meta
  }

  async removeSession(sessionId: string): Promise<void> {
    await this.live.get(sessionId)?.close()
    this.live.delete(sessionId)
    this.transcripts.delete(sessionId)
    store.removeTranscript(sessionId)
    store.saveSessions(store.loadSessions().filter((s) => s.id !== sessionId))
  }

  // -------------------------------------------------------------------------
  // Usage
  // -------------------------------------------------------------------------
  usageSummary(): UsageSummary[] {
    const now = Date.now()
    const day = 24 * 3600 * 1000
    const usage = store.loadUsage(now - 30 * day)
    const limits = store.loadLimits()
    return store.loadProfiles().map((p) => {
      const mine = usage.filter((u) => u.profileId === p.id)
      const window = (ms: number): { tokens: number; costUsd: number; turns: number } => {
        const list = mine.filter((u) => u.ts >= now - ms)
        return {
          tokens: list.reduce((a, u) => a + u.inputTokens + u.outputTokens + u.cacheReadTokens + u.cacheWriteTokens, 0),
          costUsd: list.reduce((a, u) => a + (u.costUsd || 0), 0),
          turns: list.length
        }
      }
      const byDay = new Map<string, { inputTokens: number; outputTokens: number; costUsd: number }>()
      for (let i = 13; i >= 0; i--) byDay.set(new Date(now - i * day).toISOString().slice(0, 10), { inputTokens: 0, outputTokens: 0, costUsd: 0 })
      const byModel = new Map<string, { tokens: number; costUsd: number }>()
      for (const u of mine) {
        const d = byDay.get(new Date(u.ts).toISOString().slice(0, 10))
        if (d) {
          d.inputTokens += u.inputTokens + u.cacheReadTokens + u.cacheWriteTokens
          d.outputTokens += u.outputTokens
          d.costUsd += u.costUsd || 0
        }
        const m = byModel.get(u.model) || { tokens: 0, costUsd: 0 }
        m.tokens += u.inputTokens + u.outputTokens + u.cacheReadTokens + u.cacheWriteTokens
        m.costUsd += u.costUsd || 0
        byModel.set(u.model, m)
      }
      return {
        profileId: p.id,
        last24h: window(day),
        last7d: window(7 * day),
        last30d: window(30 * day),
        byDay: [...byDay.entries()].map(([d, v]) => ({ day: d, ...v })),
        byModel: [...byModel.entries()].map(([model, v]) => ({ model, ...v })).sort((a, b) => b.tokens - a.tokens),
        limits: limits[p.id]
      }
    })
  }

  async refreshLimits(profileId: string): Promise<RateLimitSnapshot | undefined> {
    const p = this.profile(profileId)
    const snap = await this.driver(p.engine).limits(p)
    if (snap) this.recordLimits(snap)
    return snap
  }

  async shutdown(): Promise<void> {
    for (const s of this.live.values()) await s.close().catch(() => undefined)
    for (const [id, t] of this.saveTimers) {
      clearTimeout(t)
      store.saveTranscript(id, this.transcript(id))
    }
    await this.claude.shutdown()
    await this.codex.shutdown()
  }
}
