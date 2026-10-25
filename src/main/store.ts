import { app, safeStorage } from 'electron'
import fs from 'fs'
import path from 'path'
import type { AppSettings, ChatItem, Profile, RateLimitSnapshot, SessionMeta, TurnUsage } from '@shared/types'
import { isAcp } from '@shared/types'
import type { ScheduledTask } from '@shared/schedule'
import type { SeenFile } from './model-watch-core'

/** Root folder for Jolty's own data. JOLTY_DATA_DIR overrides it (used by tests). */
export function dataDir(): string {
  return process.env.JOLTY_DATA_DIR || app.getPath('userData')
}

function file(name: string): string {
  return path.join(dataDir(), name)
}

function readJson<T>(name: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(file(name), 'utf8')) as T
  } catch {
    return fallback
  }
}

function writeJson(name: string, value: unknown, pretty = true): void {
  const target = file(name)
  fs.mkdirSync(path.dirname(target), { recursive: true })
  const tmp = `${target}.${process.pid}.tmp`
  fs.writeFileSync(tmp, pretty ? JSON.stringify(value, null, 2) : JSON.stringify(value))
  fs.renameSync(tmp, target)
}

// ---------------------------------------------------------------------------
// Profiles and secrets
// ---------------------------------------------------------------------------
export function loadProfiles(): Profile[] {
  return readJson<Profile[]>('profiles.json', [])
}

export function saveProfiles(profiles: Profile[]): void {
  writeJson('profiles.json', profiles)
}

export const COLORS = ['#d97757', '#10a37f', '#6c8cff', '#e0a23b', '#c060d0', '#3bb3c3', '#e05a7a', '#8fb339', '#9a6cf0', '#4cbb5e', '#4aa3e8', '#b08a6a']

/** First palette color no profile uses; past the palette, golden-angle hues, so two profiles never share a color. */
export function freeColor(profiles: Pick<Profile, 'color'>[]): string {
  const taken = new Set(profiles.map((p) => p.color?.toLowerCase()))
  const free = COLORS.find((c) => !taken.has(c))
  if (free) return free
  for (let i = 0; ; i++) {
    // lighter / darker than the palette so a hue close to a palette color still reads as different
    const c = `hsl(${Math.round((i * 137.508 + 20) % 360)} 60% ${i % 2 ? 78 : 42}%)`
    if (!taken.has(c)) return c
  }
}

/** Gives every profile that repeats an earlier profile's color (or has none) a free one; saves only if something changed. */
export function fixProfileColors(): void {
  const seen: Profile[] = []
  let changed = false
  for (const p of loadProfiles()) {
    if (!p.color || seen.some((q) => q.color?.toLowerCase() === p.color!.toLowerCase())) {
      p.color = freeColor(seen)
      changed = true
    }
    seen.push(p)
  }
  if (changed) saveProfiles(seen)
}

/** Saves the profiles in the order of `ids`; ids it does not know are ignored, profiles missing from it keep their place at the end. */
export function reorderProfiles(ids: unknown): Profile[] {
  if (!Array.isArray(ids) || !ids.every((id) => typeof id === 'string')) throw new Error('Ordine invalidă')
  const rank = new Map(ids.map((id, i) => [id, i]))
  const all = loadProfiles()
  const sorted = all.map((p, i) => ({ p, k: rank.get(p.id) ?? ids.length + i })).sort((a, b) => a.k - b.k).map((x) => x.p)
  saveProfiles(sorted)
  return sorted
}

/** Per-profile config folder (CLAUDE_CONFIG_DIR / CODEX_HOME) for non-default profiles. */
export function profileDir(profile: Profile): string | undefined {
  if (profile.isDefaultDir || isAcp(profile.engine)) return undefined
  return path.join(dataDir(), 'profiles', profile.id, profile.engine)
}

type SecretMap = Record<string, { enc: boolean; value: string }>

export function setSecret(profileId: string, secret: string | undefined): void {
  const all = readJson<SecretMap>('secrets.json', {})
  if (!secret) {
    delete all[profileId]
  } else if (safeStorage.isEncryptionAvailable()) {
    all[profileId] = { enc: true, value: safeStorage.encryptString(secret).toString('base64') }
  } else {
    // No OS keychain (some Linux setups): stored in the user-only data folder.
    all[profileId] = { enc: false, value: secret }
  }
  writeJson('secrets.json', all)
}

