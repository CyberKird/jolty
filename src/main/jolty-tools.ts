// Jolty's own tools for the model, served as an MCP server next to the browser one (same local hub, same
// token, one URL per chat): search and read earlier conversations, and schedule work for later.
// Like Hermes' session_search and cronjob tools, for Claude Code and Codex.
import type { ChatItem, PermissionMode, SessionMeta } from '@shared/types'
import type { ScheduledTask } from '@shared/schedule'
import { pageOf, savedTurns, search, turnsOf } from './recall'
import type { Scheduler } from './scheduler'

export const JOLTY_SERVER = 'jolty'

/** Tools that only read: they run without asking, except in Manual mode. */
export const JOLTY_READ_TOOLS = ['search_conversations', 'read_conversation', 'list_scheduled_tasks']

export const JOLTY_TOOLS_PROMPT =
  'Jolty tools (MCP server "jolty"): search_conversations and read_conversation find and read the user\'s earlier conversations in Jolty on this PC; use them when the user refers to earlier work, a past decision or "what we talked about". schedule_task runs a prompt later or on a repeat, each run in a new conversation, while Jolty is open; list_scheduled_tasks and cancel_scheduled_task manage them. Schedule only when the user asks for it.'

export interface ToolHost {
  /** saved conversations (never temporary ones) */
  sessions(): SessionMeta[]
  meta(sessionId: string): SessionMeta | undefined
  /** the full history, read from the engine when Jolty has no copy yet */
  history(sessionId: string): Promise<ChatItem[]>
  scheduler: Scheduler
}

let host: ToolHost | undefined

export function bindJoltyTools(h: ToolHost): void {
  host = h
}

type ToolResult = { content: { type: 'text'; text: string }[]; isError?: boolean }
const ok = (text: string): ToolResult => ({ content: [{ type: 'text', text }] })
const fail = (text: string): ToolResult => ({ content: [{ type: 'text', text }], isError: true })

const SCHEDULE_SCHEMA = {
  type: 'object',
  description:
    'One of: {"kind":"once","at":"2026-10-20T09:00"} (local time), {"kind":"every","minutes":60} (at least 10), {"kind":"daily","time":"08:30","days":[1,2,3,4,5]} (days 0 = Sunday to 6, every day when left out).',
  properties: {
    kind: { type: 'string', enum: ['once', 'every', 'daily'] },
    at: { type: 'string', description: 'once: local date and time, ISO 8601' },
    minutes: { type: 'number', description: 'every: minutes between runs' },
    time: { type: 'string', description: 'daily: HH:MM, 24 h, local time' },
    days: { type: 'array', items: { type: 'number' }, description: 'daily: weekdays, 0 = Sunday' }
  },
  required: ['kind']
}

const TOOLS = [
  {
    name: 'search_conversations',
    description:
      'Searches the user\'s earlier Jolty conversations (titles, project folders and what was said, not tool output). Returns the best matches with their id, date, folder and short excerpts. Then read one with read_conversation.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'words to look for; every word counts, diacritics and case are ignored' },
        limit: { type: 'number', description: 'how many conversations, 1 to 20 (default 8)' }
      },
      required: ['query']
    },
    annotations: { readOnlyHint: true }
  },
  {
    name: 'read_conversation',
    description: 'Reads one earlier conversation as text (user and assistant messages), in pages of 20,000 characters. The answer says which offset continues it.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'conversation id from search_conversations' }, offset: { type: 'number', description: 'character offset, 0 for the start' } },
      required: ['id']
    },
    annotations: { readOnlyHint: true }
  },
  {
    name: 'list_scheduled_tasks',
    description: 'Lists the scheduled tasks with their id, schedule, state, last run and next run.',
    inputSchema: { type: 'object', properties: {} },
    annotations: { readOnlyHint: true }
  },
  {
    name: 'schedule_task',
    description:
      'Schedules a prompt to run later or on a repeat. Each run starts a new conversation with the same account, model and project folder as this chat, in Auto mode if this chat uses it and "accept edits" otherwise (other commands still ask the user), and Jolty notifies when it ends. Runs happen only while Jolty is open; a run missed while it was closed happens once at the next start. Write the prompt so it stands on its own: the run does not see this conversation.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'short name shown to the user' },
        prompt: { type: 'string', description: 'the full instructions for each run' },
        schedule: SCHEDULE_SCHEMA,
        cwd: { type: 'string', description: 'project folder for the runs (default: this chat\'s folder)' }
      },
      required: ['name', 'prompt', 'schedule']
    }
  },
  {
    name: 'cancel_scheduled_task',
    description: 'Deletes a scheduled task. Conversations of runs that already happened stay.',
    inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] }
  }
]

