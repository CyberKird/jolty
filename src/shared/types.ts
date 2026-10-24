// Types shared by the main process, the preload bridge and the renderer.
import type { ScheduledTask, TaskInput } from './schedule'
import type { ModelScore } from './scores'

export type EngineKind = 'claude' | 'codex' | 'hermes' | 'opencode'

/** Hermes and OpenCode are external agents Jolty drives over ACP: they keep their own model, key, tools and browser. */
export const isAcp = (engine?: EngineKind): boolean => engine === 'hermes' || engine === 'opencode'

/** Whether the thinking level can be set from Jolty: Hermes keeps it in its own configuration. */
export const hasEffort = (engine?: EngineKind): boolean => engine !== 'hermes'

/** Whether the Jolty browser can be attached: every engine but Hermes, which has browser tools of its own. */
export const hasJoltyBrowser = (engine?: EngineKind): boolean => engine !== 'hermes'
/** Whether the model can be given the PC (screen, mouse, keyboard): the same engines as the browser. */
export const hasJoltyComputer = hasJoltyBrowser

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

/** The modes that mean "do not ask me": nothing in Jolty may show a permission card in them (the safety policy refuses instead). */
export const noQuestions = (mode?: PermissionMode): boolean => mode === 'project' || mode === 'full'

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
  /** set by the model watch: first seen in the last 7 days, or the same name now points to a newer model */
  badge?: 'new' | 'updated'
  /** intelligence and speed, attached by the main process so the table fetched from the repo reaches the picker */
  score?: ModelScore
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
  /** the title was named (by the user or by the auto-namer): the first words of a message no longer replace it */
  titled?: boolean
  model?: string
  effort?: string
  permissionMode: PermissionMode
  /** Jolty in Chrome: the model may drive the user's Chrome through the Playwright extension */
  browser?: boolean
  /** Computer use: the model may see the screen and operate the user's PC (mouse, keyboard, windows) */
  computer?: boolean
  /** temporary chat: lives only in memory, never listed or written to disk, and its engine files are wiped when it ends */
  temporary?: boolean
  /** Claude session id or Codex thread id, once the engine has one */
  engineSessionId?: string
  createdAt: number
  updatedAt: number
  /** set when this session was started as a handoff from another one */
  handoffFrom?: string
  /** moved here but not sent yet: the history goes out with the user's first message */
  handoffPending?: boolean
  /** the lead session that started this one with start_session */
  parentId?: string
  /** a git worktree of the project made for this session: `root` is the repository, `base` the commit it was cut from */
  worktree?: { path: string; branch: string; base: string; root: string }
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
  /** Codex since 0.5.1: inputTokens excludes the cached part; older Codex lines counted it twice */
  netInput?: boolean
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

/** what the PC does (modelled on ShutdownTimer's actions) */
export type PowerAction = 'shutdown' | 'restart' | 'sleep' | 'hibernate' | 'logoff' | 'lock'
/** when: once the work is done, after some minutes, or at a time of day ("HH:mm", today or tomorrow) */
export type PowerWhen = { kind: 'done' } | { kind: 'in'; minutes: number } | { kind: 'at'; time: string }
export interface PowerPlan {
  action: PowerAction
  when: PowerWhen
  /** close programs that would hold a shutdown, restart or log off back */
  force: boolean
}
export interface PowerState {
  armed: boolean
  plan: PowerPlan
  /** when a timed plan fires (ms since the epoch) */
  due?: number
  /** the warning countdown, once it started */
  seconds?: number
  reason?: 'done' | 'usage' | 'error' | 'timer'
}

export type ChatEvent =
  | { type: 'status'; sessionId: string; status: 'idle' | 'running' | 'error'; error?: string }
  /** the PC power plan: armed, and the countdown once it started */
  | ({ type: 'power' } & PowerState)
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
  /** the scheduled tasks changed (added, edited, run): the page reads them again */
  | { type: 'schedules' }

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

export interface ChildModel {
  profileId: string
  model: string
}

