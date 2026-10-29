// What this PC can put in a share pack, and the safe, secret-free shape of each part. The same shapes check what a
// pack brings in (share-pack.ts), so a field that is not listed here can neither leave nor enter.
import fs from 'fs'
import os from 'os'
import path from 'path'
import type { PackItem, PackPart, SkillHome } from '@shared/skills'
import type { AppSettings, AuthKind, EngineKind, PermissionMode, Profile, TokenPrice } from '@shared/types'
import { checkSchedule, TASK_MODES, type ScheduledTask, type TaskSchedule } from '@shared/schedule'
import { skillFiles, skillRoot } from './skill-fs'
import { dataDir, loadProfiles, loadSchedules, loadSettings } from './store'
import { LIMITS, safeLabel, safeRel, safeSegment, type PackFile } from './share-pack-format'

export const HOMES: SkillHome[] = ['claude', 'codex', 'agents']

/**
 * Settings that mean the same on any PC and hold nothing private. Everything else stays home: paths, profile ids,
 * trusted programs (computerTrusted), browser profile, last used folders and models.
 */
export const SETTINGS_KEYS = [
  'reduceMotion',
  'lowPower',
  'modelAdvice',
  'mascot',
  'mascotSounds',
  'mascotSize',
  'notifyDone',
  'notifyAttention',
  'notifySound',
  'language',
  'browserOverlay',
  'browserMode',
  'siteTrust',
  'computerHuman',
  'computerPaste',
  'protectSecretFiles',
  'learningLoop',
  'childMode',
  'childBrowser',
  'childAutoModel',
  'childOpus',
  'childOpusEffort'
] as const satisfies readonly (keyof AppSettings)[]

const SETTING_VALUES: Record<(typeof SETTINGS_KEYS)[number], (v: unknown) => boolean> = {
  reduceMotion: isBool,
  lowPower: (v) => ['auto', 'on', 'off'].includes(v as string),
  modelAdvice: isBool,
  mascot: isBool,
  mascotSounds: isBool,
  mascotSize: (v) => ['small', 'normal', 'big'].includes(v as string),
  notifyDone: isBool,
  notifyAttention: isBool,
  notifySound: isBool,
  language: (v) => typeof v === 'string' && /^[a-z]{2,3}(-[A-Za-z]{2,4})?$/.test(v),
  browserOverlay: isBool,
  browserMode: (v) => ['jolty', 'auto', 'pick', 'own'].includes(v as string),
  siteTrust: (v) => ['ask', 'site', 'free'].includes(v as string),
  computerHuman: (v) => ['max', 'normal', 'fast'].includes(v as string),
  computerPaste: isBool,
  protectSecretFiles: isBool,
  learningLoop: isBool,
  childMode: (v) => ['auto', 'ask', 'autoEdit', 'plan', 'project', 'full'].includes(v as string),
  childBrowser: isBool,
  childAutoModel: isBool,
  childOpus: isBool,
  childOpusEffort: (v) => typeof v === 'string' && /^[a-z]{1,20}$/.test(v)
}

function isBool(v: unknown): boolean {
  return typeof v === 'boolean'
}

/** Files that hold credentials by their name; never packed, whatever folder they are in. */
const SECRET_NAME =
  /(^\.env(\..*)?$)|(\.(pem|key|p12|pfx|kdbx|keystore|jks)$)|(^(id_rsa|id_dsa|id_ecdsa|id_ed25519)(\.pub)?$)|(^(credentials|secrets?|tokens?|auth|cookies?)\.json$)|(^\.(npmrc|netrc|pypirc|git-credentials)$)/i

/** Content that looks like a live key or private key. */
const SECRET_TEXT = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\bsk-(ant-|proj-)?[A-Za-z0-9_-]{24,}/,
  /\bgh[pousr]_[A-Za-z0-9]{30,}/,
  /\bgithub_pat_[A-Za-z0-9_]{30,}/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/,
  /\bAIza[0-9A-Za-z_-]{35}\b/,
  /\bhf_[A-Za-z0-9]{30,}/,
  /\bglpat-[A-Za-z0-9_-]{20,}/
]

export const looksSecret = (data: Buffer): boolean => {
  const s = data.toString('latin1')
  return SECRET_TEXT.some((r) => r.test(s))
}

export interface Skipped {
  key: string
  file: string
  reason: 'secret-file' | 'looks-like-secret' | 'too-large' | 'personal' | 'adult'
}

export interface LocalItem extends PackItem {
  name: string
  modifiedAt: number
  /** `full`: a backup of your own, so credentials and personal text are kept (it is encrypted before it leaves) */
  collect(full?: boolean): { files: PackFile[]; skipped: Skipped[] }
}