export function getSecret(profileId: string): string | undefined {
  const entry = readJson<SecretMap>('secrets.json', {})[profileId]
  if (!entry) return undefined
  return entry.enc ? safeStorage.decryptString(Buffer.from(entry.value, 'base64')) : entry.value
}

// ---------------------------------------------------------------------------
// Sessions and transcripts
// ---------------------------------------------------------------------------
export function loadSessions(): SessionMeta[] {
  return readJson<SessionMeta[]>('sessions.json', [])
}

export function saveSessions(sessions: SessionMeta[]): void {
  writeJson('sessions.json', sessions)
}

// A tool result can be megabytes (a Read of a big file, a browser screenshot). The engine keeps the
// original in its own session file; Jolty's copy only has to show the chat again, so it is clipped.
const CLIP = 20000

function clipText(s: string): string {
  if (s.length <= CLIP) return s
  const head = Math.floor(CLIP * 0.7)
  return `${s.slice(0, head)}
... [${s.length - CLIP} characters omitted] ...
${s.slice(s.length - (CLIP - head))}`
}

function clipDeep(v: unknown): unknown {
  if (typeof v === 'string') return clipText(v)
  if (Array.isArray(v)) return v.map(clipDeep)
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, clipDeep(x)]))
  return v
}

export function slimTranscript(items: ChatItem[]): ChatItem[] {
  return items.map((i) => {
    if (i.kind !== 'tool') return i
    // images a tool returned are shown live; they are the bulk of the file (54 of 61 MB in one chat) and are not kept
    const { images: _images, ...rest } = i
    return {
      ...rest,
      command: rest.command && clipText(rest.command),
      output: rest.output && clipText(rest.output),
      input: rest.input === undefined ? undefined : clipDeep(rest.input),
      diffs: rest.diffs?.map((d) => ({ ...d, diff: clipText(d.diff) }))
    }
  })
}

export function transcriptFile(sessionId: string): string {
  return file(path.join('transcripts', `${sessionId}.json`))
}

export function loadTranscript(sessionId: string): ChatItem[] {
  return slimTranscript(readJson<ChatItem[]>(path.join('transcripts', `${sessionId}.json`), []))
}

const generations = new Map<string, number>()

/** Changes with every synchronous save of a transcript: an asynchronous save that started earlier must not overwrite it. */
export function transcriptGeneration(sessionId: string): number {
  return generations.get(sessionId) ?? 0
}

export function saveTranscript(sessionId: string, items: ChatItem[]): void {
  generations.set(sessionId, transcriptGeneration(sessionId) + 1)
  writeJson(path.join('transcripts', `${sessionId}.json`), slimTranscript(items), false)
}

/** Shrinks transcripts written before clipping existed; files under 1 MB are left alone, so it is cheap to run at every start. */
export async function shrinkTranscripts(): Promise<void> {
  const dir = file('transcripts')
  let names: string[]
  try {
    names = fs.readdirSync(dir)
  } catch {
    return
  }
  for (const name of names) {
    if (!name.endsWith('.json')) continue
    try {
      const target = path.join(dir, name)
      if (fs.statSync(target).size < 1024 * 1024) continue
      const items = slimTranscript(JSON.parse(fs.readFileSync(target, 'utf8')) as ChatItem[])
      writeJson(path.join('transcripts', name), items, false)
    } catch {
      // a file that cannot be read stays as it is
    }
    await new Promise((r) => setTimeout(r, 50))
  }
}

/** Engine files of temporary chats still to wipe: ids only, no content. A crash leaves them here for the next start. */
export interface TempLeftover {
  profileId: string
  engineSessionId: string
  cwd: string
}

export function loadTempLeftovers(): TempLeftover[] {
  return readJson<TempLeftover[]>('temp-leftovers.json', [])
}

export function saveTempLeftovers(list: TempLeftover[]): void {
  if (list.length) writeJson('temp-leftovers.json', list)
  else fs.rmSync(file('temp-leftovers.json'), { force: true })
}

