import { execFile, spawn } from 'child_process'
import { randomUUID } from 'crypto'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { Notification, shell } from 'electron'
import type {
  CanUseTool,
  EffortLevel,
  Options,
  PermissionMode as SdkPermissionMode,
  PermissionResult,
  PermissionUpdate,
  Query,
  SDKMessage,
  SDKUserMessage
} from '@anthropic-ai/claude-agent-sdk'
import type {
  AccountStatus,
  Attachment,
  ChatItem,
  ExternalSession,
  LimitWindow,
  ModelOption,
  PermissionDecision,
  PermissionMode,
  Profile,
  RateLimitSnapshot,
  SessionMeta
} from '@shared/types'
import { claudeEnv, claudeExecutable, prepareProfileDir } from '../runtime'
import { BROWSER_ACT_TOOLS, BROWSER_BLOCKED_TOOLS, browserPrompt, BROWSER_READ_TOOLS, BROWSER_SERVER, browserServer, pageHost } from '../browser'
import { modelInfo } from '../local'
import { noThinkingUrl } from '../thinking-proxy'
import { endpointEfforts, endpointThinking } from './thinking'
import { editDiff, partialJsonString } from './partial-json'
import { TaskBoard } from './tasks'
import { getSecret, loadSettings, profileDir, saveSettings } from '../store'
import { claudeToolDiffs, claudeToolTitle, toolResultImages, toolResultText, truncate } from './format'
import { PLAN_RULES, WRITING_RULES } from './prompt'
import type { EngineDriver, EngineHost, EngineSession } from './types'
import { tr } from '@shared/i18n'

type SdkModule = typeof import('@anthropic-ai/claude-agent-sdk')
let sdkModule: Promise<SdkModule> | undefined
const loadSdk = (): Promise<SdkModule> => (sdkModule ??= import('@anthropic-ai/claude-agent-sdk'))

/** Files that hold secrets: a model gets asked about them even in the modes that otherwise read and edit freely. */
const SECRET_FILES = ['**/.env', '**/.env.*', '**/secrets.json', '**/.credentials.json', '**/*.pem', '**/*.key', '**/id_rsa*', '**/id_ed25519*', '~/.ssh/**']
const SECRET_FILE_RULES = SECRET_FILES.flatMap((f) => [`Read(${f})`, `Edit(${f})`])

/** Even with every question switched off, these never run: they cannot be undone by a checkpoint. */
const NEVER_RUN = ['Bash(format:*)', 'Bash(diskpart:*)', 'Bash(reg delete:*)', 'Bash(git push --force:*)', 'Bash(git push -f:*)', 'Bash(rm -rf /:*)', 'Bash(rm -rf ~:*)', 'Bash(rm -rf C:*)', 'Bash(rm -rf $HOME:*)']

const MODE_MAP: Record<PermissionMode, SdkPermissionMode> = {
  auto: 'auto',
  ask: 'default',
  autoEdit: 'acceptEdits',
  plan: 'plan',
  project: 'acceptEdits',
  full: 'bypassPermissions'
}

const LIMIT_LABELS: Record<string, string> = {
  five_hour: '5 ore',
  seven_day: '7 zile',
  seven_day_opus: '7 zile (Opus)',
  seven_day_sonnet: '7 zile (Sonnet)',
  seven_day_oauth_apps: '7 zile (aplicații)',
  seven_day_overage_included: '7 zile (cu extra)',
  overage: 'Extra'
}

const APPEND_PROMPT = `You are running inside Jolty, a desktop app. The AskUserQuestion tool is unavailable: ask questions in plain text instead. ${WRITING_RULES} ${PLAN_RULES}`

function percent(u: number | null | undefined): number | undefined {
  if (u == null || !Number.isFinite(u) || u < 0) return undefined
  return u <= 1 ? u * 100 : u
}

function usagePercent(u: number | null | undefined): number | undefined {
  if (u == null || !Number.isFinite(u) || u < 0 || u > 100) return undefined
  return u
}

function toMs(t: number | string | null | undefined): number | undefined {
  if (t == null) return undefined
  if (typeof t === 'string') {
    const n = Date.parse(t)
    return Number.isNaN(n) ? undefined : n
  }
  return t < 1e12 ? t * 1000 : t
}

function userMessage(text: string, images: Attachment[], uuid?: string): SDKUserMessage {
  // the uuid ties Jolty's chat item to Claude Code's file checkpoint for that message
  const id = uuid ? { uuid: uuid as SDKUserMessage['uuid'] } : {}
  if (!images.length) return { type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null, ...id }
  const content = [
    ...images.map((img) => ({ type: 'image' as const, source: { type: 'base64' as const, media_type: img.mime as 'image/png', data: img.data! } })),
    { type: 'text' as const, text }
  ]
  return { type: 'user', message: { role: 'user', content }, parent_tool_use_id: null, ...id }
}

const DRAFT_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit'])

export const DESCRIBE_PROMPT =
  'Another AI model that cannot see images will work from your description instead of the image. ' +
  'Describe the image completely and precisely: transcribe ALL visible text exactly (code, error messages, numbers, labels), ' +
  'describe the layout and UI elements, colors, charts or diagrams and how the parts relate. Do not guess beyond what is visible. ' +
  'Answer with the description only.'

/** Async iterable fed by the UI: every pushed message becomes a new user turn. */
class InputQueue implements AsyncIterable<SDKUserMessage> {
  private items: SDKUserMessage[] = []
  private waiters: ((r: IteratorResult<SDKUserMessage>) => void)[] = []
  private closed = false

