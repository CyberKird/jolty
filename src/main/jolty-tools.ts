// Jolty's own tools for the model, served as an MCP server next to the browser one (same local hub, same
// token, one URL per chat): search and read earlier conversations, schedule work for later, and run
// several sessions at once (start_session, worktrees, a shared ledger). Like Hermes' session_search
// and cronjob tools, for Claude Code and Codex.
import type { ChatItem, PermissionMode, SessionMeta } from '@shared/types'
import type { ScheduledTask } from '@shared/schedule'
import { pageOf, savedTurns, search, turnsOf } from './recall'
import type { Scheduler } from './scheduler'
import { projectOf, readLedger, writeLedger } from './workers'

export const JOLTY_SERVER = 'jolty'

/** Tools that only read, or only touch Jolty's own notes: they run without asking, except in Manual mode. */
export const JOLTY_READ_TOOLS = ['search_conversations', 'read_conversation', 'list_scheduled_tasks', 'list_sessions', 'wait_for_sessions', 'ledger_read', 'ledger_write']

export const JOLTY_TOOLS_PROMPT =
  'Jolty tools (MCP server "jolty"): search_conversations and read_conversation find and read the user\'s earlier conversations in Jolty on this PC; use them when the user refers to earlier work, a past decision or "what we talked about". schedule_task runs a prompt later or on a repeat, each run in a new conversation, while Jolty is open; list_scheduled_tasks and cancel_scheduled_task manage them. Schedule only when the user asks for it. Several jobs at once: start_session gives each job its own session (own git worktree and branch when the project is a repository) with a short brief that stands on its own; wait_for_sessions returns when they end, list_sessions shows their state and last answer, send_to_session talks to one. Merging their branches is your job. ledger_read and ledger_write keep one shared notes file for the project: read it first when you start, and write decisions, state and open work there instead of re-exploring the codebase. Start sessions only when the user asked for parallel work or the task clearly splits into independent jobs.'

