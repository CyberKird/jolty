import os from 'os'
import type { AccountStatus, Attachment, ChatItem, ExternalSession, ModelOption, Profile, SessionMeta } from '@shared/types'
import type { EngineDriver, EngineHost, EngineSession } from './types'
import { JsonRpcProcess } from './jsonrpc'
import { collectHistory, HermesEvents, list, object, str, type AcpObject } from './hermes-events'
import { HermesSession, initializeHermes, type HermesLaunch } from './hermes-session'
import { launchHermes } from './hermes-runtime'
import { tr } from '@shared/i18n'

export class HermesDriver implements EngineDriver {
  private sessions = new Set<EngineSession>()
  private probes = new Set<JsonRpcProcess>()
  private catalog?: Promise<ModelOption[]>
  constructor(private launch: HermesLaunch = launchHermes) {}

  private async probe<T>(run: (rpc: JsonRpcProcess, init: AcpObject) => Promise<T>): Promise<T> {
    const rpc = this.launch()
    this.probes.add(rpc)
    rpc.on('request', (r) => rpc.respondError(r.id, tr("Cerere indisponibilă în timpul verificării")))
    try { return await run(rpc, await initializeHermes(rpc)) }
    finally { this.probes.delete(rpc); rpc.kill() }
  }

  createSession(profile: Profile, meta: SessionMeta, host: EngineHost): EngineSession {
    const session = new HermesSession(meta, profile, host, this.launch)
    this.sessions.add(session)
    return session
  }

  async status(profile: Profile): Promise<AccountStatus> {
    try {
      return await this.probe(async (_rpc, init) => {
        const provider = list(init.authMethods).find((a) => a.id !== 'hermes-setup' && a.type !== 'terminal')
        return { profileId: profile.id, loggedIn: Boolean(provider), detail: provider ? tr("Configurația Hermes existentă ({str})", { str: str(provider.id) }) : undefined,
          error: provider ? undefined : tr("Configurează furnizorul în Hermes, apoi verifică din nou.") }
      })
    } catch (e) { return { profileId: profile.id, loggedIn: false, error: e instanceof Error ? e.message : String(e) } }
  }

  async login(profile: Profile): Promise<AccountStatus> { return this.status(profile) }
  async logout(_profile: Profile): Promise<AccountStatus> { throw new Error(tr("Autentificarea se gestionează în Hermes.")) }

  async models(_profile: Profile): Promise<ModelOption[]> {
    this.catalog ??= this.probe(async (rpc) => {
      const result = object(await rpc.request('session/new', { cwd: os.homedir(), mcpServers: [] }))
      const models = object(result.models)
      return list(models.availableModels).filter((m) => typeof m.modelId === 'string').map((m) => ({
        id: m.modelId, label: str(m.name) || m.modelId, description: str(m.description), isDefault: m.modelId === models.currentModelId,
        vision: true
      }))
    }).catch((error) => { this.catalog = undefined; throw error })
    return this.catalog
  }

  async externalSessions(profile: Profile, cwd?: string): Promise<ExternalSession[]> {
    return this.probe(async (rpc) => {
      const sessions: ExternalSession[] = []
      const seen = new Set<string>()
      let cursor: string | undefined
      do {
        const result = object(await rpc.request('session/list', { ...(cwd ? { cwd } : {}), ...(cursor ? { cursor } : {}) }))
        for (const s of list(result.sessions)) {
          if (!str(s.sessionId) || seen.has(s.sessionId)) continue
          seen.add(s.sessionId)
          sessions.push({ engine: 'hermes', profileId: profile.id, engineSessionId: s.sessionId, title: str(s.title) || tr("Conversație Hermes"), cwd: str(s.cwd), updatedAt: Date.parse(str(s.updatedAt)) || 0 })
        }
        const next = str(result.nextCursor)
        if (!next || next === cursor || sessions.length >= 2000) break
        cursor = next
      } while (true)
      return sessions
    })
  }

  async history(_profile: Profile, engineSessionId: string, cwd: string): Promise<ChatItem[]> {
    return this.probe(async (rpc) => {
      const items: ChatItem[] = []
      const events = new HermesEvents(engineSessionId, (e) => collectHistory(items, e))
      rpc.on('notification', (n) => {
        const p = object(n.params)
        if (n.method === 'session/update' && p.sessionId === engineSessionId) events.update(p.update)
      })
      const result = await rpc.request('session/load', { sessionId: engineSessionId, cwd, mcpServers: [] })
      if (!result) throw new Error(tr("Conversația nu mai există în Hermes."))
      return items
    })
  }

  async describe(_profile: Profile, _images: Attachment[], _prompt: string): Promise<string> {
    throw new Error(tr("Alege un profil cu vedere verificată pentru descrierea imaginilor."))
  }
  async limits(): Promise<undefined> { return undefined }

  async shutdown(): Promise<void> {
    await Promise.all([...this.sessions].map((s) => s.close()))
    this.sessions.clear()
    for (const rpc of this.probes) rpc.kill()
    this.probes.clear()
    this.catalog = undefined
  }
}