const home = (...p: string[]): string => path.join(os.homedir(), ...p)
export const commandsRoot = (): string => home('.claude', 'commands')
export const INSTRUCTIONS: Record<string, { file: () => string; label: string }> = {
  claude: { file: () => home('.claude', 'CLAUDE.md'), label: 'CLAUDE.md' },
  codex: { file: () => home('.codex', 'AGENTS.md'), label: 'AGENTS.md' }
}

const lstat = (p: string): fs.Stats | undefined => {
  try {
    return fs.lstatSync(p)
  } catch {
    return undefined
  }
}

/** Reads files of a folder (or one file) into pack files, leaving out credentials and oversized files. */
function readFiles(key: string, dir: string, rels: string[], own = false): { files: PackFile[]; skipped: Skipped[] } {
  const files: PackFile[] = []
  const skipped: Skipped[] = []
  for (const rel of rels) {
    const base = rel.split('/').pop()!
    if (!own && SECRET_NAME.test(base)) {
      skipped.push({ key, file: rel, reason: 'secret-file' })
      continue
    }
    if (!safeRel(rel)) continue
    const full = path.join(dir, rel)
    const st = fs.statSync(full)
    if (st.size > LIMITS.file) {
      skipped.push({ key, file: rel, reason: 'too-large' })
      continue
    }
    const data = fs.readFileSync(full)
    if (!own && looksSecret(data)) {
      skipped.push({ key, file: rel, reason: 'looks-like-secret' })
      continue
    }
    files.push({ path: rel, data, modifiedAt: st.mtimeMs })
  }
  return { files, skipped }
}

const statsOf = (dir: string, rels: string[]): { bytes: number; modifiedAt: number } => {
  let bytes = 0
  let modifiedAt = 0
  for (const r of rels) {
    const st = lstat(path.join(dir, r))
    if (!st) continue
    bytes += st.size
    modifiedAt = Math.max(modifiedAt, st.mtimeMs)
  }
  return { bytes, modifiedAt }
}

const jsonItem = (part: PackPart, name: string, label: string, value: unknown, modifiedAt: number, detail?: string): LocalItem => {
  const data = Buffer.from(JSON.stringify(value, null, 2))
  return {
    key: `${part}:${name}`,
    part,
    name,
    label,
    ...(detail ? { detail } : {}),
    bytes: data.length,
    modifiedAt,
    collect: () => ({ files: [{ path: 'item.json', data, modifiedAt }], skipped: [] })
  }
}

const mtime = (file: string): number => lstat(file)?.mtimeMs ?? 0

/** Skill folders that can be packed: every folder with a SKILL.md, except links in ~/.agents/skills (plugin mirrors). */
export function skillDirs(): { home: SkillHome; folder: string; dir: string }[] {
  const out: { home: SkillHome; folder: string; dir: string }[] = []
  for (const h of HOMES) {
    const root = skillRoot(h)
    let names: string[] = []
    try {
      names = fs.readdirSync(root)
    } catch {
      continue
    }
    for (const folder of names) {
      const dir = path.join(root, folder)
      const st = lstat(dir)
      if (!st || !safeSegment(folder)) continue
      if (st.isSymbolicLink() && h === 'agents') continue
      if (!fs.existsSync(path.join(dir, 'SKILL.md'))) continue
      out.push({ home: h, folder, dir })
    }
  }
  return out
}