  push(text: string, images: Attachment[] = [], uuid?: string): void {
    const msg = userMessage(text, images, uuid)
    const w = this.waiters.shift()
    if (w) w({ value: msg, done: false })
    else this.items.push(msg)
  }

  close(): void {
    this.closed = true
    for (const w of this.waiters.splice(0)) w({ value: undefined, done: true })
  }

  [Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    return {
      next: () => {
        const item = this.items.shift()
        if (item) return Promise.resolve({ value: item, done: false })
        if (this.closed) return Promise.resolve({ value: undefined, done: true })
        return new Promise((resolve) => this.waiters.push(resolve))
      }
    }
  }
}

function baseOptions(profile: Profile, cwd: string, model?: string): Options {
  const exe = claudeExecutable()
  return {
    cwd,
    env: claudeEnv(profile, model),
    ...(exe ? { pathToClaudeCodeExecutable: exe } : {})
  }
}

/** Runs a short-lived Claude Code process to ask it something (models, usage) without a prompt. */
async function withProbe<T>(profile: Profile, fn: (q: Query) => Promise<T>, timeoutMs = 45000): Promise<T> {
  const sdk = await loadSdk()
  prepareProfileDir(profile)
  const input = new InputQueue()
  const q = sdk.query({ prompt: input, options: { ...baseOptions(profile, os.homedir()), settingSources: [] } })
  // drain messages so the process never blocks on a full pipe
  void (async () => {
    try {
      for await (const _ of q) void _
    } catch {
      // probe errors surface through fn()
    }
  })()
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      fn(q),
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(tr("Claude Code nu a răspuns la timp"))), timeoutMs)
      })
    ])
  } finally {
    if (timer) clearTimeout(timer)
    input.close()
    q.close()
  }
}

/** The usage endpoint is rate limited (429 + retry-after), so remember when we may ask again. */
const usageCooldown = new Map<string, number>()
/**
 * Reads plan limits with this profile's OAuth token. The SDK usage probe can report no
 * limits even while this endpoint has data, and probing first may consume its rate limit.
 */
async function oauthUsage(profile: Profile): Promise<{ limits?: Record<string, unknown>; plan?: string; cooldownMs?: number }> {
  const until = usageCooldown.get(profile.id)
  if (until && Date.now() < until) return { cooldownMs: until - Date.now() }
  try {
    const dir = profileDir(profile) ?? path.join(os.homedir(), '.claude')
    const creds = JSON.parse(fs.readFileSync(path.join(dir, '.credentials.json'), 'utf8')).claudeAiOauth as
      | { accessToken?: string; expiresAt?: number; subscriptionType?: string }
      | undefined
    // an expired token gets refreshed by Claude Code on its next run; nothing to read until then
    if (!creds?.accessToken || (creds.expiresAt && Date.now() > creds.expiresAt - 60000)) return {}
    const res = await fetch('https://api.anthropic.com/api/oauth/usage', {
      headers: { authorization: `Bearer ${creds.accessToken}`, 'anthropic-beta': 'oauth-2025-04-20' },
      signal: AbortSignal.timeout(15000)
    })
    if (res.status === 429) {
      const after = (Number(res.headers.get('retry-after')) || 300) * 1000
      usageCooldown.set(profile.id, Date.now() + after)
      return { cooldownMs: after }
    }
    if (!res.ok) return {}
    usageCooldown.delete(profile.id)
    const limits = await res.json()
    if (!limits || typeof limits !== 'object' || Array.isArray(limits)) return {}
    return { limits: limits as Record<string, unknown>, plan: creds.subscriptionType }
  } catch {
    return {}
  }
}

// ---------------------------------------------------------------------------
// Mapping Claude Code messages to Jolty chat items
// ---------------------------------------------------------------------------
type Block = { type: string; [k: string]: unknown }

function contentBlocks(message: unknown): Block[] {
  const content = (message as { content?: unknown })?.content
  if (typeof content === 'string') return [{ type: 'text', text: content }]
  return Array.isArray(content) ? (content as Block[]) : []
}

function toolItem(block: Block, status: 'running' | 'done' | 'error'): ChatItem {
  const name = String(block.name)
  const input = (block.input ?? {}) as Record<string, unknown>
  return {
    kind: 'tool',
    id: String(block.id),
    name,
    title: claudeToolTitle(name, input),
    status,
    command: name === 'Bash' ? String(input.command ?? '') : undefined,
    input,
    diffs: claudeToolDiffs(name, input)
  }
}

/** Converts a stored Claude Code transcript into chat items. */
export function claudeHistoryItems(messages: { type: string; uuid: string; message: unknown; parent_tool_use_id?: string | null }[]): ChatItem[] {
  const items: ChatItem[] = []
  const tools = new Map<string, Extract<ChatItem, { kind: 'tool' }>>()
  for (const m of messages) {
    if (m.parent_tool_use_id) continue
    const blocks = contentBlocks(m.message)
    blocks.forEach((b, i) => {
      if (m.type === 'user') {
        if (b.type === 'text' && String(b.text ?? '').trim()) items.push({ kind: 'user', id: `${m.uuid}:${i}`, text: String(b.text) })
        if (b.type === 'tool_result') {
          const t = tools.get(String(b.tool_use_id))
          if (t) {
            t.status = b.is_error ? 'error' : 'done'
            t.output = truncate(toolResultText(b.content))
            t.images = toolResultImages(b.content)
          }
        }
      } else if (m.type === 'assistant') {
        if (b.type === 'text' && String(b.text ?? '').trim()) items.push({ kind: 'assistant', id: `${m.uuid}:${i}`, text: String(b.text) })
        if (b.type === 'tool_use') {
          const t = toolItem(b, 'done') as Extract<ChatItem, { kind: 'tool' }>
          tools.set(t.id, t)
          items.push(t)
        }
      }
    })
  }
  return items
}

