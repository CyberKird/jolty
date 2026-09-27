// Types shared by the main process, the preload bridge and the renderer.

export type EngineKind = 'claude' | 'codex'

/**
 * subscription: the official CLI login (claude.ai or ChatGPT) stored in the profile's config dir.
 * apiKey:       the provider's own API key (Anthropic for Claude, OpenAI for Codex).
 * endpoint:     Claude engine only - any Anthropic-compatible endpoint (DeepSeek, OpenRouter, LiteLLM...).
 */
export type AuthKind = 'subscription' | 'apiKey' | 'endpoint'

export interface Profile {
  id: string
  name: string
  engine: EngineKind
  auth: AuthKind
  /** true for the profile that uses the default ~/.claude or ~/.codex folder */
  isDefaultDir: boolean
  /** endpoint profiles: base URL of the Anthropic-compatible API */
  baseUrl?: string
  /** endpoint profiles: model ids offered in the picker (first one is the default) */
  models?: string[]
  hasSecret?: boolean
  color: string
}

export interface ProfileInput {
  name: string
  engine: EngineKind
  auth: AuthKind
  baseUrl?: string
  models?: string[]
  secret?: string
}

export interface AccountStatus {
  profileId: string
  loggedIn: boolean
  email?: string
  plan?: string
  detail?: string
  error?: string
}

/** Jolty's permission modes, mapped onto each engine's own settings. */
export type PermissionMode = 'ask' | 'autoEdit' | 'plan' | 'full'

export interface ModelOption {
  id: string
  label: string
  description?: string
  isDefault?: boolean
}

export interface SessionMeta {
  id: string
  profileId: string
  engine: EngineKind
  cwd: string
  title: string
  model?: string
  permissionMode: PermissionMode
  /** Claude session id or Codex thread id, once the engine has one */
  engineSessionId?: string
  createdAt: number
  updatedAt: number
  /** set when this session was started as a handoff from another one */
  handoffFrom?: string
}

export interface ExternalSession {
  engine: EngineKind
  profileId: string
  engineSessionId: string
  title: string
  cwd?: string
  updatedAt: number
}

export interface FileDiff {
  path: string
  kind: 'add' | 'delete' | 'update'
  /** unified diff text, or synthesized -/+ lines */
  diff: string
}

export type ChatItem =
  | { kind: 'user'; id: string; text: string }
  | { kind: 'assistant'; id: string; text: string }
  | { kind: 'reasoning'; id: string; text: string }
  | {
      kind: 'tool'
      id: string
      name: string
      title: string
      status: 'running' | 'done' | 'error'
      command?: string
      input?: unknown
      output?: string
      diffs?: FileDiff[]
    }
  | { kind: 'notice'; id: string; text: string; level: 'info' | 'warn' | 'error' }

export interface PermissionRequest {
  id: string
  toolName: string
  title: string
  detail?: string
  diffs?: FileDiff[]
  /** markdown shown for plan approvals */
  plan?: string
  canAllowForSession: boolean
}

export type PermissionDecision = 'allow' | 'allowSession' | 'deny'

export interface TurnUsage {
  profileId: string
  engine: EngineKind
  model: string
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  /** Claude only: cost as priced by Claude Code (an API-price estimate on subscriptions) */
  costUsd?: number
  ts: number
}

export interface LimitWindow {
  label: string
  usedPercent: number
  resetsAt?: number
}

export interface RateLimitSnapshot {
  profileId: string
  windows: LimitWindow[]
  note?: string
  updatedAt: number
}

export type ChatEvent =
  | { type: 'status'; sessionId: string; status: 'idle' | 'running' | 'error'; error?: string }
  | { type: 'meta'; sessionId: string; meta: SessionMeta }
  | { type: 'item'; sessionId: string; item: ChatItem }
  | { type: 'delta'; sessionId: string; itemId: string; kind: 'assistant' | 'reasoning'; delta: string }
  | { type: 'permission'; sessionId: string; request: PermissionRequest }
  | { type: 'permissionResolved'; sessionId: string; requestId: string }
  | { type: 'usage'; sessionId: string; usage: TurnUsage }
  | { type: 'limits'; snapshot: RateLimitSnapshot }

export interface UsageDay {
  day: string
  inputTokens: number
  outputTokens: number
  costUsd: number
}

export interface UsageSummary {
  profileId: string
  last24h: { tokens: number; costUsd: number; turns: number }
  last7d: { tokens: number; costUsd: number; turns: number }
  last30d: { tokens: number; costUsd: number; turns: number }
  byDay: UsageDay[]
  byModel: { model: string; tokens: number; costUsd: number }[]
  limits?: RateLimitSnapshot
}

export interface AppSettings {
  brainDir: string
  claudePath?: string
  codexPath?: string
  lastCwd?: string
  lastProfileId?: string
}

export interface StartSessionInput {
  profileId: string
  cwd: string
  model?: string
  permissionMode: PermissionMode
  /** resume an existing Claude session / Codex thread */
  resumeEngineSessionId?: string
  title?: string
}

export interface JoltyApi {
  profiles: {
    list(): Promise<Profile[]>
    create(input: ProfileInput): Promise<Profile>
    update(id: string, patch: Partial<ProfileInput>): Promise<Profile>
    remove(id: string): Promise<void>
    status(id: string): Promise<AccountStatus>
    login(id: string): Promise<AccountStatus>
    logout(id: string): Promise<AccountStatus>
    models(id: string): Promise<ModelOption[]>
  }
  sessions: {
    list(): Promise<SessionMeta[]>
    external(profileId: string, cwd: string): Promise<ExternalSession[]>
    start(input: StartSessionInput): Promise<SessionMeta>
    history(sessionId: string): Promise<ChatItem[]>
    send(sessionId: string, text: string): Promise<void>
    interrupt(sessionId: string): Promise<void>
    setModel(sessionId: string, model: string): Promise<void>
    setPermissionMode(sessionId: string, mode: PermissionMode): Promise<void>
    respond(sessionId: string, requestId: string, decision: PermissionDecision): Promise<void>
    handoff(sessionId: string, targetProfileId: string): Promise<SessionMeta>
    remove(sessionId: string): Promise<void>
    onEvent(cb: (e: ChatEvent) => void): () => void
  }
  usage: {
    summary(): Promise<UsageSummary[]>
    refreshLimits(profileId: string): Promise<RateLimitSnapshot | undefined>
  }
  codexImport: {
    detect(profileId: string, cwd?: string): Promise<{ items: { itemType: string; description: string; cwd: string | null }[] }>
    run(profileId: string, cwd?: string, itemTypes?: string[]): Promise<void>
  }
  app: {
    settings(): Promise<AppSettings>
    saveSettings(patch: Partial<AppSettings>): Promise<AppSettings>
    pickFolder(): Promise<string | undefined>
    openExternal(url: string): Promise<void>
    openPath(path: string): Promise<void>
    version(): Promise<string>
  }
}
