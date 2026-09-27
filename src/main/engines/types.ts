import type {
  AccountStatus,
  Attachment,
  ChatEvent,
  ChatItem,
  ExternalSession,
  ModelOption,
  PermissionDecision,
  PermissionMode,
  Profile,
  RateLimitSnapshot,
  SessionMeta,
  TurnUsage
} from '@shared/types'

/** What an engine session needs from the rest of the app. */
export interface EngineHost {
  emit(e: ChatEvent): void
  recordUsage(u: TurnUsage): void
  recordLimits(s: RateLimitSnapshot): void
}

export interface EngineSession {
  readonly meta: SessionMeta
  send(text: string, images?: Attachment[], clientId?: string): Promise<void>
  /** puts the project's files back as they were before the user message `clientId` */
  rewind(clientId: string, dryRun?: boolean): Promise<{ files: string[]; insertions: number; deletions: number }>
  interrupt(): Promise<void>
  compact(): Promise<void>
  setModel(model: string): Promise<void>
  setEffort(effort: string): Promise<void>
  setPermissionMode(mode: PermissionMode): Promise<void>
  setBrowser(on: boolean): Promise<void>
  respond(requestId: string, decision: PermissionDecision): void
  close(): Promise<void>
}

/** Everything Jolty does with one engine for one profile. */
export interface EngineDriver {
  createSession(profile: Profile, meta: SessionMeta, host: EngineHost): EngineSession
  status(profile: Profile): Promise<AccountStatus>
  login(profile: Profile): Promise<AccountStatus>
  logout(profile: Profile): Promise<AccountStatus>
  models(profile: Profile): Promise<ModelOption[]>
  externalSessions(profile: Profile, cwd?: string): Promise<ExternalSession[]>
  describe(profile: Profile, images: Attachment[], prompt: string): Promise<string>
  history(profile: Profile, engineSessionId: string, cwd: string): Promise<ChatItem[]>
  limits(profile: Profile): Promise<RateLimitSnapshot | undefined>
  shutdown(): Promise<void>
}
