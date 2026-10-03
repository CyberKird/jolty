import { execFile } from 'child_process'
import { randomUUID } from 'crypto'
import fs from 'fs'
import os from 'os'
import type {
  AccountStatus,
  Attachment,
  ChatEvent,
  ChatItem,
  EngineKind,
  ExternalSession,
  ModelOption,
  PermissionDecision,
  PermissionMode,
  Profile,
  ProfileInput,
  ProviderBalance,
  RateLimitSnapshot,
  SessionMeta,
  StartSessionInput,
  TurnUsage,
  UsageSummary
} from '@shared/types'
import { activeBrowser, BROWSER_EXTENSION_URL, BROWSER_TOKEN_KEY, browserMode, browsers } from './browser'
import { ClaudeDriver } from './engines/claude'
import { CodexDriver } from './engines/codex'
import { HermesDriver } from './engines/hermes'
import { hermesExecutable } from './engines/hermes-runtime'
import { hermesMode } from './engines/hermes-session'
import type { EngineDriver, EngineHost, EngineSession } from './engines/types'
import { DESCRIBE_PROMPT } from './engines/claude'
import { endpointCost, fetchBalance } from './balance'
import * as local from './local'
import { claudeSettingsOverride } from './runtime'
import { prepareAttachments, filePrompt } from './attachments'
import * as store from './store'

const COLORS = ['#d97757', '#10a37f', '#6c8cff', '#e0a23b', '#c060d0', '#3bb3c3', '#e05a7a', '#8fb339']

const DEFAULT_PROFILES: Profile[] = [
  { id: 'claude-main', name: 'Claude (contul principal)', engine: 'claude', auth: 'subscription', isDefaultDir: true, color: COLORS[0] },
  { id: 'codex-main', name: 'Codex (contul principal)', engine: 'codex', auth: 'subscription', isDefaultDir: true, color: COLORS[1] }
]