export function removeTranscript(sessionId: string): void {
  fs.rmSync(file(path.join('transcripts', `${sessionId}.json`)), { force: true })
}

// ---------------------------------------------------------------------------
// Usage and limits
// ---------------------------------------------------------------------------
export function appendUsage(u: TurnUsage): void {
  fs.mkdirSync(dataDir(), { recursive: true })
  fs.appendFileSync(file('usage.jsonl'), JSON.stringify(u) + '\n')
}

export function loadUsage(sinceMs: number): TurnUsage[] {
  let text = ''
  try {
    text = fs.readFileSync(file('usage.jsonl'), 'utf8')
  } catch {
    return []
  }
  const out: TurnUsage[] = []
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    try {
      const u = JSON.parse(line) as TurnUsage
      // older Codex lines had the cached tokens inside inputTokens as well
      if (u.engine === 'codex' && !u.netInput) u.inputTokens = Math.max(0, u.inputTokens - u.cacheReadTokens - u.cacheWriteTokens)
      if (u.ts >= sinceMs) out.push(u)
    } catch {
      // skip a torn line
    }
  }
  return out
}

export function loadLimits(): Record<string, RateLimitSnapshot> {
  return readJson<Record<string, RateLimitSnapshot>>('limits.json', {})
}

/**
 * Merges into the stored snapshot instead of replacing it: a failed read (empty windows) or a
 * live stream event (only the window it hit) must not wipe the other windows. A window whose
 * reset time has passed is dropped, since its old percentage no longer applies.
 */
/** "5 ore" -> 5, "7 zile" -> 168: how long a limit window lasts, for ordering them. */
export function windowHours(label: string): number {
  const n = Number(/\d+/.exec(label)?.[0] || 1)
  if (/săpt|week/i.test(label)) return n * 168
  return /zi|day/i.test(label) ? n * 24 : n
}

export function saveLimit(snapshot: RateLimitSnapshot): RateLimitSnapshot {
  const all = loadLimits()
  const prev = all[snapshot.profileId]
  const now = Date.now()
  const byLabel = new Map((prev?.windows || []).filter((w) => !w.resetsAt || w.resetsAt > now).map((w) => [w.label, w]))
  for (const w of snapshot.windows) byLabel.set(w.label, w)
  const merged: RateLimitSnapshot = {
    ...snapshot,
    // every account in the same order, shortest window first (5 ore above 7 zile), whatever order the engine reports
    windows: [...byLabel.values()].sort((a, b) => windowHours(a.label) - windowHours(b.label)),
    // keep the plan note when a failed read only says "could not read"
    note: snapshot.windows.length || !prev?.note ? snapshot.note : snapshot.note && byLabel.size ? prev.note : snapshot.note
  }
  all[snapshot.profileId] = merged
  writeJson('limits.json', all)
  return merged
}

// ---------------------------------------------------------------------------
// Scheduled tasks
// ---------------------------------------------------------------------------
export function loadSchedules(): ScheduledTask[] {
  return readJson<ScheduledTask[]>('schedules.json', [])
}

export function saveSchedules(tasks: ScheduledTask[]): void {
  writeJson('schedules.json', tasks)
}

// ---------------------------------------------------------------------------
// Model watch: the models each source listed so far, and the last good scores.json
// ---------------------------------------------------------------------------
export function loadModelWatch(): SeenFile {
  return readJson<SeenFile>('model-watch.json', {})
}

export function saveModelWatch(seen: SeenFile): void {
  writeJson('model-watch.json', seen, false)
}

export function loadScoresCache(): unknown {
  return readJson<unknown>('scores-cache.json', undefined)
}

export function saveScoresCache(raw: unknown): void {
  writeJson('scores-cache.json', raw, false)
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------
export function loadSettings(): AppSettings {
  return { ...readJson<Partial<AppSettings>>('settings.json', {}), dataDir: dataDir() }
}

export function saveSettings(patch: Partial<AppSettings>): AppSettings {
  const { dataDir: _computed, ...next } = { ...loadSettings(), ...patch }
  writeJson('settings.json', next)
  return { ...next, dataDir: dataDir() }
}
