// Reads every skill folder under the three roots into SkillInfo, offline: frontmatter, problems, size, hash (cached
// by the newest mtime), where it came from and the status the last check left on disk.
import fs from 'fs'
import os from 'os'
import path from 'path'
import type { SkillHome, SkillInfo, SkillProblem, SkillSource, SkillStatus } from '@shared/skills'
import { hashSkillDir, readSources, skillRoot, skippedNames } from './skill-fs'
import { clearRepoCache, isDirty, localRepo, type LocalRepo } from './skills-git'
import { parseFrontmatter, validGitUrl, validSubdir } from './skills-parse'
import { dataDir } from './store'

export const HOMES: SkillHome[] = ['claude', 'codex', 'agents']
/** Which homes one agent loads together: a name clash only matters inside one of these. */
const VIEWS: SkillHome[][] = [['claude'], ['codex', 'agents']]
const MAX_FILES = 5000
const MAX_MD = 100 * 1024
const MAX_BYTES = 50 * 1024 * 1024
const DESC_MAX = 1024
const BLOCKING: SkillProblem[] = ['no-skill-md', 'dead-link', 'bad-frontmatter', 'no-description']

/** What a check left behind, per real folder (mirrors share it). */
export interface CheckState {
  status?: Extract<SkillStatus, 'ok' | 'outdated' | 'unknown'>
  /** the local commit or tree the check compared */
  against?: string
  /** what the source had */
  latest?: string
  checkedAt?: number
  /** hash right after install or update from the source, for 'modified' on copied skills */
  installedHash?: string
  /** tree id of the skill folder at the installed commit */
  tree?: string
}

export interface Entry {
  info: SkillInfo
  /** the real folder (links resolved); undefined for a dead link */
  real?: string
  /** a local clone holds this folder */
  repo?: LocalRepo
  /** installed by a Claude plugin: the plugin updates it */
  managed: boolean
  /** tree id from the skills lock file, when that is where it came from */
  lockTree?: string
}

const json = <T>(name: string, fallback: T): T => {
  try {
    return JSON.parse(fs.readFileSync(path.join(dataDir(), name), 'utf8')) as T
  } catch {
    return fallback
  }
}
const save = (name: string, v: unknown): void => {
  fs.mkdirSync(dataDir(), { recursive: true })
  fs.writeFileSync(path.join(dataDir(), name), JSON.stringify(v))
}
export const readState = (): Record<string, CheckState> => json('skill-status.json', {})
export const writeState = (s: Record<string, CheckState>): void => save('skill-status.json', s)

interface HashRow {
  sig: string
  hash: string
  files: number
  bytes: number
  modifiedAt: number
  dirtyFor?: string
  dirty?: boolean
}

const readHome = <T>(...p: string[]): T | undefined => {
  try {
    return JSON.parse(fs.readFileSync(path.join(os.homedir(), ...p), 'utf8')) as T
  } catch {
    return undefined
  }
}

/** files, bytes and newest mtime of a skill folder, seeing exactly what hashSkillDir sees, stopping at MAX_FILES. */
function walk(dir: string): { files: number; bytes: number; modifiedAt: number; capped: boolean } {
  const r = { files: 0, bytes: 0, modifiedAt: 0, capped: false }
  const go = (d: string): void => {
    let list: fs.Dirent[]
    try {
      list = fs.readdirSync(d, { withFileTypes: true })
      r.modifiedAt = Math.max(r.modifiedAt, fs.statSync(d).mtimeMs)
    } catch {
      return
    }
    for (const e of list) {
      if (r.capped || skippedNames.has(e.name)) continue
      const p = path.join(d, e.name)
      if (e.isDirectory()) go(p)
      else if (e.isFile()) {
        if (++r.files > MAX_FILES) r.capped = true
        try {
          const st = fs.statSync(p)
          r.bytes += st.size
          r.modifiedAt = Math.max(r.modifiedAt, st.mtimeMs)
        } catch {
          /* vanished mid-walk */
        }
      }
    }
  }
  go(dir)
  return r
}

type Plugins = { plugins?: Record<string, { gitCommitSha?: string }[]> }
type Markets = Record<string, { source?: { source?: string; repo?: string; url?: string } }>
type Lock = { skills?: Record<string, { sourceUrl?: string; sourceType?: string; skillPath?: string; skillFolderHash?: string }> }

