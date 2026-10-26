// Applying an import and undoing it. Before anything here is replaced it is copied to
// dataDir()/pack-backups/<importId>/ with a manifest; every write goes to a temporary name next to the target and
// is swapped in, so an error never leaves half a skill. Paths are checked to stay inside the known roots.
import { randomBytes, randomUUID } from 'crypto'
import fs from 'fs'
import os from 'os'
import path from 'path'
import type { ImportDecision, ImportItem, ImportResult, SkillHome, SkillSource } from '@shared/skills'
import type { Profile } from '@shared/types'
import type { ScheduledTask } from '@shared/schedule'
import { hashSkillDir, readSources, skillRoot, writeSource } from './skill-fs'
import { dataDir, freeColor, loadProfiles, loadSchedules, loadSettings, saveProfiles, saveSchedules, saveSettings } from './store'
import { PackError, sha256, type PackEntry, type PackFile } from './share-pack-format'
import { claudeJson, commandsRoot, HOMES, type McpShape, type ProfileShape, type ScheduleShape, type SettingsShape } from './share-pack-local'

export type Target =
  | { kind: 'dir'; root: string; path: string; home: SkillHome; folder: string }
  | { kind: 'file'; root: string; path: string; instructions?: boolean }
  | { kind: 'settings'; shape: SettingsShape }
  | { kind: 'profile'; shape: ProfileShape }
  | { kind: 'schedule'; shape: ScheduleShape }
  | { kind: 'mcp'; shape: McpShape }

export interface Planned {
  entry: PackEntry
  item: ImportItem
  target: Target
}

type Done =
  | { kind: 'dir'; action: 'replaced' | 'created'; target: string; backup?: string; hash?: string; sourceId: string; prevSource?: SkillSource }
  | { kind: 'file'; action: 'replaced' | 'created'; target: string; backup?: string; hash?: string }
  | { kind: 'settings'; prev: Record<string, unknown> }
  | { kind: 'profile'; action: 'replaced' | 'created'; id: string; prev?: Profile; secrets?: Record<string, unknown> }
  | { kind: 'schedule'; action: 'replaced' | 'created'; id: string; prev?: ScheduledTask }
  | { kind: 'mcp'; name: string; prev: unknown }

interface Manifest {
  importId: string
  packName: string
  createdAt: number
  done: (Done & { key: string })[]
  undone?: boolean
}

const backupsRoot = (): string => path.join(dataDir(), 'pack-backups')
const ID = /^[a-z0-9]{8,16}-[a-f0-9]{12}$/

const same = (a: string, b: string): boolean => (process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b)

/** `p` is strictly inside `root` after normalization. */
function inside(root: string, p: string): boolean {
  const r = path.resolve(root)
  const x = path.resolve(p)
  return !same(r, x) && same(x.slice(0, r.length + 1), r + path.sep)
}

const lstat = (p: string): fs.Stats | undefined => {
  try {
    return fs.lstatSync(p)
  } catch {
    return undefined
  }
}

/** No link or junction between root and target (exclusive of root): a write cannot be redirected elsewhere. */
function assertPlain(root: string, target: string): void {
  if (!inside(root, target)) throw new PackError('outside-root')
  const parts = path.relative(path.resolve(root), path.resolve(target)).split(path.sep)
  let cur = path.resolve(root)
  for (const seg of parts) {
    cur = path.join(cur, seg)
    if (lstat(cur)?.isSymbolicLink()) throw new PackError('target-is-link')
  }
}

/** Where undo may touch things: the skill roots, the commands folder, Markdown files in ~/.claude and ~/.codex. */
function knownTarget(p: string): boolean {
  const r = path.resolve(p)
  if ([...HOMES.map(skillRoot), commandsRoot()].some((root) => inside(root, r))) return true
  const parent = path.dirname(r)
  return [path.join(os.homedir(), '.claude'), path.join(os.homedir(), '.codex')].some((d) => same(path.resolve(d), parent)) && /\.md$/i.test(r)
}