export interface AppSettings {
  /** where Jolty keeps profiles, conversations and usage (read-only) */
  dataDir: string
  /** profile that describes images for models that cannot see them */
  visionProfileId?: string
  /** permission mode of sessions a chat starts with start_session; "full" (no permissions) unless set */
  childMode?: PermissionMode
  /** sessions a chat starts get the Jolty browser; on unless false */
  childBrowser?: boolean
  /** a model of its own for started sessions by how hard the job is; unset means the model of the chat that starts them */
  childModels?: { simple?: ChildModel; hard?: ChildModel }
  /** a job's model is chosen from the models Jolty has (by score), where Settings gives none; off unless true */
  childAutoModel?: boolean
  /** hard jobs go to Opus 5.5 at the thinking level below (the lead's own account first); off unless true */
  childOpus?: boolean
  childOpusEffort?: string
  claudePath?: string
  codexPath?: string
  /** no longer used: the model watch keeps what it has seen in model-watch.json */
  seenModels?: string[]
  hermesPath?: string
  opencodePath?: string
  lastCwd?: string
  lastProfileId?: string
  /** the model and thinking level each profile used last: a new chat opens on them, not on the default */
  lastModels?: Record<string, { model: string; effort?: string }>
  /** calmer UI: no entrance animations or panel slides (independent of the Windows setting) */
  reduceMotion?: boolean
  /** Jolty the mascot runs around the interface; on unless false */
  mascot?: boolean
  /** Jolty's soft sounds; on unless false */
  mascotSounds?: boolean
  /** Windows notification when a task finishes or stops with an error while Jolty is not in front; on unless false */
  notifyDone?: boolean
  /** notification when a model waits for you (permission, plan approval) while Jolty is not in front; on unless false */
  notifyAttention?: boolean
  /** the system's sound with those notifications; on unless false */
  notifySound?: boolean
  /** the version What's new was last shown for: it opens once after each update */
  seenVersion?: string
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
  /** how human the mouse and keyboard of computer use look: max (default), normal or fast */
  computerHuman?: 'max' | 'normal' | 'fast'
  /** long text may go in through the clipboard instead of being typed key by key; off unless true */
  computerPaste?: boolean
  /** programs the user allowed for good (exe names, lower case) */
  computerTrusted?: string[]
  /** ask before a model reads or edits .env files, keys and similar; on unless false */
  protectSecretFiles?: boolean
  /** every few messages the model saves what it learned to memory and skills (main/learning.ts); on unless false */
  learningLoop?: boolean
}

export type SiteTrust = 'ask' | 'site' | 'free'
/** jolty = Jolty's own extension (default); auto/pick = Playwright's extension; own = a separate Jolty browser window */
export type BrowserMode = 'jolty' | 'auto' | 'pick' | 'own'

export interface NativeBrowserStatus {
  /** the extension files are in Jolty's folder (the browser still has to load them once) */
  installed: boolean
  connected: boolean
  /** version of the connected extension */
  version?: string
  bundledVersion: string
  dir: string
  port: number
  /** Firefox loads the extension differently (as a temporary add-on, from manifest.json) */
  firefox?: boolean
}

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

export type BrowserApp = 'chrome' | 'vivaldi' | 'edge' | 'brave' | 'opera' | 'firefox'

export type EditAction = 'undo' | 'redo' | 'cut' | 'copy' | 'paste' | 'selectAll'

