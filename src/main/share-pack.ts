// Export and import of share packs (contract: src/shared/skills.ts). A pack received from someone else is
// untrusted data: nothing in it is run, its paths are checked before use, and an import keeps a backup of
// everything it replaces (share-pack-apply.ts).
import { app, BrowserWindow, dialog } from 'electron'
import { randomUUID } from 'crypto'
import fs from 'fs'
import path from 'path'
import type { ExportRequest, ExportResult, ImportDecision, ImportItem, ImportPreview, ImportResult, PackItem, PersonalKind } from '@shared/skills'
import { hashSkillDir, skillFiles, skillRoot } from './skill-fs'
import { loadProfiles, loadSchedules, loadSettings } from './store'
import { BACKUP_LIMITS, decodePack, encodePack, EXT, FORMAT, hashFiles, LIMITS, PackError, safeLabel, safeRel, safeSegment, sha256, versionNewer, type DecodedPack, type PackEntry } from './share-pack-format'
import {
  canon,
  claudeMcpServers,
  commandsRoot,
  exportMcp,
  exportProfile,
  exportSchedule,
  exportSettings,
  HOMES,
  INSTRUCTIONS,
  localItems,
  type LocalItem,
  type ScheduleShape,
  type Skipped
} from './share-pack-local'
import { adultIn, personalOf, redactFiles } from './share-pack-personal'
import { applyPlan, undoImport, type Planned, type Target } from './share-pack-apply'

export { undoImport as undo }

const PREVIEW_TTL = 30 * 60 * 1000
/** JSON parts are small; a bigger one is not something Jolty wrote */
const JSON_MAX = 1024 * 1024

/** Scripts and binaries: a skill with one of these can run code once a model uses it. */
const CODE_EXT = /\.(py|pyw|sh|bash|zsh|fish|ps1|psm1|bat|cmd|vbs|js|mjs|cjs|ts|mts|cts|rb|pl|php|lua|exe|dll|so|dylib|com|scr|msi|jar|bin|node|wasm|applescript|ahk)$/i

interface Held {
  pack: DecodedPack
  /** stable for the same pack file */
  packId: string
  plan: Planned[]
  expires: number
}

const previews = new Map<string, Held>()

function sweep(): void {
  const now = Date.now()
  for (const [id, h] of previews) if (h.expires < now) previews.delete(id)
}

const appVersion = (): string => {
  try {
    return app?.getVersion?.() || process.env.npm_package_version || '0.0.0'
  } catch {
    return '0.0.0'
  }
}

const focused = (): BrowserWindow | undefined => BrowserWindow?.getFocusedWindow?.() ?? undefined

// ---------------------------------------------------------------- export

// the scan reads every file, so its answer is kept until the item changes
const personalCache = new Map<string, { sig: string; kinds: PersonalKind[]; adult: boolean }>()
function scanFor(it: LocalItem): { kinds: PersonalKind[]; adult: boolean } {
  const sig = `${it.bytes}:${it.modifiedAt}`
  // an item over the pack limit cannot be exported, so reading all of it just to scan it is wasted
  if (it.bytes > LIMITS.total) return { kinds: [], adult: false }
  const hit = personalCache.get(it.key)
  if (hit?.sig === sig) return hit
  let kinds: PersonalKind[] = []
  let adult = false
  try {
    const files = it.collect().files
    kinds = personalOf(files)
    adult = Boolean(adultIn(files, it.label))
  } catch {
    // unreadable files are left out of the pack anyway
  }
  personalCache.set(it.key, { sig, kinds, adult })
  return { kinds, adult }
}

export function items(): Promise<PackItem[]> {
  return Promise.resolve(
    localItems().map((it) => {
      const { kinds: personal, adult } = scanFor(it)
      return { key: it.key, part: it.part, label: it.label, ...(it.detail ? { detail: it.detail } : {}), bytes: it.bytes, ...(personal.length ? { personal } : {}), ...(adult ? { adult } : {}) }
    })
  )
}

/** What exportPack returns, plus the files that were left out (credentials, too big) for the page to mention. */
export type ExportDone = ExportResult & { skipped: Skipped[] }

function checkRequest(req: unknown): ExportRequest {
  const r = (req && typeof req === 'object' ? req : {}) as Partial<ExportRequest>
  if (!Array.isArray(r.keys) || !r.keys.length || r.keys.length > LIMITS.items || !r.keys.every((k) => typeof k === 'string')) throw new PackError('bad-request')
  const name = typeof r.name === 'string' ? r.name.trim() : ''
  if (!safeLabel(name)) throw new PackError('bad-name')
  const author = typeof r.author === 'string' && r.author.trim() ? r.author.trim() : undefined
  if (author !== undefined && !safeLabel(author, 100)) throw new PackError('bad-author')
  const note = typeof r.note === 'string' && r.note.trim() ? r.note.trim() : undefined
  if (note !== undefined && note.length > 4000) throw new PackError('bad-note')
  return { keys: [...new Set(r.keys)], name, author, note }
}