const tmpName = (target: string, tag: string): string => `${target}.jpk-${randomBytes(4).toString('hex')}.${tag}`

/** Writes the files into a new folder next to `target` and swaps it in; the old folder is removed only after. */
function writeDir(root: string, target: string, files: PackFile[]): void {
  fs.mkdirSync(root, { recursive: true })
  assertPlain(root, target)
  const tmp = tmpName(target, 'tmp')
  try {
    fs.mkdirSync(tmp)
    for (const f of files) {
      const dest = path.resolve(tmp, ...f.path.split('/'))
      if (!inside(tmp, dest)) throw new PackError('outside-root')
      fs.mkdirSync(path.dirname(dest), { recursive: true })
      fs.writeFileSync(dest, f.data, { flag: 'wx' })
    }
    swapIn(tmp, target, true)
  } catch (e) {
    fs.rmSync(tmp, { recursive: true, force: true })
    throw e
  }
}

/** Moves `tmp` onto `target`; an existing target is renamed aside first and put back if the move fails. */
function swapIn(tmp: string, target: string, dir: boolean): void {
  if (!lstat(target)) return fs.renameSync(tmp, target)
  if (!dir) return fs.renameSync(tmp, target)
  const old = tmpName(target, 'old')
  fs.renameSync(target, old)
  try {
    fs.renameSync(tmp, target)
  } catch (e) {
    fs.renameSync(old, target)
    throw e
  }
  fs.rmSync(old, { recursive: true, force: true })
}

function writeFile(root: string, target: string, data: Buffer): void {
  fs.mkdirSync(root, { recursive: true })
  assertPlain(root, target)
  fs.mkdirSync(path.dirname(target), { recursive: true })
  assertPlain(root, target)
  const tmp = tmpName(target, 'tmp')
  try {
    fs.writeFileSync(tmp, data, { flag: 'wx' })
    swapIn(tmp, target, false)
  } catch (e) {
    fs.rmSync(tmp, { force: true })
    throw e
  }
}

/** `<name>-<suffix>`, then `-2`, `-3` ... until `taken` says no. */
function freeName(base: string, suffix: string, taken: (n: string) => boolean, ext = ''): string {
  for (let i = 1; i < 1000; i++) {
    const n = `${base}-${suffix}${i > 1 ? `-${i}` : ''}${ext}`
    if (!taken(n)) return n
  }
  throw new PackError('no-free-name')
}

