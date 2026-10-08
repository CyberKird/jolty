import { app, safeStorage } from 'electron'
import fs from 'fs'
import path from 'path'
import type { AppSettings, ChatItem, Profile, RateLimitSnapshot, SessionMeta, TurnUsage } from '@shared/types'

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

function writeJson(name: string, value: unknown): void {
  const target = file(name)
  fs.mkdirSync(path.dirname(target), { recursive: true })
  const tmp = `${target}.${process.pid}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2))
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

/** Per-profile config folder (CLAUDE_CONFIG_DIR / CODEX_HOME) for non-default profiles. */
export function profileDir(profile: Profile): string | undefined {
  if (profile.isDefaultDir || profile.engine === 'hermes') return undefined
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

export function loadTranscript(sessionId: string): ChatItem[] {
  return readJson<ChatItem[]>(path.join('transcripts', `${sessionId}.json`), [])
}

export function saveTranscript(sessionId: string, items: ChatItem[]): void {
  writeJson(path.join('transcripts', `${sessionId}.json`), items)
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