const PLUGIN_PATH = /[\\/]plugins[\\/](cache|marketplaces)[\\/]([^\\/]+)(?:[\\/]([^\\/]+))?/i

/** A folder under ~/.claude/plugins (or a link pointing there) belongs to a plugin; its source is the marketplace repo. */
function pluginSource(p: string, plugins: Plugins, markets: Markets): SkillSource | undefined {
  const m = PLUGIN_PATH.exec(p)
  if (!m) return undefined
  const src = markets[m[2]]?.source
  const url = src?.source === 'github' && src.repo ? `https://github.com/${src.repo}.git` : src?.url
  if (!validGitUrl(url, true)) return { kind: 'local' }
  const commit = m[1] === 'cache' ? plugins.plugins?.[`${m[3]}@${m[2]}`]?.find((x) => x.gitCommitSha)?.gitCommitSha : undefined
  return { kind: 'git', url, ...(commit ? { commit } : {}) }
}

function statusOf(e: Entry, st: CheckState | undefined, dirty: boolean): { status: SkillStatus; latest?: string } {
  const { info } = e
  if (info.problems.some((p) => BLOCKING.includes(p))) return { status: 'broken' }
  const src = info.source
  if (src.kind === 'pack') return { status: info.hash === src.hash ? 'ok' : 'modified' }
  if (src.kind !== 'git') return { status: 'unknown' }
  if (e.repo ? dirty : !!st?.installedHash && st.installedHash !== info.hash) return { status: 'modified' }
  const current = currentRev(e, st)
  if (!st?.checkedAt || !current) return { status: 'unknown' }
  if (current === st.latest) return { status: 'ok' }
  if (current !== st.against || !st.status) return { status: 'unknown' }
  return { status: st.status, ...(st.status === 'outdated' && st.latest ? { latest: st.latest.slice(0, 7) } : {}) }
}

/** What a check compares with the remote: the clone's commit, else the installed tree, else the installed commit. */
export function currentRev(e: Entry, st: CheckState | undefined): string | undefined {
  if (e.repo) return e.repo.commit
  const src = e.info.source
  if (src.kind !== 'git') return undefined
  return treeMode(e, st) ? (st?.tree ?? e.lockTree) : src.commit
}

/** Copied from a subfolder of a repo and its tree id is known: compare trees, so commits elsewhere in the repo do not count. */
export const treeMode = (e: Entry, st: CheckState | undefined): boolean => !e.repo && e.info.source.kind === 'git' && !!e.info.source.subdir && !!(st?.tree ?? e.lockTree)