const slug = (author?: string): string => (author || '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32) || 'imported'

/** A copied skill gets its folder name in SKILL.md too, so two skills do not answer to the same name. */
function renameSkill(files: PackFile[], name: string): PackFile[] {
  return files.map((f) =>
    f.path === 'SKILL.md' ? { ...f, data: Buffer.from(f.data.toString('utf8').replace(/^(---\r?\n[\s\S]*?^name:[ \t]*).*$/m, `$1${name}`)) } : f
  )
}

// ---------------------------------------------------------------- secrets.json, moved aside (never read or decoded)

const secretsFile = (): string => path.join(dataDir(), 'secrets.json')
const readSecretsRaw = (): Record<string, unknown> => {
  try {
    return JSON.parse(fs.readFileSync(secretsFile(), 'utf8')) as Record<string, unknown>
  } catch {
    return {}
  }
}
const writeSecretsRaw = (all: Record<string, unknown>): void => {
  const tmp = `${secretsFile()}.${process.pid}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(all, null, 2))
  fs.renameSync(tmp, secretsFile())
}

// ---------------------------------------------------------------- ~/.claude.json, only its mcpServers

/** Sets (or, with undefined, removes) one user-level MCP server and leaves every other key of the file as it is. */
function setMcp(name: string, config: unknown): void {
  const file = claudeJson()
  let cfg: Record<string, unknown> = {}
  const st = lstat(file)
  if (st) {
    if (st.isSymbolicLink() || !st.isFile()) throw new PackError('target-is-link')
    cfg = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>
  }
  const servers = { ...((cfg.mcpServers as Record<string, unknown>) || {}) }
  if (config === undefined) delete servers[name]
  else servers[name] = config
  const tmp = tmpName(file, 'tmp')
  try {
    fs.writeFileSync(tmp, JSON.stringify({ ...cfg, mcpServers: servers }, null, 2), { flag: 'wx' })
    fs.renameSync(tmp, file)
  } catch (e) {
    fs.rmSync(tmp, { force: true })
    throw e
  }
}

// ---------------------------------------------------------------- apply

export interface PackInfo {
  id: string
  name: string
  author?: string
}

function applyOne(p: Planned, decision: ImportDecision, pack: PackInfo, backupDir: string, n: number): Done {
  const t = p.target
  const backupTo = (): string => {
    const rel = `items/${n}`
    fs.mkdirSync(path.join(backupDir, 'items'), { recursive: true })
    return rel
  }

  if (t.kind === 'dir') {
    let folder = t.folder
    let files = p.entry.files
    if (decision === 'copy') {
      folder = freeName(t.folder, slug(pack.author), (x) => !!lstat(path.join(t.root, x)))
      files = renameSkill(files, folder)
    }
    const target = path.join(t.root, folder)
    const sourceId = `${t.home}:${folder}`
    const st = lstat(target)
    let done: Done
    if (st) {
      if (st.isSymbolicLink()) throw new PackError('target-is-link')
      const rel = backupTo()
      const hash = hashSkillDir(target)
      fs.cpSync(target, path.join(backupDir, rel), { recursive: true, verbatimSymlinks: true })
      done = { kind: 'dir', action: 'replaced', target, backup: rel, hash, sourceId, prevSource: readSources()[sourceId] }
    } else {
      done = { kind: 'dir', action: 'created', target, sourceId }
    }
    writeDir(t.root, target, files)
    writeSource(sourceId, { kind: 'pack', packId: pack.id, packName: pack.name, ...(pack.author ? { author: pack.author } : {}), importedAt: Date.now(), hash: hashSkillDir(target) })
    return done
  }

  if (t.kind === 'file') {
    let target = t.path
    if (decision === 'copy') {
      const ext = path.extname(t.path)
      const base = t.path.slice(0, t.path.length - ext.length)
      target = freeName(base, slug(pack.author), (x) => !!lstat(x), ext)
    }
    const st = lstat(target)
    let done: Done
    if (st) {
      if (st.isSymbolicLink() || !st.isFile()) throw new PackError('target-is-link')
      const rel = backupTo()
      const data = fs.readFileSync(target)
      fs.writeFileSync(path.join(backupDir, rel), data)
      done = { kind: 'file', action: 'replaced', target, backup: rel, hash: sha256(data) }
    } else {
      done = { kind: 'file', action: 'created', target }
    }
    writeFile(t.root, target, p.entry.files[0].data)
    return done
  }

  if (t.kind === 'settings') {
    if (decision === 'copy') throw new PackError('copy-not-supported')
    const here = loadSettings() as unknown as Record<string, unknown>
    const prev: Record<string, unknown> = {}
    for (const k of Object.keys(t.shape)) prev[k] = here[k] ?? null
    saveSettings(t.shape)
    return { kind: 'settings', prev }
  }

  if (t.kind === 'profile') {
    const all = loadProfiles()
    const s = t.shape
    // the main accounts (default folders) and ACP agents are never rewritten by a pack: a clash gets a free name instead
    const existing = decision === 'overwrite' ? all.find((x) => x.name === s.name && !x.isDefaultDir && (x.engine === 'claude' || x.engine === 'codex')) : undefined
    const fields = { engine: s.engine, auth: s.auth, baseUrl: s.baseUrl, models: s.models, vision: s.vision, local: s.local, price: s.price }
    if (existing) {
      const next: Profile = { ...existing, ...fields, color: s.color || existing.color }
      let secrets: Record<string, unknown> | undefined
      // a key must not follow its profile to another endpoint or engine: it is moved into the backup instead
      if (existing.engine !== s.engine || existing.auth !== s.auth || (existing.baseUrl || '') !== (s.baseUrl || '')) {
        const raw = readSecretsRaw()
        const ids = [existing.id, `${existing.id}:cookie`].filter((k) => k in raw)
        if (ids.length) {
          secrets = Object.fromEntries(ids.map((k) => [k, raw[k]]))
          for (const k of ids) delete raw[k]
          writeSecretsRaw(raw)
        }
        next.hasSecret = false
        next.hasCookie = false
      }
      saveProfiles(all.map((x) => (x.id === existing.id ? next : x)))
      return { kind: 'profile', action: 'replaced', id: existing.id, prev: existing, ...(secrets ? { secrets } : {}) }
    }
    const name = decision === 'copy' || all.some((x) => x.name === s.name) ? freeName(s.name, slug(pack.author), (x) => all.some((q) => q.name === x)) : s.name
    const color = s.color && !all.some((x) => x.color?.toLowerCase() === s.color!.toLowerCase()) ? s.color : freeColor(all)
    const profile: Profile = { id: randomUUID(), name, isDefaultDir: false, ...fields, color }
    for (const k of Object.keys(profile) as (keyof Profile)[]) if (profile[k] === undefined) delete profile[k]
    saveProfiles([...all, profile])
    return { kind: 'profile', action: 'created', id: profile.id }
  }

  if (t.kind === 'mcp') {
    const servers = ((): Record<string, unknown> => {
      try {
        return (JSON.parse(fs.readFileSync(claudeJson(), 'utf8')) as { mcpServers?: Record<string, unknown> }).mcpServers || {}
      } catch {
        return {}
      }
    })()
    const name = decision === 'copy' ? freeName(t.shape.name, slug(pack.author), (x) => x in servers) : t.shape.name
    const prev = name in servers ? servers[name] : null
    setMcp(name, t.shape.config)
    return { kind: 'mcp', name, prev }
  }

  const all = loadSchedules()
  const s = t.shape
  const existing = decision === 'overwrite' ? all.find((x) => x.name === s.name) : undefined
  const fields = { prompt: s.prompt, model: s.model, effort: s.effort, permissionMode: s.permissionMode, schedule: s.schedule }
  if (existing) {
    // the folder and profile stay this PC's; the task waits switched off until the user turns it on
    saveSchedules(all.map((x) => (x.id === existing.id ? { ...existing, ...fields, enabled: false } : x)))
    return { kind: 'schedule', action: 'replaced', id: existing.id, prev: existing }
  }
  const profiles = loadProfiles()
  const name = decision === 'copy' || all.some((x) => x.name === s.name) ? freeName(s.name, slug(pack.author), (x) => all.some((q) => q.name === x)) : s.name
  const profileId = profiles.find((x) => x.name === s.profileName)?.id ?? profiles[0]?.id ?? ''
  const task: ScheduledTask = { id: randomUUID(), name, ...fields, profileId, cwd: os.homedir(), enabled: false, createdAt: Date.now() }
  for (const k of Object.keys(task) as (keyof ScheduledTask)[]) if (task[k] === undefined) delete task[k]
  saveSchedules([...all, task])
  return { kind: 'schedule', action: 'created', id: task.id }
}

const writeManifest = (dir: string, m: Manifest): void => {
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, 'manifest.json')
  fs.writeFileSync(`${file}.tmp`, JSON.stringify(m, null, 2))
  fs.renameSync(`${file}.tmp`, file)
}

export function applyPlan(plan: Planned[], decisions: Record<string, ImportDecision>, pack: PackInfo): ImportResult {
  const importId = `${Date.now().toString(36)}-${randomBytes(6).toString('hex')}`
  const dir = path.join(backupsRoot(), importId)
  const manifest: Manifest = { importId, packName: pack.name, createdAt: Date.now(), done: [] }
  writeManifest(dir, manifest)
  const res: ImportResult = { importId, imported: 0, skipped: 0, copied: 0, failed: [] }
  plan.forEach((p, n) => {
    const d = decisions[p.item.key] ?? 'skip'
    if (d === 'skip') {
      res.skipped++
      return
    }
    try {
      const done = applyOne(p, d, pack, dir, n)
      manifest.done.push({ ...done, key: p.item.key })
      // written after every item: an import that stops halfway can still be undone
      writeManifest(dir, manifest)
      if (d === 'copy') res.copied++
      else res.imported++
    } catch (e) {
      res.failed.push({ key: p.item.key, reason: e instanceof PackError ? e.message : (e as NodeJS.ErrnoException).code || 'write-failed' })
    }
  })
  return res
}

// ---------------------------------------------------------------- undo

function undoOne(d: Done, dir: string): void {
  if (d.kind === 'dir' || d.kind === 'file') {
    if (!knownTarget(d.target)) throw new PackError('outside-root')
    const st = lstat(d.target)
    if (st?.isSymbolicLink()) throw new PackError('target-is-link')
    if (d.action === 'created') {
      if (st) fs.rmSync(d.target, { recursive: true, force: true })
      if (d.kind === 'dir') writeSource(d.sourceId, undefined)
      return
    }
    const from = path.join(dir, d.backup || '')
    if (!d.backup || !inside(dir, from) || !lstat(from)) throw new PackError('backup-missing')
    const tmp = tmpName(d.target, 'tmp')
    try {
      if (d.kind === 'dir') fs.cpSync(from, tmp, { recursive: true, verbatimSymlinks: true })
      else fs.copyFileSync(from, tmp)
      swapIn(tmp, d.target, d.kind === 'dir')
    } catch (e) {
      fs.rmSync(tmp, { recursive: true, force: true })
      throw e
    }
    if (d.kind === 'dir') writeSource(d.sourceId, d.prevSource)
    return
  }
  if (d.kind === 'settings') {
    const patch: Record<string, unknown> = {}
    // null marks a key that was not set: saving undefined drops it
    for (const [k, v] of Object.entries(d.prev)) patch[k] = v === null ? undefined : v
    saveSettings(patch)
    return
  }
  if (d.kind === 'profile') {
    const all = loadProfiles()
    if (d.action === 'created') saveProfiles(all.filter((x) => x.id !== d.id))
    else if (d.prev) saveProfiles(all.some((x) => x.id === d.id) ? all.map((x) => (x.id === d.id ? d.prev! : x)) : [...all, d.prev])
    if (d.secrets) writeSecretsRaw({ ...readSecretsRaw(), ...d.secrets })
    return
  }
  if (d.kind === 'mcp') {
    setMcp(d.name, d.prev === null ? undefined : d.prev)
    return
  }
  const all = loadSchedules()
  if (d.action === 'created') saveSchedules(all.filter((x) => x.id !== d.id))
  else if (d.prev) saveSchedules(all.some((x) => x.id === d.id) ? all.map((x) => (x.id === d.id ? d.prev! : x)) : [...all, d.prev])
}

/** Puts back what an import replaced and removes what it created. Running it again does nothing. */
export function undoImport(importId: string): Promise<void> {
  if (typeof importId !== 'string' || !ID.test(importId)) return Promise.reject(new PackError('unknown-import'))
  const dir = path.join(backupsRoot(), importId)
  let m: Manifest
  try {
    m = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8')) as Manifest
  } catch {
    return Promise.reject(new PackError('unknown-import'))
  }
  if (m.undone) return Promise.resolve()
  const errors: string[] = []
  for (const d of [...m.done].reverse()) {
    try {
      undoOne(d, dir)
    } catch (e) {
      errors.push(`${d.key}: ${e instanceof Error ? e.message : String(e)}`)
    }
  }
  if (errors.length) return Promise.reject(new PackError(`undo-incomplete: ${errors.join('; ')}`))
  m.undone = true
  writeManifest(dir, m)
  return Promise.resolve()
}
