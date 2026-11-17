// Restore, second half: runs when Jolty starts, before anything reads the data folder. Moves a complete download
// from the staging folder in place. Whatever it replaces is moved to restore-previous-<time>/ first, nothing is
// deleted. Folders of the old PC (home, data folder) are mapped onto this PC's, in Jolty's own files and in the
// names Claude gives its project folders; chats whose project folder is missing here are listed, not dropped.
import fs from 'fs'
import path from 'path'
import { COMPLETE, stagedPath, type Staged } from './vault-read'
import type { Origin } from './vault-format'

export const STAGING = 'restore-pending'
export const PACK_FILE = 'restore-pack.joltypack'
export const REPORT = 'restore-report.json'
/** Jolty's own files that hold paths of the PC they were written on */
const PATH_FILES = ['sessions.json', 'profiles.json', 'settings.json', 'schedules.json']

export interface RestoreReport {
  at: number
  /** when the restored version was made, and on which PC */
  versionAt: number
  host: string
  files: number
  /** where the replaced files went */
  previous?: string
  /** project folders of restored chats that do not exist on this PC */
  missing: string[]
}

/** Claude names a project's folder after its path with every other character than a letter or digit as '-'. */
export const claudeDirName = (p: string): string => p.replace(/[^a-zA-Z0-9]/g, '-')

/** Rewrites a path of the old PC as the same place on this one; anything else stays as it is. */
export function pathMapper(origin: Origin, home: string, data: string): (s: string) => string {
  const ci = origin.platform === 'win32'
  const sep = path.sep
  const pairs = [
    [origin.data, data],
    [origin.home, home]
  ].filter(([from, to]) => from && to && from !== to)
  const norm = (s: string): string => (ci ? s.toLowerCase() : s)
  return (s) => {
    for (const [from, to] of pairs) {
      const next = s.charAt(from.length)
      if (norm(s.slice(0, from.length)) === norm(from) && (next === '' || next === '/' || next === '\\')) {
        const rest = s.slice(from.length)
        return to + (origin.platform === process.platform ? rest : rest.replace(/[\\/]/g, sep))
      }
    }
    return s
  }
}

function mapStrings(v: unknown, map: (s: string) => string): unknown {
  if (typeof v === 'string') return map(v)
  if (Array.isArray(v)) return v.map((x) => mapStrings(x, map))
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [map(k), mapStrings(x, map)]))
  return v
}

/** Moves a file, across disks too (copy then delete). */
function move(from: string, to: string): void {
  fs.mkdirSync(path.dirname(to), { recursive: true })
  try {
    fs.renameSync(from, to)
  } catch {
    fs.copyFileSync(from, to)
    fs.unlinkSync(from)
  }
}

/** Removes the staging folder: only files and folders Jolty wrote, never through a link. */
function removeTree(dir: string): void {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isSymbolicLink()) fs.unlinkSync(p)
    else if (e.isDirectory()) removeTree(p)
    else fs.unlinkSync(p)
  }
  fs.rmdirSync(dir)
}

/** Where a file of the vault goes on this PC. */
function targetOf(p: string, staged: Staged, home: string, data: string): string {
  const parts = p.split('/')
  const enc = (s: string): string => claudeDirName(s)
  // .../projects/<old encoded path>/... becomes this PC's encoded path, in a profile folder or in ~/.claude
  const i = parts.indexOf('projects')
  if (i > 0 && parts[i + 1] && (parts[0] === 'home' ? parts[1] === '.claude' : parts[1] === 'profiles')) {
    const from = [enc(staged.origin.data), enc(staged.origin.home)].find((x) => x && parts[i + 1].toLowerCase().startsWith(x.toLowerCase()))
    if (from) parts[i + 1] = (from === enc(staged.origin.data) ? enc(data) : enc(home)) + parts[i + 1].slice(from.length)
  }
  if (parts[0] === 'data') return path.join(data, ...parts.slice(1))
  if (parts[0] === 'home') return path.join(home, ...parts.slice(1))
  return path.join(data, PACK_FILE)
}

/** Applies a complete download, if there is one. Returns what it did, or null. */
export function applyPendingRestore(data: string, home: string): RestoreReport | null {
  const staging = path.join(data, STAGING)
  let staged: Staged
  try {
    staged = JSON.parse(fs.readFileSync(path.join(staging, COMPLETE), 'utf8')) as Staged
    if (staged.v !== 2 || !Array.isArray(staged.files)) return null
  } catch {
    return null
  }
  const previous = path.join(data, `restore-previous-${new Date().toISOString().replace(/[:.]/g, '-')}`)
  let kept = false
  for (const f of staged.files) {
    const src = stagedPath(staging, f.p)
    if (!fs.existsSync(src)) continue
    const to = targetOf(f.p, staged, home, data)
    const st = fs.lstatSync(to, { throwIfNoEntry: false })
    if (st) {
      if (!st.isFile()) continue
      const rel = f.p.startsWith('pack/') ? PACK_FILE : f.p
      move(to, path.join(previous, ...rel.split('/')))
      kept = true
    }
    move(src, to)
  }

  const map = pathMapper(staged.origin, home, data)
  // Claude's own state per profile is keyed by project path too
  const claudeStates = staged.files.filter((f) => f.p.endsWith('/.claude.json')).map((f) => targetOf(f.p, staged, home, data))
  for (const file of [...PATH_FILES.map((n) => path.join(data, n)), ...claudeStates]) {
    try {
      const before = fs.readFileSync(file, 'utf8')
      const after = JSON.stringify(mapStrings(JSON.parse(before), map), null, 2)
      if (after !== JSON.stringify(JSON.parse(before), null, 2)) fs.writeFileSync(file, after)
    } catch {
      // missing or unreadable: Jolty starts with defaults for it as usual
    }
  }

  const missing = new Set<string>()
  try {
    const sessions = JSON.parse(fs.readFileSync(path.join(data, 'sessions.json'), 'utf8')) as { cwd?: string }[]
    for (const s of Array.isArray(sessions) ? sessions : []) if (typeof s.cwd === 'string' && s.cwd && !fs.existsSync(s.cwd)) missing.add(s.cwd)
  } catch {
    // no chats
  }
  const report: RestoreReport = { at: Date.now(), versionAt: staged.at, host: staged.origin.host, files: staged.files.length, ...(kept ? { previous } : {}), missing: [...missing].slice(0, 200) }
  fs.writeFileSync(path.join(data, REPORT), JSON.stringify(report, null, 2))
  removeTree(staging)
  return report
}