export interface ToolHost {
  /** saved conversations (never temporary ones) */
  sessions(): SessionMeta[]
  meta(sessionId: string): SessionMeta | undefined
  /** the full history, read from the engine when Jolty has no copy yet */
  history(sessionId: string): Promise<ChatItem[]>
  scheduler: Scheduler
  /** a new session for one job of a lead session */
  startChild(leadId: string, input: { title: string; brief: string; isolate: boolean; complexity?: string }): Promise<{ meta: SessionMeta; note: string }>
  children(leadId: string): SessionMeta[]
  busy(sessionId: string): boolean
  /** the end of the last answer of a session */
  lastAnswer(sessionId: string): string
  /** the warning or error a session ended on (a model that ran out of context, a stop, a failure), empty when it ended normally */
  problem(sessionId: string): string
  /** resolves when none of `ids` has a turn under way, or after `ms` */
  waitIdle(ids: string[], ms: number): Promise<void>
  sendTo(leadId: string, id: string, text: string): Promise<void>
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
    name: 'start_session',
    description:
      'Starts a new session for one job and returns at once; the session works on its own, with the same account, model and effort as this chat, with the permission mode chosen in the Jolty settings (no permissions unless the user changed it) and the Jolty browser. In a git repository it gets its own worktree and branch cut from the last commit (your uncommitted changes and untracked files such as node_modules are not in it), so sessions never write the same files; it commits its work on that branch. The session does not see this conversation: the brief must hold everything it needs (goal, the files and decisions that matter, what done looks like). Up to 8 sessions work at once. Then use wait_for_sessions, and merge the branches yourself.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'short name shown to the user in the sidebar' },
        brief: { type: 'string', description: 'the full, self-contained instructions for the job' },
        complexity: { type: 'string', enum: ['simple', 'normal', 'hard'], description: 'how demanding the job is: simple (mechanical, clear steps, small files: renames, tests after an existing pattern, translations, running commands) or hard (needs the strongest model); the user may have set a different model for each in the settings. Simple may go to a small fast model with a short context, so never use it for judgment work: security audits, code review, debugging, design or reading a large codebase are normal or hard. Default normal: the model of this chat' },
        isolate: { type: 'boolean', description: "false: work in this chat's folder instead of a worktree (default true when the folder is a git repository)" }
      },
      required: ['title', 'brief']
    }
  },
  {
    name: 'list_sessions',
    description: 'Lists the sessions you started: id, title, running or idle, branch, and the end of the last answer.',
    inputSchema: { type: 'object', properties: {} },
    annotations: { readOnlyHint: true }
  },
  {
    name: 'wait_for_sessions',
    description:
      'Waits until the sessions you started have ended their turn (all of them, or the ids given), for at most 100 seconds per call, then lists them like list_sessions. When some still run, call it again. Waiting costs nothing.',
    inputSchema: { type: 'object', properties: { ids: { type: 'array', items: { type: 'string' }, description: 'session ids, all of yours when left out' } } },
    annotations: { readOnlyHint: true }
  },
  {
    name: 'send_to_session',
    description: 'Sends a follow-up message to a session you started (a correction, the next step). It is queued if the session is still working.',
    inputSchema: { type: 'object', properties: { id: { type: 'string' }, message: { type: 'string' } }, required: ['id', 'message'] }
  },
  {
    name: 'ledger_read',
    description: 'Reads the shared ledger of this project: notes written by every session working on it (decisions, state, open work). Read it when you start.',
    inputSchema: { type: 'object', properties: {} },
    annotations: { readOnlyHint: true }
  },
  {
    name: 'ledger_write',
    description:
      "Writes to the project ledger. mode \"append\" (default) adds a dated entry under your session's name; \"replace\" rewrites the whole file, to keep it short (over 30,000 characters it must be rewritten). Write what a new session would otherwise have to find out again: decisions and why, current state, what is done, what is open, traps found.",
    inputSchema: {
      type: 'object',
      properties: { text: { type: 'string' }, mode: { type: 'string', enum: ['append', 'replace'] } },
      required: ['text']
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
export function taskMode(mode: PermissionMode): PermissionMode {
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
  if (name === 'start_session') {
    const title = String(a.title || '').replace(/\s+/g, ' ').trim().slice(0, 80)
    const brief = String(a.brief || '').trim()
    if (!title || !brief) return fail('title and brief are both needed')
    const { meta, note } = await h.startChild(sid, { title, brief, isolate: a.isolate !== false, complexity: String(a.complexity || '') })
    return ok(`Started "${meta.title}" (id: ${meta.id}). ${note} It is working now: use wait_for_sessions to wait for it.`)
  }
  if (name === 'list_sessions' || name === 'wait_for_sessions') {
    let kids = h.children(sid)
    const ids = Array.isArray(a.ids) ? a.ids.map(String) : []
    if (ids.length) kids = kids.filter((k) => ids.includes(k.id))
    if (!kids.length) return ok('You have not started any session.')
    if (name === 'wait_for_sessions') await h.waitIdle(kids.map((k) => k.id), 100000)
    return ok(
      kids
        .map((k) => {
          const problem = h.busy(k.id) ? '' : h.problem(k.id)
          // a session that failed looks idle with no answer: say why, and that a bigger model is the way out
          const note = problem ? `\n  ENDED WITH A PROBLEM: ${problem}\n  If the model could not carry this job, start it again with complexity normal (the model of this chat).` : ''
          return `- ${k.title} (id: ${k.id}) ${h.busy(k.id) ? 'RUNNING' : 'idle'}${k.worktree ? `, branch ${k.worktree.branch}, folder ${k.worktree.path}` : ''}\n  last answer: ${h.lastAnswer(k.id) || '(none yet)'}${note}`
        })
        .join('\n')
    )
  }
  if (name === 'send_to_session') {
    await h.sendTo(sid, String(a.id || ''), String(a.message || ''))
    return ok('Sent.')
  }
  if (name === 'ledger_read') {
    const meta = h.meta(sid)
    if (!meta) return fail('This conversation is not known to Jolty.')
    return ok(readLedger(projectOf(meta)) || 'The ledger of this project is empty.')
  }
  if (name === 'ledger_write') {
    const meta = h.meta(sid)
    if (!meta) return fail('This conversation is not known to Jolty.')
    const text = String(a.text || '').trim()
    if (!text) return fail('text is empty')
    writeLedger(projectOf(meta), text, a.mode === 'replace' ? 'replace' : 'append', meta.title)
    return ok('Written to the ledger.')
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
  if (method === 'tools/list') {
    // a session started by a lead does not start sessions of its own: no tree of sessions nobody can follow
    const child = Boolean(host?.meta(sid)?.parentId)
    return reply({ tools: child ? TOOLS.filter((t) => t.name !== 'start_session' && t.name !== 'send_to_session') : TOOLS })
  }
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