/** local time, the way the user reads it on the PC */
function day(t: number): string {
  const d = new Date(t)
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

export function describeSchedule(t: ScheduledTask): string {
  const s = t.schedule
  if (s.kind === 'once') return `once at ${day(s.at)}`
  if (s.kind === 'every') return `every ${s.minutes} minutes`
  const names = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
  return `daily at ${s.time}${s.days?.length ? ` on ${s.days.map((d) => names[d]).join(', ')}` : ''}`
}

/** Runs nobody watches: a model never sets them up with more freedom than Auto or "accept edits". */
function taskMode(mode: PermissionMode): PermissionMode {
  return mode === 'auto' ? 'auto' : 'autoEdit'
}

async function run(h: ToolHost, sid: string, name: string, a: Record<string, unknown>): Promise<ToolResult> {
  if (name === 'search_conversations') {
    const query = String(a.query || '').trim()
    if (!query) return fail('query is empty')
    const limit = Math.max(1, Math.min(20, Math.round(Number(a.limit) || 8)))
    const hits = search(h.sessions().filter((s) => s.id !== sid), query, limit)
    if (!hits.length) return ok(`No earlier conversation matches "${query}".`)
    const lines = hits.map((x, i) =>
      [
        `${i + 1}. ${x.meta.title} (id: ${x.meta.id})`,
        `   ${day(x.meta.updatedAt)} · ${x.meta.cwd} · ${x.meta.engine}${x.indexed ? '' : ' · history not loaded yet, only the title matched (read_conversation loads it)'}`,
        ...x.snippets.map((s) => `   ${s}`)
      ].join('\n')
    )
    return ok(`${hits.length} conversation(s) for "${query}", best first:\n\n${lines.join('\n\n')}`)
  }
  if (name === 'read_conversation') {
    const id = String(a.id || '')
    const meta = h.sessions().find((s) => s.id === id)
    if (!meta) return fail(`No saved conversation with id ${id}.`)
    const turns = savedTurns(id) ?? turnsOf(await h.history(id))
    if (!turns.length) return ok(`"${meta.title}" has no messages.`)
    const page = pageOf(turns, Math.round(Number(a.offset) || 0))
    const head = `# ${meta.title}\n${day(meta.createdAt)} to ${day(meta.updatedAt)} · ${meta.cwd} · ${meta.engine}\n\n`
    const tail = page.next !== undefined ? `\n\n[${page.total - page.next} more characters: read_conversation with offset ${page.next}]` : ''
    return ok(head + page.text + tail)
  }
  if (name === 'list_scheduled_tasks') {
    const tasks = h.scheduler.list()
    if (!tasks.length) return ok('No scheduled tasks.')
    return ok(
      tasks
        .map((t) =>
          [
            `- ${t.name} (id: ${t.id}) ${t.enabled ? 'on' : 'off'}, ${describeSchedule(t)}, folder ${t.cwd}`,
            t.lastRunAt ? `  last run ${day(t.lastRunAt)}${t.lastError ? `, failed: ${t.lastError}` : ''}` : '  not run yet',
            `  prompt: ${t.prompt.length > 300 ? `${t.prompt.slice(0, 300)}...` : t.prompt}`
          ].join('\n')
        )
        .join('\n')
    )
  }
  if (name === 'schedule_task') {
    const meta = h.meta(sid)
    if (!meta) return fail('This conversation is not known to Jolty.')
    const task = h.scheduler.add({
      name: String(a.name || ''),
      prompt: String(a.prompt || ''),
      schedule: a.schedule as never,
      cwd: typeof a.cwd === 'string' && a.cwd ? a.cwd : meta.cwd,
      profileId: meta.profileId,
      model: meta.model,
      effort: meta.effort,
      permissionMode: taskMode(meta.permissionMode)
    })
    return ok(`Scheduled "${task.name}" (id: ${task.id}), ${describeSchedule(task)}. The user can change or stop it on the Scheduled page in Jolty.`)
  }
  if (name === 'cancel_scheduled_task') {
    const id = String(a.id || '')
    const task = h.scheduler.list().find((t) => t.id === id)
    if (!task) return fail(`No scheduled task with id ${id}.`)
    h.scheduler.remove(id)
    return ok(`Deleted the scheduled task "${task.name}".`)
  }
  return fail(`Unknown tool ${name}`)
}

/** One JSON-RPC message of the MCP protocol; undefined for notifications. */
export async function handleJoltyTools(sid: string, msg: Record<string, unknown>): Promise<Record<string, unknown> | undefined> {
  const id = msg.id
  const method = String(msg.method || '')
  const reply = (result: unknown): Record<string, unknown> => ({ jsonrpc: '2.0', id, result })
  if (id === undefined || id === null) return undefined
  if (method === 'initialize') {
    const params = (msg.params || {}) as { protocolVersion?: string }
    return reply({ protocolVersion: params.protocolVersion || '2025-03-26', capabilities: { tools: { listChanged: false } }, serverInfo: { name: JOLTY_SERVER, version: '1.0.0' } })
  }
  if (method === 'ping') return reply({})
  if (method === 'tools/list') return reply({ tools: TOOLS })
  if (method === 'tools/call') {
    const params = (msg.params || {}) as { name?: string; arguments?: Record<string, unknown> }
    if (!host) return reply(fail('Jolty is still starting.'))
    try {
      return reply(await run(host, sid, String(params.name || ''), params.arguments || {}))
    } catch (e) {
      return reply(fail(e instanceof Error ? e.message : String(e)))
    }
  }
  return { jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } }
}
