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

/** the counter the running app keeps adding to; reading and merging go through it so a tick never overwrites them */
let live: Counted | undefined

function read(): Counted {
  if (live) return live
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

const TIME_MAGIC = Buffer.from('JTIME1' + String.fromCharCode(10))
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v >= 0 && v < 1e13 ? v : 0)

/** The backup carries the count in front of the pack, so the time follows the person to a new PC. */
export function withTime(pack: Buffer): Buffer {
  const json = Buffer.from(JSON.stringify(read()))
  const len = Buffer.alloc(4)
  len.writeUInt32BE(json.length)
  return Buffer.concat([TIME_MAGIC, len, json, pack])
}

/** Takes the count off a restored backup (older backups have none) and returns the pack. */
export function takeTime(buf: Buffer): { pack: Buffer; time?: unknown } {
  if (buf.length < TIME_MAGIC.length + 4 || !buf.subarray(0, TIME_MAGIC.length).equals(TIME_MAGIC)) return { pack: buf }
  const len = buf.readUInt32BE(TIME_MAGIC.length)
  const start = TIME_MAGIC.length + 4
  if (len > 4096 || start + len > buf.length) return { pack: buf }
  try {
    return { pack: buf.subarray(start + len), time: JSON.parse(buf.subarray(start, start + len).toString('utf8')) }
  } catch {
    return { pack: buf.subarray(start + len) }
  }
}

/** Keeps the larger of each count: restoring on a new PC brings the time back, restoring twice changes nothing. */
export function mergeTime(remote: unknown): void {
  if (!remote || typeof remote !== 'object') return
  const r = remote as Partial<Counted>
  const c = read()
  c.aiMs = Math.max(c.aiMs, num(r.aiMs))
  c.appMs = Math.max(c.appMs, num(r.appMs))
  c.estimatedMs = Math.max(c.estimatedMs, num(r.estimatedMs))
  if (num(r.since)) c.since = Math.min(c.since, num(r.since))
  write(c)
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
  live = c
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