// ---------------------------------------------------------------------------
// Live session
// ---------------------------------------------------------------------------
interface Pending {
  resolve: (r: PermissionResult) => void
  input: Record<string, unknown>
  suggestions?: PermissionUpdate[]
  /** set for page actions: "always" then means this site, not the whole tool */
  site?: string
}

class ClaudeSession implements EngineSession {
  private q?: Query
  private starting?: Promise<void>
  private input = new InputQueue()
  private pending = new Map<string, Pending>()
  /** the site the browser tab is on, and the sites where the user already allowed page actions in this chat */
  private browserSite?: string
  private trustedSites = new Set<string>()
  private currentMsgId = ''
  private blockN = 0
  private streamed = new Map<number, string>()
  private drafts = new Map<number, { id: string; name: string; json: string; last: number }>()
  private tools = new Map<string, Extract<ChatItem, { kind: 'tool' }>>()
  private board = new TaskBoard()
  private contextWindow?: number
  private contextUsed = 0
  private lastCost = 0
  /** a turn is under way: a message sent now lands mid-turn */
  private turn = false
  private limitWindows = new Map<string, LimitWindow>()

  constructor(
    readonly meta: SessionMeta,
    private profile: Profile,
    private host: EngineHost
  ) {}

  private async ensureStarted(): Promise<void> {
    if (this.q) return
    if (this.starting) return this.starting
    this.starting = this.startQuery()
    try {
      await this.starting
    } finally {
      this.starting = undefined
    }
  }

  private async startQuery(): Promise<void> {
    const sdk = await loadSdk()
    prepareProfileDir(this.profile)
    const canUseTool: CanUseTool = (toolName, input, opts) => this.ask(toolName, input, opts)
    const options: Options = {
      ...baseOptions(this.profile, this.meta.cwd, this.meta.model),
      model: this.meta.model || undefined,
      // third-party endpoints only get what their provider documents (see thinking.ts)
      ...(this.profile.auth === 'endpoint' ? endpointThinking(this.meta.effort) : this.meta.effort ? { effort: this.meta.effort as EffortLevel } : {}),
      // newer models omit thinking text by default; a summary lets the reasoning row open onto something
      ...(this.profile.auth !== 'endpoint' ? { extraArgs: { 'thinking-display': 'summarized' } } : {}),
      permissionMode: this.sdkMode(this.meta.permissionMode),
      // Claude Code refuses this flag when run as root, so only pass it when it is actually needed.
      allowDangerouslySkipPermissions: this.meta.permissionMode === 'full',
      resume: this.meta.engineSessionId,
      includePartialMessages: true,
      // a backup before every edit, so any message can be undone with rewind()
      enableFileCheckpointing: true,
      settingSources: ['user', 'project', 'local'],
      systemPrompt: { type: 'preset', preset: 'claude_code', append: this.meta.browser ? `${APPEND_PROMPT} ${browserPrompt()}` : APPEND_PROMPT },
      ...(this.meta.browser ? { mcpServers: { [BROWSER_SERVER]: { type: 'stdio' as const, ...browserServer() } } } : {}),
      disallowedTools: ['AskUserQuestion', ...BROWSER_BLOCKED_TOOLS.map((t) => `mcp__${BROWSER_SERVER}__${t}`)],
      settings: {
        permissions: {
          ...(loadSettings().protectSecretFiles !== false ? { ask: SECRET_FILE_RULES } : {}),
          ...(this.meta.permissionMode === 'full' ? { deny: NEVER_RUN } : {})
        }
      },
      canUseTool,
      stderr: (d) => {
        if (process.env.JOLTY_DEBUG) console.error('[claude]', d)
      }
    }
    // thinking "off" on an endpoint needs a field Claude Code does not send: go through the local relay
    if (this.profile.auth === 'endpoint' && this.meta.effort === 'off' && this.profile.baseUrl) {
      options.env = { ...options.env, ANTHROPIC_BASE_URL: await noThinkingUrl(this.profile.baseUrl) }
    }
    this.input = new InputQueue()
    this.q = sdk.query({ prompt: this.input, options })
    void this.pump(this.q)
  }

  private async pump(q: Query): Promise<void> {
    try {
      for await (const m of q) this.onMessage(m)
      this.host.emit({ type: 'status', sessionId: this.meta.id, status: 'idle' })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      this.notice(message, 'error')
      this.host.emit({ type: 'status', sessionId: this.meta.id, status: 'error', error: message })
    } finally {
      if (this.q === q) this.q = undefined
      this.turn = false
    }
  }

  private notice(text: string, level: 'info' | 'warn' | 'error'): void {
    this.host.emit({ type: 'item', sessionId: this.meta.id, item: { kind: 'notice', id: randomUUID(), text, level } })
  }