export const ENGINE_NAMES: Record<EngineKind, string> = { claude: 'Claude Code', codex: 'Codex', hermes: 'Hermes' }

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
  readonly hermes = new HermesDriver()
  private live = new Map<string, EngineSession>()
  private transcripts = new Map<string, ChatItem[]>()
  private saveTimers = new Map<string, NodeJS.Timeout>()

  constructor(private send: (e: ChatEvent) => void) {
    this.codex.onLimits = (s) => this.recordLimits(s)
    if (store.loadProfiles().length === 0) store.saveProfiles(DEFAULT_PROFILES)
    const profiles = store.loadProfiles()
    if (!profiles.some((p) => p.engine === 'hermes') && hermesExecutable()) {
      store.saveProfiles([...profiles, { id: 'hermes-main', name: 'Hermes', engine: 'hermes', auth: 'existing', isDefaultDir: true, color: COLORS[2] }])
    }
  }

  private driver(engine: EngineKind): EngineDriver {
    if (engine === 'hermes') return this.hermes
    if (engine === 'claude') return this.claude
    if (engine === 'codex') return this.codex
    throw new Error('Motor necunoscut')
  }

  // -------------------------------------------------------------------------
  // Profiles
  // -------------------------------------------------------------------------
  profiles(): Profile[] {
    const all = store.loadProfiles()
    const secrets = new Set(all.filter((p) => store.getSecret(p.id)).map((p) => p.id))
    const cookies = new Set(all.filter((p) => store.getSecret(p.id + ':cookie')).map((p) => p.id))
    return all.map((p) => ({ ...p, hasSecret: secrets.has(p.id), hasCookie: cookies.has(p.id) }))
  }

  profile(id: string): Profile {
    const p = store.loadProfiles().find((x) => x.id === id)
    if (!p) throw new Error('Profil inexistent')
    return p
  }

  createProfile(input: ProfileInput): Profile {
    const all = store.loadProfiles()
    if (!['claude', 'codex', 'hermes'].includes(input.engine)) throw new Error('Motor necunoscut')
    if ((input.engine === 'hermes') !== (input.auth === 'existing')) throw new Error('Hermes folosește configurația existentă.')
    if (input.engine === 'hermes' && all.some((p) => p.engine === 'hermes')) throw new Error('Profilul Hermes există deja.')
    if (input.engine === 'hermes' && (input.secret || input.baseUrl || input.models?.length)) throw new Error('Configurează modelul și cheia în Hermes.')
    if (input.engine === 'codex' && input.auth === 'endpoint') throw new Error('Endpoint-urile compatibile sunt disponibile doar pentru motorul Claude Code')
    const profile: Profile = {
      id: randomUUID().slice(0, 8),
      name: input.name.trim() || 'Profil nou',
      engine: input.engine,
      auth: input.auth,
      // Claude API-key/endpoint profiles reuse ~/.claude (settings, skills, MCP); logins need their own folder.
      isDefaultDir: input.engine === 'hermes' || (input.engine === 'claude' && input.auth !== 'subscription'),
      baseUrl: input.baseUrl?.trim() || undefined,
      models: input.models?.map((m) => m.trim()).filter(Boolean),
      vision: input.vision,
      local: input.local,
      price: input.price || undefined,
      color: COLORS[all.length % COLORS.length]
    }
    store.saveProfiles([...all, profile])
    if (input.secret) store.setSecret(profile.id, input.secret.trim())
    if (input.cookie) store.setSecret(profile.id + ':cookie', input.cookie.trim())
    return profile
  }

  updateProfile(id: string, patch: Partial<ProfileInput>): Profile {
    const all = store.loadProfiles()
    const p = all.find((x) => x.id === id)
    if (!p) throw new Error('Profil inexistent')
    if (p.engine === 'hermes' && (patch.secret !== undefined || patch.baseUrl !== undefined || patch.models !== undefined)) throw new Error('Configurează modelul și cheia în Hermes.')
    if (patch.name !== undefined) p.name = patch.name.trim() || p.name
    if (patch.baseUrl !== undefined) p.baseUrl = patch.baseUrl.trim() || undefined
    if (patch.models !== undefined) p.models = patch.models.map((m) => m.trim()).filter(Boolean)
    if (patch.vision !== undefined) p.vision = patch.vision
    if (patch.price !== undefined) p.price = patch.price || undefined
    if (patch.secret !== undefined) store.setSecret(id, patch.secret.trim() || undefined)
    if (patch.cookie !== undefined) store.setSecret(id + ':cookie', patch.cookie.trim() || undefined)
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
    store.setSecret(id + ':cookie', undefined)
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
    const p = store.loadProfiles().find((x) => x.id === u.profileId)
    if (p?.auth === 'endpoint') u = { ...u, costUsd: endpointCost(u, p) }
    store.appendUsage(u)
    this.send({ type: 'usage', usage: u })
  }

  private recordLimits(s: RateLimitSnapshot): RateLimitSnapshot {
    const merged = store.saveLimit(s)
    this.send({ type: 'limits', snapshot: merged })
    return merged
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

  async externalSessions(profileId: string, cwd?: string): Promise<ExternalSession[]> {
    const p = this.profile(profileId)
    const known = new Set(store.loadSessions().map((s) => s.engineSessionId).filter(Boolean))
    const list = await this.driver(p.engine).externalSessions(p, cwd)
    return list.filter((s) => !known.has(s.engineSessionId))
  }

  async startSession(input: StartSessionInput): Promise<SessionMeta> {
    const p = this.profile(input.profileId)
    if (p.engine === 'hermes') {
      hermesMode(input.permissionMode)
      if (input.browser) throw new Error('Conectarea la browserul Jolty nu este disponibilă pentru Hermes.')
    }
    const now = Date.now()
    const meta: SessionMeta = {
      id: randomUUID(),
      profileId: p.id,
      engine: p.engine,
      cwd: input.cwd,
      title: input.title || 'Conversație nouă',
      model: input.model,
      effort: p.engine === 'hermes' ? undefined : input.effort,
      permissionMode: input.permissionMode,
      browser: input.browser || undefined,
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
    if (!input.resumeEngineSessionId && input.model) this.remember(p.id, { model: input.model, effort: input.effort || '' })
    return meta
  }

  /** The transcript; a bulk-imported session reads its history from the engine the first time it opens. */
  history(sessionId: string): ChatItem[] {
    return this.transcript(sessionId)
  }

  async loadHistory(sessionId: string): Promise<ChatItem[]> {
    const t = this.transcript(sessionId)
    const meta = store.loadSessions().find((s) => s.id === sessionId)
    if (t.length || !meta?.engineSessionId || this.live.has(sessionId)) return t
    try {
      const p = this.profile(meta.profileId)
      const items = await this.driver(p.engine).history(p, meta.engineSessionId, meta.cwd)
      this.transcripts.set(sessionId, items)
      store.saveTranscript(sessionId, items)
      return items
    } catch (err) {
      return [{ kind: 'notice', id: randomUUID(), text: `Nu am putut încărca istoricul: ${err instanceof Error ? err.message : err}`, level: 'warn' }]
    }
  }

  /**
   * Brings every Claude Code and Codex conversation on this PC into Jolty, once per login folder,
   * skipping the ones already here. Histories load lazily when a conversation is opened.
   */
  async importAll(): Promise<{ imported: number; failed: string[] }> {
    const metas = store.loadSessions()
    const known = new Set(metas.map((s) => s.engineSessionId).filter(Boolean))
    const dirs = new Set<string>()
    const failed: string[] = []
    let imported = 0
    // subscription profiles first: API-key and endpoint profiles share the main folder, their sessions belong there
    const profiles = [...store.loadProfiles()].sort((a, b) => Number(b.auth === 'subscription') - Number(a.auth === 'subscription'))
    for (const p of profiles) {
      const dir = `${p.engine}:${store.profileDir(p) || 'main'}`
      if (dirs.has(dir)) continue
      dirs.add(dir)
      let list: ExternalSession[]
      try {
        list = await this.driver(p.engine).externalSessions(p)
      } catch {
        failed.push(p.name)
        continue
      }
      for (const s of list) {
        if (known.has(s.engineSessionId)) continue
        known.add(s.engineSessionId)
        metas.push({
          id: randomUUID(),
          profileId: p.id,
          engine: p.engine,
          cwd: s.cwd || os.homedir(),
          title: s.title.replace(/\s+/g, ' ').trim().slice(0, 60) || 'Sesiune importată',
          permissionMode: 'autoEdit',
          engineSessionId: s.engineSessionId,
          createdAt: s.updatedAt,
          updatedAt: s.updatedAt
        })
        imported++
      }
    }
    store.saveSessions(metas)
    return { imported, failed }
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

  /** Whether the session's current model can read images itself. */
  private async canSee(meta: SessionMeta): Promise<boolean> {
    const p = this.profile(meta.profileId)
    if (p.engine === 'claude') return p.auth === 'endpoint' ? Boolean(p.vision) : true
    if (p.engine === 'hermes') return true
    try {
      const models = await this.codex.models(p)
      const m = models.find((x) => x.id === meta.model) || models.find((x) => x.isDefault)
      return m?.vision !== false
    } catch {
      return true
    }
  }

  /** The profile that describes images for models without vision. */
  visionProfile(): Profile | undefined {
    const all = store.loadProfiles()
    const chosen = all.find((p) => p.id === store.loadSettings().visionProfileId)
    if (chosen && chosen.engine !== 'hermes') return chosen
    return (
      all.find((p) => p.engine === 'claude' && p.auth !== 'endpoint') ||
      all.find((p) => p.engine === 'codex') ||
      all.find((p) => p.engine === 'claude' && p.vision)
    )
  }

  private async describeImages(sessionId: string, images: Attachment[]): Promise<string> {
    const vp = this.visionProfile()
    if (!vp) throw new Error('Niciun profil nu poate citi imagini: adaugă un profil Claude sau un model local cu vision.')
    this.onEngineEvent({ type: 'item', sessionId, item: { kind: 'notice', id: randomUUID(), text: `Modelul curent nu vede imagini: le descrie „${vp.name}”...`, level: 'info' } })
    const text = await this.driver(vp.engine).describe(vp, images, DESCRIBE_PROMPT)
    return images.length === 1
      ? `[Imagine atașată: ${images[0].name}. Modelul tău nu o poate vedea, așa că iată descrierea ei făcută de ${vp.name}:]\n${text}\n[Sfârșitul descrierii]`
      : `[${images.length} imagini atașate (${images.map((i) => i.name).join(', ')}). Descrierea lor, făcută de ${vp.name}:]\n${text}\n[Sfârșitul descrierii]`
  }

  async sendMessage(sessionId: string, text: string, attachments: Attachment[] = [], display?: string): Promise<void> {
    const s = this.liveSession(sessionId)
    const prepared = prepareAttachments(attachments)
    if (s.meta.title === 'Conversație nouă') {
      s.meta.title = text.replace(/\s+/g, ' ').trim().slice(0, 60) || attachments[0]?.name || s.meta.title
      this.saveMeta(s.meta)
      this.send({ type: 'meta', sessionId, meta: s.meta })
    }
    const userId = randomUUID()
    this.onEngineEvent({
      type: 'item',
      sessionId,
      item: { kind: 'user', id: userId, text: display ?? text,
        images: prepared.images.map((a) => ({ name: a.name, dataUrl: `data:${a.mime};base64,${a.data}` })),
        files: prepared.files.map((f) => ({ name: f.name, mime: f.mime })) }
    })
    let prompt = [text, filePrompt(prepared.files)].filter(Boolean).join('\n\n')
    let images = prepared.images
    if (images.length && !(await this.canSee(s.meta))) {
      try {
        prompt = `${await this.describeImages(sessionId, images)}\n\n${prompt}`
        images = []
      } catch (err) {
        this.onEngineEvent({ type: 'item', sessionId, item: { kind: 'notice', id: randomUUID(), text: `Nu am putut descrie imaginea: ${err instanceof Error ? err.message : err}`, level: 'error' } })
        return
      }
    }
    await s.send(prompt || 'Uită-te la imaginea atașată.', images, userId)
    this.saveMeta(s.meta)
  }

  // -------------------------------------------------------------------------
  // Local models (Ollama)
  // -------------------------------------------------------------------------
  async pullLocal(tag: string): Promise<void> {
    await local.pull(tag, (e) => this.send(e))
  }

  async createLocalProfile(tag: string): Promise<Profile> {
    const info = await local.modelInfo(tag)
    if (!info.tools) throw new Error(`${tag} nu știe să folosească unelte, deci nu poate lucra ca agent (citit și editat fișiere).`)
    const big = await local.ensureLargeContext(tag)
    return this.createProfile({
      name: `Local · ${tag.replace(/:latest$/, '')}`,
      engine: 'claude',
      auth: 'endpoint',
      baseUrl: local.OLLAMA_URL,
      models: [big],
      secret: 'ollama',
      vision: info.vision,
      local: true
    })
  }

  /** dryRun: only says what would change, so the UI offers undo only where there is something to undo */
  async rewind(sessionId: string, itemId: string, dryRun = false): Promise<{ files: string[]; insertions: number; deletions: number }> {
    const s = this.liveSession(sessionId)
    let target = itemId
    if (s.meta.engine === 'claude' && s.meta.engineSessionId) {
      // Claude Code names messages itself: the Nth prompt of Jolty's transcript is its Nth prompt
      const mine = this.transcript(sessionId).filter((i) => i.kind === 'user')
      const n = mine.findIndex((i) => i.id === itemId)
      const ids = await this.claude.promptIds(this.profile(s.meta.profileId), s.meta.engineSessionId, s.meta.cwd)
      const offset = ids.length - mine.length
      target = ids[n + Math.max(0, offset)] || itemId
    }
    const r = await s.rewind(target, dryRun)
    if (dryRun) return r
    const what = r.files.length ? `${r.files.length} ${r.files.length === 1 ? 'fișier' : 'fișiere'} (+${r.insertions} -${r.deletions})` : 'nimic de schimbat'
    this.onEngineEvent({ type: 'item', sessionId, item: { kind: 'notice', id: randomUUID(), text: `Fișierele au revenit la starea de dinainte de acel mesaj: ${what}.`, level: 'info' } })
    return r
  }

  async compact(sessionId: string): Promise<void> {
    await this.liveSession(sessionId).compact()
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
    this.remember(meta.profileId, { model })
  }

  async setEffort(sessionId: string, effort: string): Promise<void> {
    if (effort && this.meta(sessionId).engine === 'hermes') throw new Error('Hermes folosește efortul din configurația proprie.')
    const s = this.live.get(sessionId)
    if (s) await s.setEffort(effort)
    const meta = s?.meta || this.meta(sessionId)
    meta.effort = effort || undefined
    this.saveMeta(meta)
    this.remember(meta.profileId, { effort })
  }

  /** What a profile used last, for the next new chat. */
  private remember(profileId: string, patch: { model?: string; effort?: string }): void {
    const all = store.loadSettings().lastModels || {}
    const prev = all[profileId]
    all[profileId] = { model: patch.model ?? prev?.model ?? '', effort: patch.effort ?? prev?.effort }
    store.saveSettings({ lastModels: all })
  }

  async setPermissionMode(sessionId: string, mode: PermissionMode): Promise<void> {
    if (this.meta(sessionId).engine === 'hermes') hermesMode(mode)
    const s = this.live.get(sessionId)
    if (s) await s.setPermissionMode(mode)
    const meta = s?.meta || this.meta(sessionId)
    meta.permissionMode = mode
    this.saveMeta(meta)
  }

  async setBrowser(sessionId: string, on: boolean): Promise<void> {
    if (on && this.meta(sessionId).engine === 'hermes') throw new Error('Conectarea la browserul Jolty nu este disponibilă pentru Hermes.')
    if (on && browserMode() === 'own' && !browsers().active) throw new Error('Nu găsesc niciun browser Chromium (Chrome, Vivaldi, Edge sau Brave) pentru fereastra Jolty.')
    // the separate Jolty window needs no extension at all
    if (on && browserMode() !== 'own' && (browserMode() === 'pick' || !store.getSecret(BROWSER_TOKEN_KEY))) {
      // first use: no extension yet means the page of the right browser, not a 30 s wait that ends in a timeout
      const info = browsers()
      if (!info.extension) {
        const b = activeBrowser()
        if (b) b.open(BROWSER_EXTENSION_URL)
        throw new Error(`Instalează extensia Playwright în ${b?.name || 'browser'} (am deschis pagina), apoi apasă din nou Browser.`)
      }
    }
    const s = this.live.get(sessionId)
    if (s) await s.setBrowser(on)
    const meta = s?.meta || this.meta(sessionId)
    meta.browser = on || undefined
    this.saveMeta(meta)
  }

  /** New token or browser settings: chats with the browser on swap their server now, no off/on needed. */
  async reconnectBrowser(): Promise<void> {
    for (const s of this.live.values()) {
      if (!s.meta.browser) continue
      await s.setBrowser(false)
      await s.setBrowser(true)
    }
  }

  respond(sessionId: string, requestId: string, decision: PermissionDecision): void {
    this.live.get(sessionId)?.respond(requestId, decision)
  }

  async handoff(sessionId: string, targetProfileId: string, model?: string, effort?: string): Promise<SessionMeta> {
    const src = this.meta(sessionId)
    const srcProfile = store.loadProfiles().find((p) => p.id === src.profileId)
    const targetHermes = this.profile(targetProfileId).engine === 'hermes'
    const prompt = handoffPrompt(src, srcProfile, this.transcript(sessionId), await gitState(src.cwd))
    const meta = await this.startSession({
      profileId: targetProfileId,
      cwd: src.cwd,
      permissionMode: targetHermes && (src.permissionMode === 'plan' || src.permissionMode === 'auto') ? 'ask' : src.permissionMode,
      browser: targetHermes ? undefined : src.browser,
      model,
      // effort names differ between models; a picked model starts on its own default
      effort: model ? effort : src.effort,
      title: `${src.title} (continuare)`
    })
    meta.handoffFrom = src.id
    this.saveMeta(meta)
    // Carry the visible conversation over so the text persists when switching models.
    const carried = this.transcript(sessionId).map((x) => ({ ...x }))
    this.transcripts.set(meta.id, carried)
    store.saveTranscript(meta.id, carried)
    const display = `Preia conversația „${src.title}” din ${ENGINE_NAMES[src.engine]}${srcProfile ? ` (${srcProfile.name})` : ''} și continuă de unde a rămas.`
    await this.sendMessage(meta.id, prompt, [], display)
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

  async balance(profileId: string): Promise<ProviderBalance | undefined> {
    const p = this.profile(profileId)
    const secret = store.getSecret(p.id)
    const cookie = store.getSecret(p.id + ':cookie')
    if (!secret && !cookie) return undefined
    return fetchBalance(p, secret, cookie)
  }

  async refreshLimits(profileId: string): Promise<RateLimitSnapshot | undefined> {
    const p = this.profile(profileId)
    const snap = await this.driver(p.engine).limits(p)
    return snap ? this.recordLimits(snap) : undefined
  }

  async shutdown(): Promise<void> {
    for (const s of this.live.values()) await s.close().catch(() => undefined)
    for (const [id, t] of this.saveTimers) {
      clearTimeout(t)
      store.saveTranscript(id, this.transcript(id))
    }
    await this.claude.shutdown()
    await this.codex.shutdown()
    await this.hermes.shutdown()
  }
}