export interface BrowserInfo {
  /** how Jolty connects to the browser right now (the saved choice, or the default) */
  mode: BrowserMode
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
  /** computer use from the first message (see SessionMeta.computer) */
  computer?: boolean
  temporary?: boolean
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

import type { ExportRequest, ExportResult, ImportDecision, ImportPreview, ImportResult, PackItem, SkillInfo, SkillSource } from './skills'

export interface JoltyApi {
  files: { path(file: File): string }
  profiles: {
    list(): Promise<Profile[]>
    create(input: ProfileInput): Promise<Profile>
    update(id: string, patch: Partial<ProfileInput>): Promise<Profile>
    remove(id: string): Promise<void>
    /** saves the list order (accounts page, live usage, model picker) */
    reorder(ids: string[]): Promise<void>
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
    /** parallel: the model also gets the instruction to split the job into sessions (shared/parallel.ts) */
    send(sessionId: string, text: string, attachments?: Attachment[], parallel?: boolean): Promise<void>
    interrupt(sessionId: string): Promise<void>
    setModel(sessionId: string, model: string): Promise<void>
    setEffort(sessionId: string, effort: string): Promise<void>
    setPermissionMode(sessionId: string, mode: PermissionMode): Promise<void>
    setBrowser(sessionId: string, on: boolean): Promise<void>
    setComputer(sessionId: string, on: boolean): Promise<void>
    /** summarize the conversation so far to free context (Claude /compact, Codex thread compaction) */
    compact(sessionId: string): Promise<void>
    /** compacts and resolves when the engine is done; undefined when the context is too small to be worth it */
    compactAndWait(sessionId: string): Promise<{ before: number; after: number } | undefined>
    /** Claude only: the project's files go back to how they were before that user message */
    rewind(sessionId: string, itemId: string, dryRun?: boolean): Promise<{ files: string[]; insertions: number; deletions: number }>
    respond(sessionId: string, requestId: string, decision: PermissionDecision): Promise<void>
    handoff(sessionId: string, targetProfileId: string, model?: string, effort?: string, fresh?: boolean): Promise<SessionMeta>
    /** a read-only review of the current changes by a model from the other family */
    review(sessionId: string): Promise<void>
    /** the composer text rewritten clearer by a cheap model, in the same language; rejects when it fails */
    improvePrompt(text: string, profileId?: string, model?: string, cwd?: string): Promise<string>
    remove(sessionId: string): Promise<void>
    rename(sessionId: string, title: string): Promise<void>
    onEvent(cb: (e: ChatEvent) => void): () => void
  }
  skills: {
    /** every skill found, with problems and the last known status; fast, no network */
    list(): Promise<SkillInfo[]>
    /** checks sources for newer versions (network); all skills with a source when ids is left out */
    check(ids?: string[]): Promise<SkillInfo[]>
    /** brings a skill up to date from its source; the folder it replaces is kept as a backup */
    update(id: string): Promise<SkillInfo>
    /** tells Jolty where a skill came from, so it can be checked and updated */
    setSource(id: string, source: SkillSource): Promise<SkillInfo>
    reveal(id: string): Promise<void>
  }
  pack: {
    /** what this PC can put in a pack */
    items(): Promise<PackItem[]>
    /** asks for the file with a save dialog; null when the user cancels */
    export(req: ExportRequest): Promise<ExportResult | null>
    /** asks for a pack file (or takes `file`, a path dropped on the window), reads it and compares with what is here; null when cancelled */
    open(file?: string): Promise<ImportPreview | null>
    /** applies the decisions (key to decision; items left out are skipped) */
    apply(previewId: string, decisions: Record<string, ImportDecision>): Promise<ImportResult>
    discard(previewId: string): Promise<void>
    /** puts back what an import replaced */
    undo(importId: string): Promise<void>
  }
  usage: {
    summary(): Promise<UsageSummary[]>
    refreshLimits(profileId: string): Promise<RateLimitSnapshot | undefined>
    /** undefined when the provider has no documented balance endpoint */
    balance(profileId: string): Promise<ProviderBalance | undefined>
  }
  /** dictation in the composer: whisper.cpp on this PC */
  voice: {
    status(): Promise<{ engine: boolean; model: boolean; sizeMB: number }>
    /** fetches the speech model once; progress comes as 'pull' events with tag 'whisper' */
    download(): Promise<void>
    transcribe(wav: Uint8Array, lang?: string): Promise<string>
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
  power: {
    /** arm (with a plan, or the last one) or disarm the power plan */
    arm(on: boolean, plan?: PowerPlan): Promise<void>
    /** stop a running countdown and disarm */
    cancel(): Promise<void>
    state(): Promise<PowerState>
  }
  browser: {
    /** whether an extension token is saved (the value never leaves the main process) */
    hasToken(): Promise<boolean>
    info(): Promise<BrowserInfo>
    setToken(token: string): Promise<void>
    openExtensionPage(): Promise<void>
    /** Jolty's own browser extension: whether it is installed and connected */
    native(): Promise<NativeBrowserStatus>
    /** puts the extension files in place, opens the browser's extensions page and the folder */
    installNative(): Promise<NativeBrowserStatus>
    /** start or stop streaming the Jolty browser page to the Live panel */
    live(on: boolean): Promise<void>
  }
  preview: {
    /** serves the project folder on 127.0.0.1 and returns its origin ('' if it cannot) */
    open(cwd: string): Promise<string>
    /** which of these ports have a dev server listening */
    probe(ports: number[]): Promise<number[]>
    /** the unfinished content of a page being written, served until the real file lands */
    draft(rel: string, html: string | null): Promise<void>
  }
  schedules: {
    list(): Promise<ScheduledTask[]>
    add(input: TaskInput): Promise<ScheduledTask>
    update(id: string, patch: Partial<TaskInput>): Promise<ScheduledTask>
    remove(id: string): Promise<void>
    /** starts a run now and returns its conversation id */
    run(id: string): Promise<string>
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
