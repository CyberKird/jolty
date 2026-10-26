// How long Jolty has been used: time with a chat working ("AI") and time with Jolty in front ("app"), counted every
// few seconds from the day this file appears, plus a few numbers read from the saved turns. The history before the
// count began is estimated once for the AI time from the turns (gaps over ten minutes count as a break).
import fs from 'fs'
import path from 'path'
import type { TurnUsage } from '@shared/types'
import type { UseStats } from '@shared/backup'
import { dataDir, loadSessions, loadUsage } from './store'

const FILE = 'use-time.json'
const TICK = 15_000
/** a tick that comes much later than expected means the PC slept: that time was not use */
const MAX_STEP = 2 * TICK
const BREAK = 10 * 60_000

interface Counted {
  since: number
  appMs: number
  aiMs: number
  estimatedMs: number
}

/** Time between turns that follow each other closely: what the user spent prompting before Jolty counted by itself. */
export function estimateAiMs(turns: Pick<TurnUsage, 'ts'>[]): number {
  const ts = turns.map((t) => t.ts).sort((a, b) => a - b)
  let sum = 0
  for (let i = 1; i < ts.length; i++) if (ts[i] - ts[i - 1] <= BREAK) sum += ts[i] - ts[i - 1]
  return sum
}

const file = (): string => path.join(dataDir(), FILE)

function read(): Counted {
  try {
    return JSON.parse(fs.readFileSync(file(), 'utf8')) as Counted
  } catch {
    const turns = loadUsage(0)
    return { since: Date.now(), appMs: 0, aiMs: 0, estimatedMs: estimateAiMs(turns) }
  }
}

function write(c: Counted): void {
  fs.mkdirSync(dataDir(), { recursive: true })
  const tmp = `${file()}.${process.pid}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(c))
  fs.renameSync(tmp, file())
}

export function stats(): UseStats {
  const c = read()
  const turns = loadUsage(0)
  const days = new Set(turns.map((t) => new Date(t.ts).toDateString()))
  return {
    aiMs: c.aiMs + c.estimatedMs,
    appMs: c.appMs,
    estimatedMs: c.estimatedMs,
    since: c.since,
    turns: turns.length,
    tokens: turns.reduce((n, t) => n + t.inputTokens + t.outputTokens, 0),
    chats: loadSessions().filter((s) => !s.temporary).length,
    activeDays: days.size
  }
}

/** Starts the count; returns the function that stops it. */
export function startUseTime(working: () => boolean, inFront: () => boolean): () => void {
  const c = read()
  let last = Date.now()
  write(c)
  const timer = setInterval(() => {
    const now = Date.now()
    const dt = Math.min(now - last, MAX_STEP)
    last = now
    if (working()) c.aiMs += dt
    if (inFront()) c.appMs += dt
    write(c)
  }, TICK)
  timer.unref()
  return () => clearInterval(timer)
}