  private onMessage(m: SDKMessage): void {
    const sid = this.meta.id
    switch (m.type) {
      case 'system': {
        if (m.subtype === 'init') {
          this.meta.engineSessionId = m.session_id
          // keep the id the picker offered (an alias like "sonnet"); the resolved name matches no picker row and shows as the first model
          this.meta.model = this.meta.model || m.model
          this.host.emit({ type: 'meta', sessionId: sid, meta: this.meta })
        } else if (m.subtype === 'api_retry') {
          this.notice(tr("Serverul nu răspunde, reîncerc..."), 'warn')
        }
        return
      }
      case 'stream_event': {
        if (m.parent_tool_use_id) return
        const ev = m.event as { type: string; index?: number; message?: { id: string }; content_block?: Block; delta?: Record<string, unknown> }
        if (ev.type === 'message_start' && ev.message) {
          this.currentMsgId = ev.message.id
          this.blockN = 0
          this.streamed.clear()
          this.drafts.clear()
        } else if (ev.type === 'content_block_start' && ev.content_block?.type === 'tool_use' && ev.index !== undefined) {
          const name = String(ev.content_block.name)
          if (DRAFT_TOOLS.has(name)) this.drafts.set(ev.index, { id: String(ev.content_block.id), name, json: '', last: 0 })
        } else if (ev.type === 'content_block_delta' && ev.delta?.type === 'input_json_delta' && ev.index !== undefined) {
          const d = this.drafts.get(ev.index)
          if (!d) return
          d.json += String(ev.delta.partial_json ?? '')
          if (Date.now() - d.last > 60) {
            d.last = Date.now()
            this.emitDraft(d, false)
          }
        } else if (ev.type === 'content_block_stop' && ev.index !== undefined && this.drafts.has(ev.index)) {
          this.emitDraft(this.drafts.get(ev.index)!, true)
          this.drafts.delete(ev.index)
        } else if (ev.type === 'content_block_start' && ev.content_block && ev.index !== undefined) {
          const kind = ev.content_block.type === 'text' ? 'assistant' : ev.content_block.type === 'thinking' ? 'reasoning' : undefined
          if (!kind) return
          const id = `${this.currentMsgId}:${ev.index}`
          this.streamed.set(ev.index, id)
          this.host.emit({ type: 'item', sessionId: sid, item: { kind, id, text: '' } })
        } else if (ev.type === 'content_block_delta' && ev.delta && ev.index !== undefined) {
          const id = this.streamed.get(ev.index)
          if (!id) return
          if (ev.delta.type === 'text_delta') this.host.emit({ type: 'delta', sessionId: sid, itemId: id, kind: 'assistant', delta: String(ev.delta.text ?? '') })
          if (ev.delta.type === 'thinking_delta') this.host.emit({ type: 'delta', sessionId: sid, itemId: id, kind: 'reasoning', delta: String(ev.delta.thinking ?? '') })
        }
        return
      }
      case 'assistant': {
        if (m.parent_tool_use_id) return
        {
          // each request's input is the whole conversation so far: that is what fills the context
          const u = m.message.usage
          if (u) this.contextUsed = (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.output_tokens ?? 0)
        }
        const msgId = this.currentMsgId || (m.message as { id?: string }).id || m.uuid
        // each streamed assistant frame carries one block: its position is a running count, not contentBlocks' local index
        const inStream = Boolean(this.currentMsgId)
        const blocks = contentBlocks(m.message)
        blocks.forEach((b, i) => {
          const id = `${msgId}:${inStream ? this.blockN + i : i}`
          if (b.type === 'text') this.host.emit({ type: 'item', sessionId: sid, item: { kind: 'assistant', id, text: String(b.text ?? '') } })
          else if (b.type === 'thinking' && String(b.thinking ?? '').trim()) this.host.emit({ type: 'item', sessionId: sid, item: { kind: 'reasoning', id, text: String(b.thinking) } })
          else if (b.type === 'tool_use') {
            const t = toolItem(b, 'running') as Extract<ChatItem, { kind: 'tool' }>
            this.tools.set(t.id, t)
            this.host.emit({ type: 'item', sessionId: sid, item: t })
            const todos = (b.input as { todos?: unknown[] })?.todos
            if (t.name === 'TodoWrite' && Array.isArray(todos)) {
              this.board.todos(todos)
              this.host.emit({ type: 'plan', sessionId: sid, steps: this.board.steps() })
            } else if (t.name === 'TaskUpdate') {
              this.board.updated(b.input)
              this.host.emit({ type: 'plan', sessionId: sid, steps: this.board.steps() })
            }
          }
        })
        if (inStream) this.blockN += blocks.length
        if (m.error) this.notice(tr("Eroare Claude: {error}", { error: m.error }), 'error')
        return
      }
      case 'user': {
        if (m.parent_tool_use_id) return
        for (const b of contentBlocks(m.message)) {
          if (b.type !== 'tool_result') continue
          const t = this.tools.get(String(b.tool_use_id))
          if (!t) continue
          t.status = b.is_error ? 'error' : 'done'
          t.output = truncate(toolResultText(b.content))
          t.images = toolResultImages(b.content)
          if (t.name.startsWith(`mcp__${BROWSER_SERVER}__`) && /Page URL:/.test(t.output)) this.browserSite = pageHost(t.output)
          this.host.emit({ type: 'item', sessionId: sid, item: t })
          // the new task list tools: ids only exist once TaskCreate has answered
          if (!b.is_error && (t.name === 'TaskCreate' || t.name === 'TaskList')) {
            if (t.name === 'TaskCreate') this.board.created(t.input, m.tool_use_result, toolResultText(b.content))
            else this.board.listed(m.tool_use_result)
            this.host.emit({ type: 'plan', sessionId: sid, steps: this.board.steps() })
          }
          this.tools.delete(t.id)
        }
        return
      }
      case 'result': {
        this.currentMsgId = ''
        this.blockN = 0
        {
          const windows = Object.values((m as { modelUsage?: Record<string, { contextWindow?: number }> }).modelUsage || {}).map((x) => x.contextWindow || 0)
          if (windows.length) this.contextWindow = Math.max(...windows) || this.contextWindow
          if (this.contextUsed) this.host.emit({ type: 'context', sessionId: sid, used: this.contextUsed, window: this.contextWindow })
        }
        const u = m.usage as { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number }
        // total_cost_usd grows over the life of the process; keep only this turn's share.
        const cost = m.total_cost_usd >= this.lastCost ? m.total_cost_usd - this.lastCost : m.total_cost_usd
        this.lastCost = m.total_cost_usd
        this.host.recordUsage({
          profileId: this.profile.id,
          engine: 'claude',
          model: this.meta.model || 'necunoscut',
          inputTokens: u?.input_tokens ?? 0,
          outputTokens: u?.output_tokens ?? 0,
          cacheReadTokens: u?.cache_read_input_tokens ?? 0,
          cacheWriteTokens: u?.cache_creation_input_tokens ?? 0,
          costUsd: cost,
          ts: Date.now()
        })
        if (m.subtype !== 'success') this.notice(`Claude s-a oprit: ${m.subtype}`, 'warn')
        this.turn = false
        this.host.emit({ type: 'status', sessionId: sid, status: 'idle' })
        return
      }
      case 'rate_limit_event': {
        const info = m.rate_limit_info
        const key = info.rateLimitType || 'five_hour'
        const used = percent(info.utilization)
        if (used !== undefined) this.limitWindows.set(key, { label: LIMIT_LABELS[key] || key, usedPercent: used, resetsAt: toMs(info.resetsAt) })
        this.host.recordLimits({
          profileId: this.profile.id,
          windows: [...this.limitWindows.values()],
          note: info.status === 'rejected' ? tr("Limita abonamentului a fost atinsă") : undefined,
          updatedAt: Date.now()
        })
        if (info.status === 'rejected') this.notice(tr("Ai atins limita abonamentului Claude pentru acest profil."), 'error')
        return
      }
      default:
        return
    }
  }