export function localItems(full = false): LocalItem[] {
  const out: LocalItem[] = []

  for (const s of skillDirs()) {
    let rels: string[]
    try {
      rels = skillFiles(s.dir)
    } catch {
      continue
    }
    const key = `skills:${s.home}/${s.folder}`
    out.push({ key, part: 'skills', name: `${s.home}/${s.folder}`, label: s.folder, detail: `~/.${s.home}/skills`, ...statsOf(s.dir, rels), collect: (full) => readFiles(key, s.dir, rels, full) })
  }

  let cmds: string[] = []
  try {
    cmds = skillFiles(commandsRoot()).filter((f) => f.toLowerCase().endsWith('.md'))
  } catch {
    // no commands folder
  }
  for (const rel of cmds) {
    const key = `commands:${rel}`
    // inside the pack a command is always item.md: its path here is the key
    out.push({
      key,
      part: 'commands',
      name: rel,
      label: rel.replace(/\.md$/i, ''),
      detail: '~/.claude/commands',
      ...statsOf(commandsRoot(), [rel]),
      collect: (full) => {
        const r = readFiles(key, commandsRoot(), [rel], full)
        return { files: r.files.map((f) => ({ ...f, path: 'item.md' })), skipped: r.skipped }
      }
    })
  }

  for (const [name, ins] of Object.entries(INSTRUCTIONS)) {
    const file = ins.file()
    const st = lstat(file)
    if (!st) continue
    const key = `instructions:${name}`
    out.push({
      key,
      part: 'instructions',
      name,
      label: ins.label,
      detail: name === 'claude' ? '~/.claude' : '~/.codex',
      bytes: st.size,
      modifiedAt: st.mtimeMs,
      collect: (full) => {
        const r = readFiles(key, path.dirname(file), [path.basename(file)], full)
        return { files: r.files.map((f) => ({ ...f, path: 'item.md' })), skipped: r.skipped }
      }
    })
  }

  const settings = exportSettings(loadSettings())
  if (Object.keys(settings).length) out.push(jsonItem('settings', 'app', 'settings', settings, mtime(path.join(dataDir(), 'settings.json'))))

  const profiles = loadProfiles()
  for (const p of profiles) {
    const e = exportProfile(p)
    if (e && !out.some((x) => x.key === `profiles:${e.name}`)) out.push(jsonItem('profiles', e.name, e.name, e, 0, e.engine))
  }
  for (const t of loadSchedules()) {
    const e = exportSchedule(t, profiles)
    if (e && !out.some((x) => x.key === `schedules:${e.name}`)) {
      const item = jsonItem('schedules', e.name, e.name, e, t.createdAt)
      // a prompt can hold a pasted key: the task is listed but not packed (a full backup keeps it)
      if (!full && looksSecret(Buffer.from(e.prompt))) item.collect = () => ({ files: [], skipped: [{ key: item.key, file: 'item.json', reason: 'looks-like-secret' }] })
      out.push(item)
    }
  }
  if (full)
    for (const [name, config] of Object.entries(claudeMcpServers())) {
      const e = exportMcp({ name, config })
      if (e) out.push(jsonItem('mcp', e.name, e.name, e, mtime(claudeJson()), e.config.type || (e.config.url ? 'http' : 'stdio')))
    }
  return out
}

// ---------------------------------------------------------------- MCP servers (user level, in ~/.claude.json)

export const claudeJson = (): string => home('.claude.json')

