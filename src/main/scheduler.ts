// Runs scheduled tasks while Jolty is open: each run is a new conversation with the task's prompt, so it
// shows in the sidebar, notifies when it ends and can be continued like any chat.
import { randomUUID } from 'crypto'
import fs from 'fs'
import { checkSchedule, isDue, TASK_MODES, type ScheduledTask, type TaskInput } from '@shared/schedule'
import { loadSchedules, saveSchedules } from './store'
import { tr } from '@shared/i18n'

export interface SchedulerHost {
  /** starts the run and returns its conversation id */
  run(task: ScheduledTask): Promise<string>
  /** the conversation still has a turn under way */
  busy(sessionId: string): boolean
  profileExists(id: string): boolean
  changed(): void
}

/** Throws a readable error on anything a run could not use. */
export function checkTask(input: TaskInput, host: Pick<SchedulerHost, 'profileExists'>): TaskInput {
  const name = String(input.name || '').replace(/\s+/g, ' ').trim().slice(0, 80)
  const prompt = String(input.prompt || '').trim()
  if (!name) throw new Error(tr("Sarcina are nevoie de un nume."))
  if (!prompt) throw new Error(tr("Sarcina are nevoie de un mesaj pentru model."))
  if (prompt.length > 20000) throw new Error(tr("Mesajul sarcinii e prea lung."))
  if (!host.profileExists(input.profileId)) throw new Error(tr("Profilul sarcinii nu mai există."))
  if (!input.cwd || !fs.existsSync(input.cwd) || !fs.statSync(input.cwd).isDirectory()) throw new Error(tr("Folderul sarcinii nu există: {cwd}", { cwd: input.cwd }))
  if (!TASK_MODES.includes(input.permissionMode)) throw new Error(tr("O sarcină programată nu poate rula în modul Manual sau Plan: nu are cine să aprobe."))
  return { ...input, name, prompt, schedule: checkSchedule(input.schedule) }
}

export class Scheduler {
  private timer?: NodeJS.Timeout
  private starting = new Set<string>()

  constructor(private host: SchedulerHost) {}

  list(): ScheduledTask[] {
    return loadSchedules()
  }

  add(input: TaskInput): ScheduledTask {
    const task: ScheduledTask = { ...checkTask(input, this.host), id: randomUUID(), enabled: input.enabled !== false, createdAt: Date.now() }
    saveSchedules([...loadSchedules(), task])
    this.host.changed()
    return task
  }

  update(id: string, patch: Partial<TaskInput>): ScheduledTask {
    const all = loadSchedules()
    const i = all.findIndex((t) => t.id === id)
    if (i < 0) throw new Error(tr("Sarcina nu mai există."))
    const prev = all[i]
    const next: ScheduledTask = { ...prev, ...checkTask({ ...prev, ...patch }, this.host), enabled: patch.enabled ?? prev.enabled }
    // a new time starts counting from now, not from the last run
    if (patch.schedule && JSON.stringify(next.schedule) !== JSON.stringify(prev.schedule)) {
      next.createdAt = Date.now()
      next.lastRunAt = undefined
    }
    // a one-time task turned back on for a time still ahead runs again
    if (patch.enabled && next.schedule.kind === 'once' && next.schedule.at > Date.now()) next.lastRunAt = undefined
    all[i] = next
    saveSchedules(all)
    this.host.changed()
    return next
  }

  remove(id: string): void {
    const all = loadSchedules()
    if (!all.some((t) => t.id === id)) return
    saveSchedules(all.filter((t) => t.id !== id))
    this.host.changed()
  }

  async runNow(id: string): Promise<string> {
    const task = loadSchedules().find((t) => t.id === id)
    if (!task) throw new Error(tr("Sarcina nu mai există."))
    return this.fire(task)
  }

  start(): void {
    if (this.timer) return
    // the first check waits a little: accounts and engines are still waking up right after start
    this.timer = setTimeout(() => {
      void this.tick()
      this.timer = setInterval(() => void this.tick(), 30000)
    }, 20000)
  }

  stop(): void {
    clearTimeout(this.timer)
    clearInterval(this.timer)
    this.timer = undefined
  }

  /** Public for tests; the timer calls it every 30 seconds. */
  async tick(now = Date.now()): Promise<void> {
    for (const task of loadSchedules()) {
      if (!isDue(task, now) || this.starting.has(task.id)) continue
      // the last run is still working: this one waits for it instead of piling up
      if (task.lastSessionId && this.host.busy(task.lastSessionId)) continue
      await this.fire(task).catch(() => undefined)
    }
  }

  private patch(id: string, p: Partial<ScheduledTask>): void {
    const all = loadSchedules()
    const i = all.findIndex((t) => t.id === id)
    if (i < 0) return
    all[i] = { ...all[i], ...p }
    saveSchedules(all)
  }

  private async fire(task: ScheduledTask): Promise<string> {
    if (this.starting.has(task.id)) throw new Error(tr("Sarcina pornește deja."))
    this.starting.add(task.id)
    // marked before it starts: a crash during the run must not make it run again at every start
    this.patch(task.id, { lastRunAt: Date.now(), ...(task.schedule.kind === 'once' ? { enabled: false } : {}) })
    try {
      const sessionId = await this.host.run(task)
      this.patch(task.id, { lastSessionId: sessionId, lastError: undefined })
      return sessionId
    } catch (e) {
      this.patch(task.id, { lastError: e instanceof Error ? e.message : String(e) })
      throw e
    } finally {
      this.starting.delete(task.id)
      this.host.changed()
    }
  }
}