/**
 * Builds the pack in memory. `full` is a backup of the user's own setup: nothing is redacted or left out for looking
 * like a secret, MCP servers are included and the limits are the backup ones (the caller encrypts the result).
 */
export function buildPack(request: ExportRequest, full = false): { buf: Buffer; result: Omit<ExportDone, 'file'> } {
  const req = checkRequest(request)
  const limits = full ? BACKUP_LIMITS : LIMITS
  const local = new Map(localItems(full).map((i) => [i.key, i]))
  const entries: PackEntry[] = []
  const skipped: Skipped[] = []
  const redacted = new Set<string>()
  let total = 0
  let count = 0
  for (const key of req.keys) {
    const it = local.get(key)
    if (!it) throw new PackError('unknown-key')
    const got = it.collect(full)
    skipped.push(...got.skipped)
    // adult content stays on this PC: the whole item is left out (a backup of your own keeps everything)
    const adult = full ? undefined : adultIn(got.files, it.label)
    if (adult) {
      skipped.push({ key, file: adult, reason: 'adult' })
      continue
    }
    // personal information is replaced by placeholders; the rest of the item travels
    if (!full) {
      const red = redactFiles(got.files)
      got.files = red.files
      if (red.kinds.length) redacted.add(key)
    }
    // a skill without its SKILL.md (left out as a secret) would not load anywhere
    if (!got.files.length || (it.part === 'skills' && !got.files.some((f) => f.path === 'SKILL.md'))) continue
    for (const f of got.files) total += f.data.length
    count += got.files.length
    if (total > limits.total) throw new PackError('too-large')
    if (count > limits.files) throw new PackError('too-many-files')
    entries.push({ key, part: it.part, name: it.name, label: it.label, detail: it.detail, modifiedAt: it.modifiedAt, files: got.files })
  }
  if (!entries.length) throw new PackError('nothing-to-export')
  const buf = encodePack({ format: FORMAT, app: appVersion(), name: req.name, author: req.author, note: req.note, createdAt: Date.now() }, entries)
  return { buf, result: { items: entries.length, bytes: buf.length, skipped, redacted: redacted.size } }
}

/** Builds the pack and writes it to `file` (no dialog; the testable half of exportPack). */
export function writePack(request: ExportRequest, file: string): ExportDone {
  const { buf, result } = buildPack(request)
  const tmp = `${file}.${process.pid}.tmp`
  fs.writeFileSync(tmp, buf)
  fs.renameSync(tmp, file)
  return { file, ...result }
}

/** Every key a full backup takes (all that this PC can put in a pack, plus the MCP servers). */
export const backupKeys = (): string[] => localItems(true).map((i) => i.key)