/** The user-level servers of ~/.claude.json; nothing else of that file (login, history, projects) is ever read out. */
export function claudeMcpServers(): Record<string, unknown> {
  try {
    const v = (JSON.parse(fs.readFileSync(claudeJson(), 'utf8')) as { mcpServers?: unknown }).mcpServers
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

export interface McpConfig {
  type?: 'stdio' | 'sse' | 'http'
  command?: string
  args?: string[]
  env?: Record<string, string>
  url?: string
  headers?: Record<string, string>
}
export interface McpShape {
  name: string
  config: McpConfig
}

const strMap = (v: unknown): Record<string, string> | undefined | null => {
  if (v === undefined) return undefined
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null
  const e = Object.entries(v)
  return e.length <= 200 && e.every(([k, x]) => k.length <= 200 && typeof x === 'string' && x.length <= 20000) ? (v as Record<string, string>) : null
}

/** One MCP server with only the fields Claude Code knows; anything else is dropped, a wrong kind of value rejects it. */
export function exportMcp(v: unknown): McpShape | undefined {
  const x = (v && typeof v === 'object' ? v : {}) as { name?: unknown; config?: unknown }
  const c = (x.config && typeof x.config === 'object' ? x.config : {}) as Record<string, unknown>
  if (!safeLabel(x.name, 100) || (c.type !== undefined && c.type !== 'stdio' && c.type !== 'sse' && c.type !== 'http')) return undefined
  const out: McpConfig = {}
  if (c.type !== undefined) out.type = c.type as McpConfig['type']
  if (c.command !== undefined) {
    if (typeof c.command !== 'string' || !c.command || c.command.length > 1000) return undefined
    out.command = c.command
  }
  if (c.url !== undefined) {
    if (typeof c.url !== 'string' || !c.url || c.url.length > 2000) return undefined
    out.url = c.url
  }
  // a server with neither a program nor an address would not start anywhere
  if (!out.command && !out.url) return undefined
  if (c.args !== undefined) {
    if (!Array.isArray(c.args) || c.args.length > 200 || !c.args.every((a) => typeof a === 'string' && a.length <= 20000)) return undefined
    out.args = c.args as string[]
  }
  const env = strMap(c.env)
  const headers = strMap(c.headers)
  if (env === null || headers === null) return undefined
  if (env) out.env = env
  if (headers) out.headers = headers
  return { name: x.name as string, config: out }
}

// ---------------------------------------------------------------- the secret-free shapes

export type SettingsShape = Partial<Pick<AppSettings, (typeof SETTINGS_KEYS)[number]>>

/** Only listed keys with a value of the expected kind; used for what leaves and for what a pack brings. */
export function exportSettings(s: unknown): SettingsShape {
  const src = (s && typeof s === 'object' ? s : {}) as Record<string, unknown>
  const out: Record<string, unknown> = {}
  for (const k of SETTINGS_KEYS) if (src[k] !== undefined && SETTING_VALUES[k](src[k])) out[k] = src[k]
  return out as SettingsShape
}

export interface ProfileShape {
  name: string
  engine: EngineKind
  auth: AuthKind
  baseUrl?: string
  models?: string[]
  vision?: boolean
  local?: boolean
  price?: TokenPrice
  color?: string
}

/** A base URL without user, password, query or fragment (a key can hide in any of them). */
export function cleanUrl(u: unknown): string | undefined {
  if (typeof u !== 'string' || u.length > 500 || looksSecret(Buffer.from(u))) return undefined
  try {
    const x = new URL(u)
    if (x.protocol !== 'https:' && x.protocol !== 'http:') return undefined
    return `${x.protocol}//${x.host}${x.pathname}`.replace(/\/$/, '')
  } catch {
    return undefined
  }
}

const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v < 1e6

/**
 * Name, engine, models, endpoint and color. No id, no keys, no cookies, no login state. The profiles on the
 * default folders (the main accounts) and the ACP agents (local config) are not packed: they mean nothing elsewhere.
 */
export function exportProfile(p: unknown): ProfileShape | undefined {
  const x = (p && typeof p === 'object' ? p : {}) as Partial<Profile>
  if (x.isDefaultDir) return undefined
  if (!safeLabel(x.name, 100) || (x.engine !== 'claude' && x.engine !== 'codex')) return undefined
  if (x.auth !== 'subscription' && x.auth !== 'apiKey' && x.auth !== 'endpoint') return undefined
  const out: ProfileShape = { name: x.name as string, engine: x.engine, auth: x.auth }
  const url = cleanUrl(x.baseUrl)
  if (url) out.baseUrl = url
  if (Array.isArray(x.models)) {
    const models = x.models.filter((m) => typeof m === 'string' && /^[\w.:/@+-]{1,120}$/.test(m)).slice(0, 50)
    if (models.length) out.models = models
  }
  if (typeof x.vision === 'boolean') out.vision = x.vision
  if (typeof x.local === 'boolean') out.local = x.local
  if (x.price && num(x.price.input) && num(x.price.output)) out.price = { input: x.price.input, output: x.price.output, ...(num(x.price.cacheRead) ? { cacheRead: x.price.cacheRead } : {}) }
  if (typeof x.color === 'string' && /^(#[0-9a-f]{3,8}|hsl\([\d. %]+\))$/i.test(x.color)) out.color = x.color
  return out
}

export interface ScheduleShape {
  name: string
  prompt: string
  model?: string
  effort?: string
  permissionMode: PermissionMode
  schedule: TaskSchedule
  /** the profile it ran on, by name: ids differ between PCs */
  profileName?: string
}

/** A task without its folder, profile id or run history. */
export function exportSchedule(t: unknown, profiles: Profile[]): ScheduleShape | undefined {
  const x = (t && typeof t === 'object' ? t : {}) as Partial<ScheduledTask> & { profileName?: unknown }
  if (!safeLabel(x.name, 200) || typeof x.prompt !== 'string' || !x.prompt.trim() || x.prompt.length > 100_000) return undefined
  if (!TASK_MODES.includes(x.permissionMode as PermissionMode)) return undefined
  let schedule: TaskSchedule
  try {
    schedule = checkSchedule(x.schedule)
  } catch {
    return undefined
  }
  const out: ScheduleShape = { name: x.name as string, prompt: x.prompt, permissionMode: x.permissionMode as PermissionMode, schedule }
  if (typeof x.model === 'string' && /^[\w.:/@+-]{1,120}$/.test(x.model)) out.model = x.model
  if (typeof x.effort === 'string' && /^[a-z]{1,20}$/.test(x.effort)) out.effort = x.effort
  const pn = x.profileId ? profiles.find((p) => p.id === x.profileId)?.name : x.profileName
  if (safeLabel(pn, 100)) out.profileName = pn as string
  return out
}

/** JSON with sorted keys, so two equal values compare equal. */
export function canon(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canon).join(',')}]`
  if (v && typeof v === 'object')
    return `{${Object.keys(v)
      .sort()
      .filter((k) => (v as Record<string, unknown>)[k] !== undefined)
      .map((k) => `${JSON.stringify(k)}:${canon((v as Record<string, unknown>)[k])}`)
      .join(',')}}`
  return JSON.stringify(v)
}
