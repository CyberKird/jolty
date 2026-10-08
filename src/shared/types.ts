// Types shared by the main process, the preload bridge and the renderer.

export type EngineKind = 'claude' | 'codex' | 'hermes'

/**
 * subscription: the official CLI login (claude.ai or ChatGPT) stored in the profile's config dir.
 * apiKey:       the provider's own API key (Anthropic for Claude, OpenAI for Codex).
 * endpoint:     Claude engine only - any Anthropic-compatible endpoint (DeepSeek, OpenRouter, LiteLLM...).
 */
export type AuthKind = 'subscription' | 'apiKey' | 'endpoint' | 'existing'

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
  /** endpoint profiles with a cookie-only balance (Xiaomi MiMo): a console Cookie header is stored */
  hasCookie?: boolean
  /** endpoint profiles: whether the model can read images itself */
  vision?: boolean
  /** created from the local-models page (Ollama) */
  local?: boolean
  /** endpoint profiles: the provider's prices in $ per 1M tokens, for a real cost instead of Anthropic's */
  price?: TokenPrice
  color: string
}

export interface TokenPrice {
  input: number
  output: number
  /** cache hits; the input price when not set */
  cacheRead?: number
}

/** What is left on a pay-as-you-go provider account (DeepSeek, Kimi, OpenRouter key limit). */
export interface ProviderBalance {
  profileId: string
  amount?: number
  currency?: string
  note?: string
  updatedAt: number
}

