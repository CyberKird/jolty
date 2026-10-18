// Scheduled tasks: a prompt Jolty sends on its own, in a new conversation, at a set time or on a repeat.
// Pure functions only, shared by the main process (when to run) and the interface (how to show it).
import type { PermissionMode } from './types'

export type TaskSchedule =
  | { kind: 'once'; at: number }
  | { kind: 'every'; minutes: number }
  /** local time "HH:MM"; days 0 (Sunday) to 6, every day when empty */
  | { kind: 'daily'; time: string; days?: number[] }

export interface ScheduledTask {
  id: string
  name: string
  prompt: string
  profileId: string
  model?: string
  effort?: string
  cwd: string
  permissionMode: PermissionMode
  schedule: TaskSchedule
  enabled: boolean
  createdAt: number
  lastRunAt?: number
  /** the conversation of the last run */
  lastSessionId?: string
  lastError?: string
}

export type TaskInput = Pick<ScheduledTask, 'name' | 'prompt' | 'profileId' | 'cwd' | 'permissionMode' | 'schedule'> & Partial<Pick<ScheduledTask, 'model' | 'effort' | 'enabled'>>

/** the shortest repeat: an unattended run every minute would burn a subscription in an afternoon */
export const MIN_EVERY_MINUTES = 10

/** Modes a run nobody watches can use: Plan and Manual would only wait for a click. */
export const TASK_MODES: PermissionMode[] = ['autoEdit', 'auto', 'project', 'full']

const TIME = /^([01]?\d|2[0-3]):([0-5]\d)$/

/** Throws on a schedule that cannot run; returns a clean copy. */
export function checkSchedule(s: unknown): TaskSchedule {
  const x = (s || {}) as Record<string, unknown>
  if (x.kind === 'once') {
    const at = typeof x.at === 'string' ? Date.parse(x.at) : Number(x.at)
    if (!Number.isFinite(at)) throw new Error('once: "at" must be a date and time')
    return { kind: 'once', at }
  }
  if (x.kind === 'every') {
    const minutes = Math.round(Number(x.minutes))
    if (!Number.isFinite(minutes) || minutes < MIN_EVERY_MINUTES) throw new Error(`every: "minutes" must be at least ${MIN_EVERY_MINUTES}`)
    return { kind: 'every', minutes }
  }
  if (x.kind === 'daily') {
    const time = String(x.time || '')
    if (!TIME.test(time)) throw new Error('daily: "time" must be HH:MM (24 h, local time)')
    const days = Array.isArray(x.days) ? [...new Set(x.days.map(Number))].filter((d) => Number.isInteger(d) && d >= 0 && d <= 6).sort() : []
    return { kind: 'daily', time: time.padStart(5, '0'), ...(days.length && days.length < 7 ? { days } : {}) }
  }
  throw new Error('schedule.kind must be "once", "every" or "daily"')
}

/** The first daily slot strictly after `t`, in local time. */
function nextDaily(time: string, days: number[] | undefined, t: number): number {
  const [h, m] = time.split(':').map(Number)
  const d = new Date(t)
  d.setHours(h, m, 0, 0)
  for (let i = 0; i < 8; i++) {
    if (d.getTime() > t && (!days?.length || days.includes(d.getDay()))) return d.getTime()
    d.setDate(d.getDate() + 1)
    d.setHours(h, m, 0, 0)
  }
  return d.getTime()
}

/**
 * When the task should run next, or undefined when it never will again. A run missed while Jolty was
 * closed comes back as a time in the past: it runs once at start, not once per missed slot.
 */
export function nextRun(task: Pick<ScheduledTask, 'schedule' | 'createdAt' | 'lastRunAt' | 'enabled'>): number | undefined {
  if (!task.enabled) return undefined
  const s = task.schedule
  const from = task.lastRunAt ?? task.createdAt
  if (s.kind === 'once') return task.lastRunAt ? undefined : s.at
  if (s.kind === 'every') return from + s.minutes * 60000
  return nextDaily(s.time, s.days, from)
}

export function isDue(task: Parameters<typeof nextRun>[0], now: number): boolean {
  const next = nextRun(task)
  return next !== undefined && next <= now
}
