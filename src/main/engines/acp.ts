import os from 'os'
import type { AccountStatus, Attachment, ChatItem, ExternalSession, ModelOption, Profile, SessionMeta } from '@shared/types'
import type { EngineDriver, EngineHost, EngineSession } from './types'
import { JsonRpcProcess } from './jsonrpc'
import { collectHistory, AcpEvents, list, object, str, type AcpObject } from './acp-events'
import { AcpSession, initializeAcp, type AcpLaunch } from './acp-session'
import { HERMES, type AcpAgent } from './acp-agent'
import { tr } from '@shared/i18n'

/** Drives an external agent that speaks ACP (Hermes, OpenCode): its own model, key, tools and approvals. */
export class AcpDriver implements EngineDriver {
  private sessions = new Set<EngineSession>()
  private probes = new Set<JsonRpcProcess>()
  private catalog?: Promise<ModelOption[]>
  constructor(private launch: AcpLaunch = HERMES.launch, private agent: AcpAgent = HERMES) {}

  private async probe<T>(run: (rpc: JsonRpcProcess, init: AcpObject) => Promise<T>): Promise<T> {
    await this.agent.prepare?.()
    const rpc = this.launch('ask', false, false)
    this.probes.add(rpc)
    rpc.on('request', (r) => rpc.respondError(r.id, tr("Cerere indisponibilă în timpul verificării")))
    try { return await run(rpc, await initializeAcp(rpc)) }
    finally { this.probes.delete(rpc); rpc.kill() }
  }

  createSession(profile: Profile, meta: SessionMeta, host: EngineHost): EngineSession {
    const session = new AcpSession(meta, profile, host, this.launch, this.agent)
    this.sessions.add(session)
    return session
  }

  async status(profile: Profile): Promise<AccountStatus> {
    try {
      return await this.probe(async (_rpc, init) => {
        const provider = list(init.authMethods).find((a) => a.id !== 'hermes-setup' && a.type !== 'terminal')
        return { profileId: profile.id, loggedIn: Boolean(provider), detail: provider ? tr("Configurația {agent} existentă ({str})", { agent: this.agent.name, str: str(provider.id) }) : undefined,
          error: provider ? undefined : tr("Configurează furnizorul în {agent}, apoi verifică din nou.", { agent: this.agent.name }) }
      })
    } catch (e) { return { profileId: profile.id, loggedIn: false, error: e instanceof Error ? e.message : String(e) } }
  }

  async login(profile: Profile): Promise<AccountStatus> { return this.status(profile) }
  async logout(_profile: Profile): Promise<AccountStatus> { throw new Error(tr("Autentificarea se gestionează în {agent}.", { agent: this.agent.name })) }

  async models(_profile: Profile): Promise<ModelOption[]> {
    this.catalog ??= this.probe(async (rpc) => {
      const result = object(await rpc.request('session/new', { cwd: os.homedir(), mcpServers: [] }))
      return this.agent.enrich ? this.agent.enrich(this.agent.models(result)) : this.agent.models(result)
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
          sessions.push({ engine: this.agent.engine, profileId: profile.id, engineSessionId: s.sessionId, title: str(s.title) || tr("Conversație {agent}", { agent: this.agent.name }), cwd: str(s.cwd), updatedAt: Date.parse(str(s.updatedAt)) || 0 })
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
      const events = new AcpEvents(engineSessionId, (e) => collectHistory(items, e), this.agent.name)
      rpc.on('notification', (n) => {
        const p = object(n.params)
        if (n.method === 'session/update' && p.sessionId === engineSessionId) events.update(p.update)
      })
      const result = await rpc.request('session/load', { sessionId: engineSessionId, cwd, mcpServers: [] })
      if (!result) throw new Error(tr("Conversația nu mai există în {agent}.", { agent: this.agent.name }))
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