  private emitDraft(d: { id: string; name: string; json: string }, done: boolean): void {
    const path = partialJsonString(d.json, 'file_path') || partialJsonString(d.json, 'notebook_path')
    const content =
      d.name === 'Write' ? partialJsonString(d.json, 'content') : d.name === 'NotebookEdit' ? partialJsonString(d.json, 'new_source') : editDiff(d.json)
    this.host.emit({ type: 'draft', sessionId: this.meta.id, toolId: d.id, name: d.name, path, content: content ?? '', done })
  }

  private ask(toolName: string, input: Record<string, unknown>, opts: Parameters<CanUseTool>[2]): Promise<PermissionResult> {
    // reading pages is not an action on the user's behalf: only Manual mode asks for it
    const [, server, tool] = /^mcp__(.+?)__(.+)$/.exec(toolName) || []
    if (server === BROWSER_SERVER && BROWSER_READ_TOOLS.includes(tool) && this.meta.permissionMode !== 'ask') {
      return Promise.resolve({ behavior: 'allow', updatedInput: input })
    }
    const acts = server === BROWSER_SERVER && BROWSER_ACT_TOOLS.includes(tool) && this.meta.permissionMode !== 'ask'
    const trust = loadSettings().siteTrust || 'site'
    if (acts && trust === 'free') return Promise.resolve({ behavior: 'allow', updatedInput: input })
    const site = acts && trust === 'site' ? this.browserSite : undefined
    if (site && this.trustedSites.has(site)) return Promise.resolve({ behavior: 'allow', updatedInput: input })
    const id = randomUUID()
    const detail = toolName === 'Bash' ? String(input.command ?? '') : toolName === 'ExitPlanMode' ? undefined : truncate(JSON.stringify(input, null, 2), 4000)
    this.host.emit({
      type: 'permission',
      sessionId: this.meta.id,
      request: {
        id,
        toolName,
        title: opts.title || claudeToolTitle(toolName, input),
        detail,
        diffs: claudeToolDiffs(toolName, input),
        plan: toolName === 'ExitPlanMode' ? String(input.plan ?? '') : undefined,
        canAllowForSession: Boolean(site || opts.suggestions?.length),
        sessionLabel: site ? tr("Mereu pe {site}", { site }) : undefined
      }
    })
    return new Promise((resolve) => {
      this.pending.set(id, { resolve, input, suggestions: opts.suggestions, site })
      opts.signal.addEventListener('abort', () => {
        if (!this.pending.delete(id)) return
        this.host.emit({ type: 'permissionResolved', sessionId: this.meta.id, requestId: id })
        resolve({ behavior: 'deny', message: tr("Cererea a fost anulată.") })
      })
    })
  }