export async function scan(): Promise<Entry[]> {
  clearRepoCache()
  const sources = readSources()
  const state = readState()
  const cache = json<Record<string, HashRow>>('skill-hash-cache.json', {})
  const nextCache: Record<string, HashRow> = {}
  const plugins = readHome<Plugins>('.claude', 'plugins', 'installed_plugins.json') ?? {}
  const markets = readHome<Markets>('.claude', 'plugins', 'known_marketplaces.json') ?? {}
  const lock = readHome<Lock>('.agents', '.skill-lock.json') ?? {}
  let agentsReal = ''
  try {
    agentsReal = fs.realpathSync.native(skillRoot('agents'))
  } catch {
    /* no ~/.agents/skills */
  }
  const out: Entry[] = []
  for (const home of HOMES) {
    const root = skillRoot(home)
    let names: string[] = []
    try {
      names = fs.readdirSync(root)
    } catch {
      continue
    }
    for (const folder of names.sort()) {
      // dot folders (Codex's .system) belong to the agent itself
      if (folder.startsWith('.')) continue
      const dir = path.join(root, folder)
      let linked = false
      let real: string | undefined
      try {
        const lst = fs.lstatSync(dir)
        linked = lst.isSymbolicLink()
        if (!linked && !lst.isDirectory()) continue
        real = fs.realpathSync.native(dir)
        if (!fs.statSync(real).isDirectory()) continue
      } catch {
        if (!linked) continue
      }
      const problems: SkillProblem[] = []
      let name = folder
      let description = ''
      let modifiedAt = 0
      let row: HashRow | undefined
      let mdBytes = 0
      if (!real) {
        problems.push('dead-link')
        try {
          modifiedAt = fs.lstatSync(dir).mtimeMs
        } catch {
          /* gone */
        }
      } else {
        let md: string | undefined
        try {
          md = fs.readFileSync(path.join(real, 'SKILL.md'), 'utf8')
          mdBytes = Buffer.byteLength(md)
        } catch {
          problems.push('no-skill-md')
        }
        if (md !== undefined) {
          const fm = parseFrontmatter(md)
          if (fm.bad) problems.push('bad-frontmatter')
          if (!fm.name) problems.push('no-name')
          if (!fm.description) problems.push('no-description')
          if (fm.name && fm.name !== folder && fm.name !== path.basename(real)) problems.push('name-differs-from-folder')
          name = fm.name || folder
          description = (fm.description ?? '').slice(0, DESC_MAX)
        }
        const w = walk(real)
        const sig = `${w.files}:${w.bytes}:${w.modifiedAt}`
        const old = cache[real]
        row = old?.sig === sig ? old : { sig, hash: w.capped ? '' : hashSkillDir(real), files: w.files, bytes: w.bytes, modifiedAt: w.modifiedAt }
        nextCache[real] = row
        modifiedAt = w.modifiedAt
        if (w.capped || mdBytes > MAX_MD || w.bytes > MAX_BYTES) problems.push('too-big')
      }
      const id = `${home}:${folder}`
      const where = real ?? (linked ? safeReadlink(dir) : dir)
      const plugin = pluginSource(where, plugins, markets)
      const repo = real ? localRepo(real) : undefined
      const lockRow = real && agentsReal && path.dirname(real) === agentsReal ? lock.skills?.[path.basename(real)] : undefined
      const lockSub = lockRow?.skillPath ? path.posix.dirname(lockRow.skillPath.replace(/\\/g, '/')) : undefined
      let source: SkillSource = sources[id] ?? plugin ?? { kind: 'local' }
      if (!sources[id] && !plugin) {
        if (repo && validGitUrl(repo.url, true)) {
          const sub = path.relative(repo.top, real!).replace(/\\/g, '/')
          source = { kind: 'git', url: repo.url, ...(repo.branch ? { ref: repo.branch } : {}), ...(sub ? { subdir: sub } : {}), ...(repo.commit ? { commit: repo.commit } : {}) }
        } else if (lockRow && validGitUrl(lockRow.sourceUrl)) {
          source = { kind: 'git', url: lockRow.sourceUrl, ...(lockSub && validSubdir(lockSub) ? { subdir: lockSub } : {}) }
        }
      }
      const clone = source.kind === 'git' && !!repo && !!repo.url
      out.push({
        info: { id, name, description, home, dir, linked, files: row?.files ?? 0, bytes: row?.bytes ?? 0, hash: row?.hash ?? '', modifiedAt, source, status: 'unknown', problems },
        real,
        repo: clone ? repo : undefined,
        managed: !!plugin,
        lockTree: !sources[id] ? lockRow?.skillFolderHash : undefined
      })
    }
  }
  // the same name twice in what one agent loads, from two different real folders (a mirror of one folder is fine)
  for (const view of VIEWS) {
    const byName = new Map<string, Set<string>>()
    const inView = out.filter((e) => view.includes(e.info.home) && e.real)
    for (const e of inView) byName.set(e.info.name, (byName.get(e.info.name) ?? new Set()).add(e.real!))
    for (const e of inView) if (byName.get(e.info.name)!.size > 1) e.info.problems.push('duplicate-name')
  }
  // uncommitted changes in clones, cached until the files or the commit change
  const dirtyWork = out.filter((e) => e.repo && e.real && nextCache[e.real])
  let i = 0
  await Promise.all(
    Array.from({ length: 4 }, async () => {
      while (i < dirtyWork.length) {
        const e = dirtyWork[i++]
        const row = nextCache[e.real!]
        const key = `${row.sig}:${e.repo!.commit}`
        if (row.dirtyFor === key) continue
        row.dirty = await isDirty(e.real!).catch(() => false)
        row.dirtyFor = key
      }
    })
  )
  for (const e of out) {
    const st = e.real ? state[e.real] : undefined
    Object.assign(e.info, statusOf(e, st, !!(e.real && nextCache[e.real]?.dirty)), st?.checkedAt ? { checkedAt: st.checkedAt } : {})
  }
  if (JSON.stringify(nextCache) !== JSON.stringify(cache)) save('skill-hash-cache.json', nextCache)
  return out
}

function safeReadlink(p: string): string {
  try {
    return fs.readlinkSync(p)
  } catch {
    return p
  }
}