const fileBase = (name: string): string => name.replace(/[<>:"/\\|?*\u0000-\u001f]+/g, ' ').replace(/[. ]+$/, '').trim().slice(0, 80) || 'jolty'

export async function exportPack(req: ExportRequest): Promise<ExportDone | null> {
  const clean = checkRequest(req)
  const opts = {
    defaultPath: path.join(app.getPath('documents'), fileBase(clean.name) + EXT),
    filters: [{ name: 'Jolty', extensions: [EXT.slice(1)] }]
  }
  const win = focused()
  const res = win ? await dialog.showSaveDialog(win, opts) : await dialog.showSaveDialog(opts)
  if (res.canceled || !res.filePath) return null
  return writePack(clean, res.filePath)
}

// ---------------------------------------------------------------- import preview

const parseJson = (e: PackEntry): unknown => {
  if (e.files.length !== 1 || e.files[0].path !== 'item.json' || e.files[0].data.length > JSON_MAX) return undefined
  try {
    return JSON.parse(e.files[0].data.toString('utf8'))
  } catch {
    return undefined
  }
}

const singleMd = (e: PackEntry): boolean => e.files.length === 1 && e.files[0].path === 'item.md'

const lstat = (p: string): fs.Stats | undefined => {
  try {
    return fs.lstatSync(p)
  } catch {
    return undefined
  }
}

/** Where an item of the pack would go here, or undefined when the item is not acceptable. */
function targetOf(e: PackEntry): Target | undefined {
  switch (e.part) {
    case 'skills': {
      const [home, folder, ...rest] = e.name.split('/')
      if (rest.length || !HOMES.includes(home as never) || !safeSegment(folder) || !e.files.some((f) => f.path === 'SKILL.md')) return undefined
      const root = skillRoot(home as never)
      return { kind: 'dir', root, path: path.join(root, folder), home: home as never, folder }
    }
    case 'commands': {
      if (!safeRel(e.name) || !e.name.toLowerCase().endsWith('.md') || !singleMd(e)) return undefined
      const root = commandsRoot()
      return { kind: 'file', root, path: path.join(root, ...e.name.split('/')) }
    }
    case 'instructions': {
      const ins = Object.prototype.hasOwnProperty.call(INSTRUCTIONS, e.name) ? INSTRUCTIONS[e.name] : undefined
      if (!ins || !singleMd(e)) return undefined
      const file = ins.file()
      return { kind: 'file', root: path.dirname(file), path: file, instructions: true }
    }
    case 'settings': {
      const shape = exportSettings(parseJson(e))
      return e.name === 'app' && Object.keys(shape).length ? { kind: 'settings', shape } : undefined
    }
    case 'profiles': {
      const shape = exportProfile(parseJson(e))
      return shape && shape.name === e.name ? { kind: 'profile', shape } : undefined
    }
    case 'schedules': {
      const shape = exportSchedule(parseJson(e), [])
      return shape && shape.name === e.name ? { kind: 'schedule', shape } : undefined
    }
    case 'mcp': {
      const shape = exportMcp(parseJson(e))
      return shape && shape.name === e.name ? { kind: 'mcp', shape } : undefined
    }
  }
  return undefined
}

const fileStats = (dir: string, rels: string[]): { bytes: number; modifiedAt: number } => {
  let bytes = 0
  let modifiedAt = 0
  for (const r of rels) {
    const st = lstat(path.join(dir, r))
    if (st) {
      bytes += st.size
      modifiedAt = Math.max(modifiedAt, st.mtimeMs)
    }
  }
  return { bytes, modifiedAt }
}

/** Compares one item of the pack with what is here. */
function compare(e: PackEntry, t: Target): Pick<ImportItem, 'state' | 'existing'> {
  const timed = (equal: boolean, here: { bytes: number; modifiedAt: number }): Pick<ImportItem, 'state' | 'existing'> => {
    if (equal) return { state: 'same', existing: here }
    // within 2 s counts as the same time (file systems round differently)
    const d = e.modifiedAt - here.modifiedAt
    return { state: !e.modifiedAt || !here.modifiedAt || Math.abs(d) < 2000 ? 'different' : d > 0 ? 'newer' : 'older', existing: here }
  }
  if (t.kind === 'dir') {
    if (!lstat(t.path)) return { state: 'new' }
    let rels: string[] = []
    try {
      rels = skillFiles(t.path)
    } catch {
      return { state: 'different', existing: { bytes: 0, modifiedAt: 0 } }
    }
    return timed(hashSkillDir(t.path) === hashFiles(e.files), fileStats(t.path, rels))
  }
  if (t.kind === 'file') {
    const st = lstat(t.path)
    if (!st) return { state: 'new' }
    let same = false
    try {
      same = fs.readFileSync(t.path).equals(e.files[0].data)
    } catch {
      // unreadable: different
    }
    return timed(same, { bytes: st.size, modifiedAt: st.mtimeMs })
  }
  const json = (local: unknown, mine: unknown): Pick<ImportItem, 'state' | 'existing'> => {
    const bytes = Buffer.byteLength(JSON.stringify(local))
    return canon(local) === canon(mine) ? { state: 'same', existing: { bytes, modifiedAt: 0 } } : { state: 'different', existing: { bytes, modifiedAt: 0 } }
  }
  if (t.kind === 'settings') {
    const here = exportSettings(loadSettings()) as Record<string, unknown>
    const shape = t.shape as Record<string, unknown>
    const local: Record<string, unknown> = {}
    for (const k of Object.keys(shape)) local[k] = here[k]
    return json(local, shape)
  }
  if (t.kind === 'profile') {
    const p = loadProfiles().find((x) => x.name === t.shape.name)
    if (!p) return { state: 'new' }
    // colors are handed out per PC, so they never decide "same"
    const noColor = (s: unknown): unknown => ({ ...(s as object), color: undefined })
    return json(noColor(exportProfile({ ...p, isDefaultDir: false }) ?? p), noColor(t.shape))
  }
  if (t.kind === 'mcp') {
    const here = claudeMcpServers()[t.shape.name]
    if (here === undefined) return { state: 'new' }
    const bytes = Buffer.byteLength(JSON.stringify(here))
    return { state: canon(exportMcp({ name: t.shape.name, config: here })?.config) === canon(t.shape.config) ? 'same' : 'different', existing: { bytes, modifiedAt: 0 } }
  }
  const profiles = loadProfiles()
  const task = loadSchedules().find((x) => x.name === t.shape.name)
  if (!task) return { state: 'new' }
  const local = exportSchedule(task, profiles)
  // the profile is matched by name on import; a missing name on either side is not a difference
  const strip = (s: ScheduleShape | undefined): Partial<ScheduleShape> | undefined => (s ? { ...s, profileName: undefined } : s)
  return json(strip(local), strip(t.shape))
}

function risksOf(e: PackEntry, t: Target): ImportItem['risks'] {
  if (t.kind === 'dir') return e.files.some((f) => CODE_EXT.test(f.path) || /(^|\/)bin\//.test(f.path) || f.data.subarray(0, 2).toString('latin1') === '#!') ? ['runs-code'] : []
  if (t.kind === 'file') return t.instructions ? ['changes-instructions'] : []
  if (t.kind === 'settings') return ['changes-settings']
  if (t.kind === 'profile') return ['adds-account']
  // an MCP server is a program that starts with Claude Code, or an address that gets the chat's data
  if (t.kind === 'mcp') return ['runs-code']
  // a scheduled prompt runs on its own, with the permissions it names
  return ['runs-code']
}

/** Reads a pack file and compares it with what is here (no dialog; the testable half of openPack). */
export function openPackFile(file: string): ImportPreview {
  const st = lstat(file)
  if (!st || !st.isFile()) throw new PackError('not-a-file')
  if (st.size > LIMITS.packFile) throw new PackError('too-large')
  return openPackBuffer(fs.readFileSync(file))
}

/** `backup`: the user's own backup (bigger limits, MCP servers allowed); a pack from someone else is never read that way. */
export function openPackBuffer(buf: Buffer, backup = false): ImportPreview {
  sweep()
  const pack = decodePack(buf, backup)
  const warnings = new Set(pack.warnings)
  if (versionNewer(pack.meta.app, appVersion())) warnings.add('newer-app-version')
  const plan: Planned[] = []
  for (const e of pack.entries) {
    const t = targetOf(e)
    if (!t) {
      warnings.add('invalid-items')
      continue
    }
    const { state, existing } = compare(e, t)
    const protectedPart = e.part === 'instructions' || e.part === 'settings'
    const item: ImportItem = {
      key: e.key,
      part: e.part,
      label: e.label,
      ...(e.detail ? { detail: e.detail } : {}),
      bytes: e.files.reduce((n, f) => n + f.data.length, 0),
      state,
      ...(existing ? { existing } : {}),
      risks: risksOf(e, t),
      suggested: state === 'new' && !protectedPart ? 'overwrite' : 'skip'
    }
    plan.push({ entry: e, item, target: t })
  }
  const previewId = randomUUID()
  previews.set(previewId, { pack, packId: sha256(buf).slice(0, 16), plan, expires: Date.now() + PREVIEW_TTL })
  return {
    previewId,
    name: pack.meta.name,
    ...(pack.meta.author ? { author: pack.meta.author } : {}),
    ...(pack.meta.note ? { note: pack.meta.note } : {}),
    createdAt: pack.meta.createdAt,
    appVersion: pack.meta.app,
    items: plan.map((p) => p.item),
    warnings: [...warnings]
  }
}

export async function openPack(file?: string): Promise<ImportPreview | null> {
  if (file !== undefined && (typeof file !== 'string' || !path.isAbsolute(file))) throw new PackError('bad-file')
  if (!file) {
    const opts = { properties: ['openFile' as const], filters: [{ name: 'Jolty', extensions: [EXT.slice(1)] }], defaultPath: app.getPath('downloads') }
    const win = focused()
    const res = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
    if (res.canceled || !res.filePaths[0]) return null
    file = res.filePaths[0]
  }
  return openPackFile(file)
}

// ---------------------------------------------------------------- apply, discard

export function apply(previewId: string, decisions: Record<string, ImportDecision>): Promise<ImportResult> {
  sweep()
  const held = previews.get(previewId)
  if (!held) return Promise.reject(new PackError('preview-expired'))
  const clean: Record<string, ImportDecision> = {}
  if (decisions && typeof decisions === 'object')
    for (const [k, v] of Object.entries(decisions)) if (v === 'skip' || v === 'overwrite' || v === 'copy') clean[k] = v
  previews.delete(previewId)
  return Promise.resolve(applyPlan(held.plan, clean, { name: held.pack.meta.name, author: held.pack.meta.author, id: held.packId }))
}

export function discard(previewId: string): Promise<void> {
  previews.delete(previewId)
  return Promise.resolve()
}
