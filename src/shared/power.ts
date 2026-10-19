// What "power" can do and when, shared by the main process (which runs it) and the interface (which asks for it).
// Modelled on ShutdownTimer: the same six actions, a countdown or a time of day, and graceful vs forced.
import { tr } from './i18n'
import type { PowerAction, PowerPlan, PowerWhen } from './types'

export const POWER_ACTIONS: PowerAction[] = ['shutdown', 'restart', 'sleep', 'hibernate', 'logoff', 'lock']
/** the ones that close programs, so they may be forced and get the full warning time */
export const DESTRUCTIVE: PowerAction[] = ['shutdown', 'restart', 'logoff']

export const DEFAULT_PLAN: PowerPlan = { action: 'shutdown', when: { kind: 'done' }, force: true }

export const ACTION_LABEL: Record<PowerAction, () => string> = {
  shutdown: () => tr("Oprește"),
  restart: () => tr("Repornește"),
  sleep: () => tr("Sleep"),
  hibernate: () => tr("Hibernare"),
  logoff: () => tr("Închide sesiunea"),
  lock: () => tr("Blochează")
}

/** the sentence subject for "…in 59 s" */
export const ACTION_WHAT: Record<PowerAction, () => string> = {
  shutdown: () => tr("PC-ul se oprește"),
  restart: () => tr("PC-ul repornește"),
  sleep: () => tr("PC-ul intră în sleep"),
  hibernate: () => tr("PC-ul intră în hibernare"),
  logoff: () => tr("Sesiunea se închide"),
  lock: () => tr("PC-ul se blochează")
}

/** Anything that crosses IPC goes through here: unknown fields drop, bad values fall back to the default. */
export function sanitizePlan(p: unknown): PowerPlan {
  const o = (p && typeof p === 'object' ? p : {}) as { action?: unknown; when?: { kind?: unknown; minutes?: unknown; time?: unknown }; force?: unknown }
  const action = POWER_ACTIONS.find((a) => a === o.action) ?? DEFAULT_PLAN.action
  const w = o.when
  let when: PowerWhen = { kind: 'done' }
  if (w?.kind === 'in') when = { kind: 'in', minutes: Math.min(1440, Math.max(1, Math.round(Number(w.minutes)) || 1)) }
  else if (w?.kind === 'at' && typeof w.time === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(w.time)) when = { kind: 'at', time: w.time }
  return { action, when, force: o.force !== false }
}

/** When a timed plan fires (ms since the epoch); a time of day that has passed means tomorrow, like ShutdownTimer. */
export function dueAt(when: Exclude<PowerWhen, { kind: 'done' }>, now: number): number {
  if (when.kind === 'in') return now + when.minutes * 60_000
  const [h, m] = when.time.split(':').map(Number)
  const d = new Date(now)
  d.setHours(h, m, 0, 0)
  if (d.getTime() <= now) d.setDate(d.getDate() + 1)
  return d.getTime()
}
