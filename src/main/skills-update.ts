// Brings one skill up to date from its git source. The folder it replaces is always kept whole as a backup first.
import fs from 'fs'
import path from 'path'
import { hashSkillDir, skillFiles, skippedNames, writeSource } from './skill-fs'
import { git, isDirty, shallowClone, treeOf } from './skills-git'
import { validGitUrl, validRef, validSubdir } from './skills-parse'
import { readState, writeState, type Entry } from './skills-scan'
import { dataDir } from './store'

const MAX_FILES = 5000
const MAX_BYTES = 50 * 1024 * 1024
const busy = new Set<string>()

/** Copies the skill folder (without .git and node_modules, like the hash) to Jolty's data folder. */
export function backup(id: string, dir: string): string {
  const dest = path.join(dataDir(), 'skill-backups', `${id.replace(/[^\w.-]/g, '-')}-${Date.now()}`)
  fs.mkdirSync(path.dirname(dest), { recursive: true })
  fs.cpSync(dir, dest, { recursive: true, dereference: false, filter: (s) => !skippedNames.has(path.basename(s)) })
  return dest
}

/** Where a throwaway path must stay: inside root, after links are resolved. */
function inside(root: string, p: string): boolean {
  const rel = path.relative(fs.realpathSync.native(root), fs.realpathSync.native(p))
  return !rel.startsWith('..') && !path.isAbsolute(rel)
}

function remember(e: Entry, all: Entry[], rev: string, commit: string | undefined, tree: string | undefined): void {
  const real = e.real!
  const hash = hashSkillDir(real)
  const st = readState()
  st[real] = { status: 'ok', against: rev, latest: rev, checkedAt: Date.now(), installedHash: hash, ...(tree ? { tree } : {}) }
  writeState(st)
  if (!commit) return
  // every id that shows this same folder (a mirror in another home) takes the new commit too
  for (const o of all) if (o.real === real && o.info.source.kind === 'git') writeSource(o.info.id, { ...o.info.source, commit })
}

/** Throws Error(code): managed-by-plugin, no-folder, no-source, bad-source, has-local-changes, no-skill-md-at-source, too-big, busy. */
export async function updateEntry(e: Entry, all: Entry[]): Promise<void> {
  const src = e.info.source
  if (e.info.linked || e.managed) throw new Error('managed-by-plugin')
  if (!e.real) throw new Error('no-folder')
  if (src.kind !== 'git') throw new Error('no-source')
  if (!validGitUrl(src.url, true) || (src.ref !== undefined && !validRef(src.ref)) || (src.subdir !== undefined && !validSubdir(src.subdir))) throw new Error('bad-source')
  const real = e.real
  if (busy.has(real)) throw new Error('busy')
  busy.add(real)
  try {
    if (e.repo) {
      if (await isDirty(real)) throw new Error('has-local-changes')
      backup(e.info.id, real)
      await git(['pull', '--ff-only'], e.repo.top, 120_000)
      const commit = (await git(['rev-parse', 'HEAD'], e.repo.top)).trim()
      remember(e, all, commit, undefined, undefined)
      return
    }
    const clone = await shallowClone(src.url, src.ref)
    try {
      const from = src.subdir ? path.join(clone.repo, src.subdir) : clone.repo
      if (!fs.existsSync(path.join(from, 'SKILL.md')) || !inside(clone.repo, from)) throw new Error('no-skill-md-at-source')
      const files = skillFiles(from)
      const bytes = files.reduce((n, f) => n + fs.statSync(path.join(from, f)).size, 0)
      if (files.length > MAX_FILES || bytes > MAX_BYTES) throw new Error('too-big')
      const parent = path.dirname(real)
      const folder = path.basename(real)
      const stage = path.join(parent, `.${folder}.jolty-new`)
      const old = path.join(parent, `.${folder}.jolty-old`)
      fs.rmSync(stage, { recursive: true, force: true })
      fs.rmSync(old, { recursive: true, force: true })
      try {
        for (const f of files) {
          fs.mkdirSync(path.dirname(path.join(stage, f)), { recursive: true })
          fs.copyFileSync(path.join(from, f), path.join(stage, f))
        }
        backup(e.info.id, real)
        fs.renameSync(real, old)
        try {
          fs.renameSync(stage, real)
        } catch (err) {
          fs.renameSync(old, real)
          throw err
        }
      } finally {
        fs.rmSync(stage, { recursive: true, force: true })
      }
      // ponytail: a locked old folder stays as a dot folder next to the skill (scan skips it), remove by hand if it ever happens
      fs.rmSync(old, { recursive: true, force: true, maxRetries: 3 })
      const tree = src.subdir ? await treeOf(clone.repo, src.subdir) : undefined
      writeSource(e.info.id, { ...src, commit: clone.commit })
      remember(e, all, tree ?? clone.commit, clone.commit, tree)
    } finally {
      fs.rmSync(clone.root, { recursive: true, force: true })
    }
  } finally {
    busy.delete(real)
  }
}