  respond(requestId: string, decision: PermissionDecision): void {
    const p = this.pending.get(requestId)
    if (!p) return
    this.pending.delete(requestId)
    this.host.emit({ type: 'permissionResolved', sessionId: this.meta.id, requestId })
    if (decision === 'deny') p.resolve({ behavior: 'deny', message: tr("Utilizatorul a refuzat această acțiune.") })
    else if (decision === 'allowSession' && p.site) {
      this.trustedSites.add(p.site)
      p.resolve({ behavior: 'allow', updatedInput: p.input })
    } else if (decision === 'allowSession') p.resolve({ behavior: 'allow', updatedInput: p.input, updatedPermissions: p.suggestions })
    else p.resolve({ behavior: 'allow', updatedInput: p.input })
  }

  async send(text: string, images: Attachment[] = [], clientId?: string): Promise<void> {
    await this.ensureStarted()
    const mid = this.turn
    this.turn = true
    this.host.emit({ type: 'status', sessionId: this.meta.id, status: 'running' })
    this.input.push(text, images, clientId)
    // sent during a turn: a long command would hold the message until it ends, so it moves to the
    // background (Ctrl+B in Claude Code) and keeps running while the model reads the message
    if (mid && (await this.q?.backgroundTasks().catch(() => false))) {
      this.notice(tr("Comanda care rula continuă în fundal; mesajul tău intră acum."), 'info')
    }
  }

  /** `cliId`: Claude Code's own id for the message (it does not keep the one Jolty sends) */
  async rewind(cliId: string, dryRun = false): Promise<{ files: string[]; insertions: number; deletions: number }> {
    await this.ensureStarted()
    // only a dry run reports what changes, so the real rewind returns the preview's numbers
    const preview = await this.q!.rewindFiles(cliId, { dryRun: true })
    if (!preview.canRewind) throw new Error(preview.error || tr("Nu există o copie a fișierelor pentru acest mesaj (de exemplu, a fost trimis înainte de actualizarea Jolty)."))
    if (!dryRun) {
      const r = await this.q!.rewindFiles(cliId)
      if (!r.canRewind) throw new Error(r.error || tr("Claude Code nu a putut readuce fișierele."))
    }
    return { files: preview.filesChanged || [], insertions: preview.insertions || 0, deletions: preview.deletions || 0 }
  }

  async interrupt(): Promise<void> {
    await this.q?.interrupt()
  }

  async compact(): Promise<void> {
    await this.send('/compact')
  }

  async setModel(model: string): Promise<void> {
    this.meta.model = model
    if (this.profile.auth === 'endpoint') {
      // the endpoint's model mapping lives in environment variables: restart on next message
      await this.close()
      return
    }
    await this.q?.setModel(model)
  }

  async setEffort(effort: string): Promise<void> {
    this.meta.effort = effort || undefined
    // null clears the override and goes back to the model's own default ("Auto")
    // an endpoint's level is a start option: the process restarts on the next message
    if (this.profile.auth === 'endpoint') await this.close()
    else await this.q?.applyFlagSettings({ effortLevel: (effort || null) as EffortLevel | null })
  }

  async setPermissionMode(mode: PermissionMode): Promise<void> {
    const needsRestart = mode === 'full' && this.meta.permissionMode !== 'full'
    this.meta.permissionMode = mode
    // bypassPermissions must be allowed when the process starts: restart it on the next message
    if (needsRestart) await this.close()
    else await this.q?.setPermissionMode(this.sdkMode(mode))
  }

  async setBrowser(on: boolean): Promise<void> {
    if (Boolean(this.meta.browser) === on) return
    this.meta.browser = on
    // the running process swaps its dynamic MCP servers; the prompt addition comes with the next start
    await this.q?.setMcpServers(on ? { [BROWSER_SERVER]: { type: 'stdio', ...browserServer() } } : {})
  }

  private sdkMode(mode: PermissionMode): SdkPermissionMode {
    // the auto classifier runs on Anthropic models; other endpoints get "accept edits" instead
    return mode === 'auto' && this.profile.auth === 'endpoint' ? 'acceptEdits' : MODE_MAP[mode]
  }

  async close(): Promise<void> {
    for (const [id, p] of this.pending) {
      p.resolve({ behavior: 'deny', message: tr("Sesiunea a fost închisă.") })
      this.pending.delete(id)
    }
    this.input.close()
    this.q?.close()
    this.q = undefined
  }
}

// ---------------------------------------------------------------------------
// Driver: accounts, models, sessions on disk
// ---------------------------------------------------------------------------
function runCli(profile: Profile, args: string[], timeoutMs = 30000): Promise<{ code: number; stdout: string; stderr: string }> {
  const exe = claudeExecutable()
  if (!exe) return Promise.reject(new Error(tr("Nu găsesc Claude Code (binarul inclus lipsește)")))
  prepareProfileDir(profile)
  return new Promise((resolve) => {
    execFile(exe, args, { env: claudeEnv(profile), timeout: timeoutMs, windowsHide: true }, (err, stdout, stderr) => {
      const code = err && typeof (err as { code?: unknown }).code === 'number' ? Number((err as { code: number }).code) : err ? 1 : 0
      resolve({ code, stdout: String(stdout), stderr: String(stderr) })
    })
  })
}