export interface ProfileInput {
  name: string
  engine: EngineKind
  auth: AuthKind
  baseUrl?: string
  models?: string[]
  secret?: string
  cookie?: string
  vision?: boolean
  local?: boolean
  price?: TokenPrice | null
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
/** auto: the engine decides which actions need approval (Claude's classifier, Codex on-request) */
/** `project` is Codex only: no questions, but the sandbox keeps it inside the project folder. `full` is the whole disk. */
export type PermissionMode = 'auto' | 'ask' | 'autoEdit' | 'plan' | 'project' | 'full'

export interface ModelOption {
  id: string
  label: string
  description?: string
  isDefault?: boolean
  /** false when the model cannot read images (Jolty then describes them with the vision profile) */
  vision?: boolean
  /** effort levels the model accepts, in the engine's own names (low, medium, high, xhigh, max) */
  efforts?: string[]
  defaultEffort?: string
}

export interface Attachment {
  id: string
  name: string
  mime: string
  /** base64 without the data: prefix, used for images and clipboard files */
  data?: string
  /** Local path of a file chosen or dropped by the user. */
  path?: string
  size?: number
}

export interface SessionMeta {
  id: string
  profileId: string
  engine: EngineKind
  cwd: string
  title: string
  model?: string
  effort?: string
  permissionMode: PermissionMode
  /** Jolty in Chrome: the model may drive the user's Chrome through the Playwright extension */
  browser?: boolean
  /** Claude session id or Codex thread id, once the engine has one */
  engineSessionId?: string
  createdAt: number
  updatedAt: number
  /** set when this session was started as a handoff from another one */
  handoffFrom?: string
  /** moved here but not sent yet: the history goes out with the user's first message */
  handoffPending?: boolean
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
  | { kind: 'user'; id: string; text: string; images?: { name: string; dataUrl: string }[]; files?: { name: string; mime: string }[] }
  | { kind: 'assistant'; id: string; text: string }
  | { kind: 'reasoning'; id: string; text: string }
  | {
      kind: 'tool'
      id: string
      name: string
      title: string
      status: 'running' | 'done' | 'error'
      exitCode?: number
      command?: string
      input?: unknown
      output?: string
      /** data: URLs of images the tool returned, e.g. a Read of a screenshot */
      images?: string[]
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
  /** replaces "Mereu în sesiune" when the approval covers less than the whole tool (a site) */
  sessionLabel?: string
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
  | { type: 'usage'; usage: TurnUsage }
  /** how full the model's context window is after the last request */
  | { type: 'context'; sessionId: string; used: number; window?: number }
  | { type: 'update'; status: UpdateStatus }
  | { type: 'limits'; snapshot: RateLimitSnapshot }
  /** the agent's own step-by-step plan (Claude's todo list, Codex's plan) */
  | { type: 'plan'; sessionId: string; steps: PlanStep[] }
  /** a file being written right now: content grows as the model generates it */
  | { type: 'draft'; sessionId: string; toolId: string; name: string; path?: string; content: string; done: boolean }
  | { type: 'pull'; tag: string; status: string; completed?: number; total?: number; done?: boolean; error?: string }
  /** the Jolty browser page as the agent sees it (a JPEG frame), or why there is no picture */
  | { type: 'browserLive'; frame?: string; url?: string; title?: string; note?: string }

export interface PlanStep {
  text: string
  status: 'pending' | 'active' | 'done'
}

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
  /** where Jolty keeps profiles, conversations and usage (read-only) */
  dataDir: string
  /** profile that describes images for models that cannot see them */
  visionProfileId?: string
  claudePath?: string
  codexPath?: string
  /** model labels already announced, so a new one gets a single notification */
  seenModels?: string[]
  hermesPath?: string
  lastCwd?: string
  lastProfileId?: string
  /** the model and thinking level each profile used last: a new chat opens on them, not on the default */
  lastModels?: Record<string, { model: string; effort?: string }>
  /** calmer UI: no entrance animations or panel slides (independent of the Windows setting) */
  reduceMotion?: boolean
  /** interface language code (see shared/i18n.ts); unset follows the system */
  language?: string
  /** Chrome profile folder for Jolty in Chrome ("Default", "Profile 1"); the last used one when empty */
  browserProfileDir?: string
  /** which Chromium browser Jolty in Chrome drives; the Windows default when empty */
  browserApp?: BrowserApp
  /** glow, cursor and tab marker while a model drives the browser; on unless false */
  browserOverlay?: boolean
  /** auto: the extension opens a tab of its own; pick: the user chooses one of their open tabs; own: a separate Jolty window with its own profile (no extension) */
  browserMode?: BrowserMode
  /** page actions of a model in the browser: ask every time, once per site (default), or never */
  siteTrust?: SiteTrust
  /** ask before a model reads or edits .env files, keys and similar; on unless false */
  protectSecretFiles?: boolean
}

export type SiteTrust = 'ask' | 'site' | 'free'
export type BrowserMode = 'auto' | 'pick' | 'own'

export interface UpdateStatus {
  /** dev: a development build, nothing to compare; latest: checked, nothing newer */
  state: 'idle' | 'dev' | 'checking' | 'latest' | 'downloading' | 'ready' | 'error'
  current: string
  version?: string
  percent?: number
  error?: string
  checkedAt?: number
}

export interface SlashItem {
  name: string
  description: string
  kind: 'skill' | 'command'
  scope: 'proiect' | 'global'
}

export type BrowserApp = 'chrome' | 'vivaldi' | 'edge' | 'brave'

export type EditAction = 'undo' | 'redo' | 'cut' | 'copy' | 'paste' | 'selectAll'

export interface BrowserInfo {
  installed: { id: BrowserApp; name: string }[]
  /** the browser Jolty will open */
  active?: BrowserApp
  /** the Windows default, when it is a supported Chromium browser */
  defaultApp?: BrowserApp
  /** the Playwright extension is installed in the active browser */
  extension: boolean
}

export interface StartSessionInput {
  profileId: string
  cwd: string
  model?: string
  effort?: string
  permissionMode: PermissionMode
  browser?: boolean
  /** resume an existing Claude session / Codex thread */
  resumeEngineSessionId?: string
  title?: string
}

export interface GpuInfo {
  name: string
  vramGb: number
}

export interface HardwareInfo {
  ramGb: number
  cpu: string
  cores: number
  gpus: GpuInfo[]
  /** memory available for a model on the GPU (0 = CPU only) */
  bestVramGb: number
}

export interface LocalModel {
  tag: string
  sizeGb: number
  vision: boolean
  tools: boolean
  thinking: boolean
}

export interface OllamaStatus {
  installed: boolean
  running: boolean
  version?: string
  models: LocalModel[]
  contextLength?: number
}

export type Fit = 'gpu' | 'cpu' | 'no'

export interface CatalogModel {
  tag: string
  title: string
  vramGb: number
  vision: boolean
  /** how it compares with the Claude models the user knows (an estimate, not a benchmark) */
  equivalent: string
  tier: 1 | 2 | 3 | 4
  notes: string
  /** refusals removed (abliterated); for creative or adult work other models would block */
  unrestricted?: boolean
  fit: Fit
  installed: boolean
}

export interface SystemCheck {
  id: string
  label: string
  ok: boolean
  detail: string
  fixLabel?: string
  optional?: boolean
}

export interface JoltyApi {
  files: { path(file: File): string }
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
    external(profileId: string, cwd?: string): Promise<ExternalSession[]>
    start(input: StartSessionInput): Promise<SessionMeta>
    history(sessionId: string): Promise<ChatItem[]>
    /** every conversation from every login folder, skipping ones already in Jolty */
    importAll(): Promise<{ imported: number; failed: string[] }>
    send(sessionId: string, text: string, attachments?: Attachment[]): Promise<void>
    interrupt(sessionId: string): Promise<void>
    setModel(sessionId: string, model: string): Promise<void>
    setEffort(sessionId: string, effort: string): Promise<void>
    setPermissionMode(sessionId: string, mode: PermissionMode): Promise<void>
    setBrowser(sessionId: string, on: boolean): Promise<void>
    /** summarize the conversation so far to free context (Claude /compact, Codex thread compaction) */
    compact(sessionId: string): Promise<void>
    /** Claude only: the project's files go back to how they were before that user message */
    rewind(sessionId: string, itemId: string, dryRun?: boolean): Promise<{ files: string[]; insertions: number; deletions: number }>
    respond(sessionId: string, requestId: string, decision: PermissionDecision): Promise<void>
    handoff(sessionId: string, targetProfileId: string, model?: string, effort?: string): Promise<SessionMeta>
    /** a read-only review of the current changes by a model from the other family */
    review(sessionId: string): Promise<void>
    remove(sessionId: string): Promise<void>
    onEvent(cb: (e: ChatEvent) => void): () => void
  }
  usage: {
    summary(): Promise<UsageSummary[]>
    refreshLimits(profileId: string): Promise<RateLimitSnapshot | undefined>
    /** undefined when the provider has no documented balance endpoint */
    balance(profileId: string): Promise<ProviderBalance | undefined>
  }
  local: {
    hardware(): Promise<HardwareInfo>
    status(): Promise<OllamaStatus>
    catalog(): Promise<CatalogModel[]>
    pull(tag: string): Promise<void>
    remove(tag: string): Promise<void>
    createProfile(tag: string): Promise<Profile>
    installOllama(): Promise<void>
  }
  system: {
    check(): Promise<SystemCheck[]>
    fix(id: string): Promise<void>
  }
  codexImport: {
    detect(profileId: string, cwd?: string): Promise<{ items: { itemType: string; description: string; cwd: string | null }[] }>
    run(profileId: string, cwd?: string, itemTypes?: string[]): Promise<void>
  }
  updates: {
    status(): Promise<UpdateStatus>
    check(): Promise<UpdateStatus>
    /** quits, installs the downloaded version and starts it again */
    install(): Promise<void>
  }
  composer: {
    slash(cwd?: string): Promise<SlashItem[]>
    files(cwd: string): Promise<string[]>
  }
  browser: {
    /** whether an extension token is saved (the value never leaves the main process) */
    hasToken(): Promise<boolean>
    info(): Promise<BrowserInfo>
    setToken(token: string): Promise<void>
    openExtensionPage(): Promise<void>
    /** start or stop streaming the Jolty browser page to the Live panel */
    live(on: boolean): Promise<void>
  }
  app: {
    settings(): Promise<AppSettings>
    saveSettings(patch: Partial<AppSettings>): Promise<AppSettings>
    pickFolder(): Promise<string | undefined>
    openExternal(url: string): Promise<void>
    openPath(path: string): Promise<void>
    revealPath(path: string): Promise<void>
    /** right-click menu actions: the menu itself is drawn by the renderer in Jolty's theme */
    edit(action: EditAction): Promise<void>
    copyText(text: string): Promise<void>
    /** a data: URL image from the chat */
    image(kind: 'copy' | 'save' | 'open', image: string, name: string): Promise<void>
    /** a file or folder like a double click, except programs and scripts, which are only shown in Explorer */
    openLocal(path: string): Promise<void>
    /** an http(s) link in the browser Jolty uses for its own browsing */
    openLink(url: string): Promise<void>
    version(): Promise<string>
  }
}
