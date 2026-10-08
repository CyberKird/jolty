// How long the agent has worked and how long its task list still needs, from when steps get done.
import type { PlanStep } from './types'

export interface Clock {
  /** the turn started */
  turn?: number
  /** the task list appeared, with this many steps already done */
  plan?: number
  base?: number
  /** steps done now, and when the last one got done */
  done?: number
  last?: number
}

const doneCount = (steps: PlanStep[] | undefined): number => (steps || []).filter((x) => x.status === 'done').length

/** A fresh task list restarts the plan clock; each newly finished step moves its last mark. */
export function tick(c: Clock | undefined, prev: PlanStep[] | undefined, steps: PlanStep[], now = Date.now()): Clock {
  const done = doneCount(steps)
  const fresh = !c?.plan || !prev?.length || (doneCount(prev) === prev.length && done < steps.length)
  if (fresh) return { ...c, plan: now, base: done, done, last: now }
  return done > (c.done ?? 0) ? { ...c, done, last: now } : { ...c, done }
}

/**
 * Time left: the pace of the steps finished so far times the steps left, minus the time already
 * spent on the current one (never below a tenth of a step while work remains).
 * ponytail: every step weighs the same; weigh by step text length if estimates swing too much.
 */
export function timeLeft(c: Clock | undefined, steps: PlanStep[], now: number): number | undefined {
  const done = doneCount(steps)
  const left = steps.length - done
  const counted = done - (c?.base ?? 0)
  if (!c?.plan || !c.last || counted <= 0 || left <= 0) return undefined
  const pace = (c.last - c.plan) / counted
  return pace * left - Math.min(now - c.last, pace * 0.9)
}

/** "~4 min rămase", or "se estimează" until the first step is done. */
export function etaLabel(ms: number | undefined): string {
  if (ms === undefined) return 'se estimează'
  if (ms < 60e3) return 'sub 1 min rămas'
  return `~${Math.round(ms / 60e3)} min rămase`
}

/** 75 000 ms -> "1:15" */
export function clock(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  const h = Math.floor(s / 3600)
  const mm = String(Math.floor((s % 3600) / 60))
  const ss = String(s % 60).padStart(2, '0')
  return h ? `${h}:${mm.padStart(2, '0')}:${ss}` : `${mm}:${ss}`
}