/** Opens a console window running an official login command, so the user signs in with Anthropic directly. */
function openLoginWindow(exe: string, args: string[], env: Record<string, string>): void {
  if (process.platform === 'win32') {
    const cmdline = `start "Jolty - autentificare" "${exe}" ${args.join(' ')}`
    spawn('cmd.exe', ['/d', '/s', '/c', `"${cmdline}"`], { env, detached: true, stdio: 'ignore', windowsVerbatimArguments: true }).unref()
    return
  }
  if (process.platform === 'darwin') {
    const script = path.join(os.tmpdir(), `jolty-login-${Date.now()}.command`)
    const exports = Object.entries(env)
      .filter(([k]) => k.startsWith('CLAUDE_') || k === 'PATH' || k === 'HOME')
      .map(([k, v]) => `export ${k}='${v.replace(/'/g, `'\\''`)}'`)
      .join('\n')
    fs.writeFileSync(script, `#!/bin/sh\n${exports}\n'${exe}' ${args.join(' ')}\n`, { mode: 0o755 })
    void shell.openPath(script)
    return
  }
  // Linux: no reliable terminal; run it and open the sign-in URL it prints.
  const child = spawn(exe, args, { env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
  const onData = (buf: Buffer): void => {
    const url = buf.toString().match(/https:\/\/\S+/)?.[0]
    if (url) void shell.openExternal(url)
  }
  child.stdout?.on('data', onData)
  child.stderr?.on('data', onData)
  child.unref()
}

/** One Windows notification per model label never seen before; the first run only records the list. */
function announceNewModels(labels: string[]): void {
  const seen = loadSettings().seenModels
  if (!seen) {
    saveSettings({ seenModels: labels })
    return
  }
  const fresh = labels.filter((l) => !seen.includes(l))
  if (!fresh.length) return
  saveSettings({ seenModels: [...seen, ...fresh] })
  if (Notification.isSupported() && !process.env.JOLTY_TEST) {
    new Notification({ title: tr("Model nou în Jolty: {join}", { join: fresh.join(', ') }), body: tr("Îl găsești în lista de modele din chat.") }).show()
  }
}

export class ClaudeDriver implements EngineDriver {
  private modelCache = new Map<string, { at: number; models: ModelOption[] }>()

  createSession(profile: Profile, meta: SessionMeta, host: EngineHost): EngineSession {
    return new ClaudeSession(meta, profile, host)
  }

  async status(profile: Profile): Promise<AccountStatus> {
    if (profile.auth !== 'subscription') {
      const has = Boolean(getSecret(profile.id))
      return { profileId: profile.id, loggedIn: has, detail: profile.auth === 'endpoint' ? profile.baseUrl : tr("Cheie API Anthropic"), error: has ? undefined : tr("Lipsește cheia") }
    }
    try {
      const r = await runCli(profile, ['auth', 'status', '--json'])
      const s = JSON.parse(r.stdout || '{}') as Record<string, unknown>
      return {
        profileId: profile.id,
        loggedIn: Boolean(s.loggedIn),
        email: (s.email as string) || (s.emailAddress as string) || undefined,
        plan: (s.subscriptionType as string) || undefined,
        detail: (s.orgName as string) || (s.organization as string) || undefined
      }
    } catch (err) {
      return { profileId: profile.id, loggedIn: false, error: err instanceof Error ? err.message : String(err) }
    }
  }

  async login(profile: Profile): Promise<AccountStatus> {
    if (profile.auth !== 'subscription') return this.status(profile)
    const exe = claudeExecutable()
    if (!exe) throw new Error(tr("Nu găsesc Claude Code (binarul inclus lipsește)"))
    prepareProfileDir(profile)
    openLoginWindow(exe, ['auth', 'login', '--claudeai'], claudeEnv(profile))
    return this.status(profile)
  }

  async logout(profile: Profile): Promise<AccountStatus> {
    if (profile.auth === 'subscription') await runCli(profile, ['auth', 'logout'])
    return this.status(profile)
  }

  async models(profile: Profile): Promise<ModelOption[]> {
    if (profile.auth === 'endpoint') {
      return Promise.all(
        (profile.models || []).map(async (id, i) => {
          // a local model has thinking only when Ollama lists the capability
          const thinks = profile.local ? await modelInfo(id).then((m) => m.thinking, () => false) : true
          return { id, label: id, isDefault: i === 0, ...endpointEfforts(profile, thinks) }
        })
      )
    }
    const cached = this.modelCache.get(profile.id)
    if (cached && Date.now() - cached.at < 10 * 60 * 1000) return cached.models
    const list = await withProbe(profile, (q) => q.supportedModels())
    // aliases ("sonnet") come labelled "Sonnet"; the version the alias points to today is in the description
    const versioned = (m: (typeof list)[number]): string | undefined => /^([A-Z][a-z]+ \d+(?:\.\d+)?) ·/.exec(m.description || '')?.[1]
    const mapped = list.map((m) => ({
      id: m.value,
      label: versioned(m) || m.displayName || m.value,
      description: m.description,
      isDefault: m.value === 'default',
      efforts: m.supportsEffort === false ? [] : m.supportedEffortLevels
    }))
    // "Default (recommended)" is only another name for one of the models below: the user picks a named model, never a default row.
    // The named twin keeps isDefault internally, for a chat that starts before anything is picked.
    const alias = mapped.find((m) => m.id === 'default')
    const twin = alias && mapped.find((m) => m.id !== 'default' && m.label === alias.label)
    if (twin) twin.isDefault = true
    const models = twin ? mapped.filter((m) => m !== alias) : mapped
    this.modelCache.set(profile.id, { at: Date.now(), models })
    announceNewModels(models.filter((m) => m.id !== 'default').map((m) => m.label))
    return models
  }

  private async withConfigDir<T>(profile: Profile, fn: () => Promise<T>): Promise<T> {
    // listSessions/getSessionMessages read files in-process and honor CLAUDE_CONFIG_DIR.
    const dir = profileDir(profile)
    const prev = process.env.CLAUDE_CONFIG_DIR
    if (dir) process.env.CLAUDE_CONFIG_DIR = dir
    else delete process.env.CLAUDE_CONFIG_DIR
    try {
      return await fn()
    } finally {
      if (prev === undefined) delete process.env.CLAUDE_CONFIG_DIR
      else process.env.CLAUDE_CONFIG_DIR = prev
    }
  }

  async externalSessions(profile: Profile, cwd?: string): Promise<ExternalSession[]> {
    const sdk = await loadSdk()
    const list = await this.withConfigDir(profile, () => sdk.listSessions(cwd ? { dir: cwd, limit: 40 } : { limit: 300 }))
    return list.map((s) => ({
      engine: 'claude',
      profileId: profile.id,
      engineSessionId: s.sessionId,
      title: s.customTitle || s.summary || s.firstPrompt || s.sessionId,
      cwd: s.cwd || cwd || '',
      updatedAt: s.lastModified
    }))
  }

  /** Claude Code's ids of the user's own prompts, in order (tool results, commands and reminders left out). */
  async promptIds(profile: Profile, engineSessionId: string, cwd: string): Promise<string[]> {
    const sdk = await loadSdk()
    const messages = await this.withConfigDir(profile, () => sdk.getSessionMessages(engineSessionId, { dir: cwd }))
    return messages
      .filter((m) => m.type === 'user' && !m.parent_tool_use_id)
      .filter((m) => {
        const c = (m.message as { content?: unknown })?.content
        const blocks = Array.isArray(c) ? (c as { type?: string; text?: string }[]) : [{ type: 'text', text: String(c ?? '') }]
        if (blocks.some((b) => b.type === 'tool_result')) return false
        const text = blocks.find((b) => b.type === 'text')?.text?.trim() || ''
        return Boolean(text || blocks.some((b) => b.type === 'image')) && !text.startsWith('<') && !text.startsWith('/')
      })
      .map((m) => m.uuid)
  }

  async history(profile: Profile, engineSessionId: string, cwd: string): Promise<ChatItem[]> {
    const sdk = await loadSdk()
    const messages = await this.withConfigDir(profile, () => sdk.getSessionMessages(engineSessionId, { dir: cwd }))
    return claudeHistoryItems(messages)
  }

  async limits(profile: Profile): Promise<RateLimitSnapshot | undefined> {
    if (profile.auth !== 'subscription') return undefined
    const direct = await oauthUsage(profile)
    const usage = direct.limits || direct.cooldownMs
      ? undefined
      : await withProbe(profile, (q) => q.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({ skipBehaviors: true }))
    const raw = (direct.limits ?? usage?.rate_limits) as
      | Record<string, { utilization?: number | null; resets_at?: string | null; limit_dollars?: number | null } | null>
      | undefined
    if (!raw) {
      const mins = direct?.cooldownMs ? Math.ceil(direct.cooldownMs / 60000) : 0
      const note = mins
        ? tr("Limitele se pot citi din nou în ~{mins} min (serverul a limitat cererile)", { mins })
        : usage?.rate_limits_available
          ? tr("Limitele nu au putut fi citite acum")
          : tr("Contul nu raportează limite (cheie API sau endpoint propriu)")
      return { profileId: profile.id, windows: [], note, updatedAt: Date.now() }
    }
    const windows: LimitWindow[] = []
    for (const [key, w] of Object.entries(raw)) {
      if (!LIMIT_LABELS[key] || !w || typeof w !== 'object' || Array.isArray(w)) continue
      const used = usagePercent(w.utilization)
      if (used === undefined) continue
      windows.push({ label: LIMIT_LABELS[key], usedPercent: used, resetsAt: toMs(w.resets_at) })
    }
    if (!windows.length) {
      return { profileId: profile.id, windows: [], note: tr("Limitele nu au putut fi citite acum"), updatedAt: Date.now() }
    }
    const plan = usage?.subscription_type ?? direct?.plan
    return { profileId: profile.id, windows, note: plan ? `Plan: ${plan}` : undefined, updatedAt: Date.now() }
  }

  /** Asks a Claude model to describe images for a model that cannot see them. */
  async describe(profile: Profile, images: Attachment[], prompt = DESCRIBE_PROMPT, pick?: string): Promise<string> {
    const sdk = await loadSdk()
    prepareProfileDir(profile)
    const model = pick || (profile.auth === 'endpoint' ? profile.models?.[0] : 'haiku')
    async function* one(): AsyncGenerator<SDKUserMessage> {
      yield userMessage(prompt, images)
    }
    const q = sdk.query({ prompt: one(), options: { ...baseOptions(profile, os.homedir(), model), model, settingSources: [], tools: [], maxTurns: 1 } })
    const timer = setTimeout(() => q.close(), 180000)
    try {
      for await (const m of q) {
        if (m.type === 'result') {
          if (m.subtype === 'success' && m.result.trim()) return m.result.trim()
          throw new Error(tr("descrierea a eșuat ({subtype})", { subtype: m.subtype }))
        }
      }
      throw new Error(tr("descrierea nu a primit răspuns"))
    } finally {
      clearTimeout(timer)
      q.close()
    }
  }

  async shutdown(): Promise<void> {
    // sessions own their processes; nothing global to stop
  }
}
