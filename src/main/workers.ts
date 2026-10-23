// What a lead session needs to run several sessions at once: a git worktree per session, so two of
// them never write the same file, and one shared notes file per project (the ledger), so a new
// session reads the state of the work instead of exploring the whole codebase again.
import { execFile } from 'child_process'
import { createHash } from 'crypto'
import fs from 'fs'
import path from 'path'
import type { SessionMeta } from '@shared/types'
import { dataDir } from './store'

type Worktree = NonNullable<SessionMeta['worktree']>

function git(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, timeout: 60000, windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (err, out, errOut) => {
      if (err) reject(new Error(String(errOut || err.message).trim()))
      else resolve(String(out).trim())
    })
  })
}

/** The repository folder `cwd` belongs to, or undefined when it is not inside one. */
export async function gitRoot(cwd: string): Promise<string | undefined> {
  try {
    return path.resolve(await git(cwd, ['rev-parse', '--show-toplevel']))
  } catch {
    return undefined
  }
}

const slug = (s: string): string => s.toLowerCase().normalize('NFD').replace(/\p{M}/gu, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 28) || 'task'

/**
 * A new worktree on its own branch, cut from the current commit of `cwd`. It lives in Jolty's data
 * folder, so nothing is left in the user's project folders besides the branch itself.
 * `cwd` of the new session keeps the same place inside the repository as the lead's.
 */
export async function addWorktree(cwd: string, id: string, title: string): Promise<{ cwd: string; info: Worktree } | undefined> {
  const root = await gitRoot(cwd)
  if (!root) return undefined
  const base = await git(root, ['rev-parse', 'HEAD']).catch(() => '')
  // a repository without a commit has nothing to branch from
  if (!base) return undefined
  const branch = `jolty/${slug(title)}-${id.slice(0, 4)}`
  const dir = path.join(dataDir(), 'worktrees', `${slug(path.basename(root))}-${id}`)
  fs.mkdirSync(path.dirname(dir), { recursive: true })
  await git(root, ['worktree', 'add', '-b', branch, dir, base])
  const inside = path.relative(root, cwd)
  return { cwd: inside ? path.join(dir, inside) : dir, info: { path: dir, branch, base, root } }
}

/**
 * Removes a worktree nobody needs: only when it has no changes and no commits of its own.
 * Work that exists nowhere else is kept, on its branch, and `kept` says so.
 */
export async function removeWorktree(w: Worktree): Promise<'removed' | 'kept'> {
  try {
    if (fs.existsSync(w.path)) {
      const dirty = await git(w.path, ['status', '--porcelain'])
      const head = await git(w.path, ['rev-parse', 'HEAD'])
      if (dirty || head !== w.base) return 'kept'
      await git(w.root, ['worktree', 'remove', '--force', w.path])
    } else await git(w.root, ['worktree', 'prune'])
    await git(w.root, ['branch', '-D', w.branch]).catch(() => undefined)
    return 'removed'
  } catch {
    return 'kept'
  }
}

// ---------------------------------------------------------------------------
// Ledger: one notes file per project, kept in Jolty's data folder
// ---------------------------------------------------------------------------
/** 30,000 characters: a ledger that outgrows it must be rewritten shorter, not read in full by every session. */
export const LEDGER_MAX = 30000

/** Sessions of one project share a ledger: a worktree session uses its lead's folder. */
export function projectOf(meta: Pick<SessionMeta, 'cwd' | 'worktree'>): string {
  return path.resolve(meta.worktree ? meta.worktree.root : meta.cwd)
}

export function ledgerFile(project: string): string {
  const id = createHash('sha1').update(project.toLowerCase()).digest('hex').slice(0, 10)
  return path.join(dataDir(), 'ledgers', `${slug(path.basename(project))}-${id}.md`)
}

export function readLedger(project: string): string {
  try {
    return fs.readFileSync(ledgerFile(project), 'utf8')
  } catch {
    return ''
  }
}

export function writeLedger(project: string, text: string, mode: 'append' | 'replace', author: string): string {
  const file = ledgerFile(project)
  const stamp = new Date().toISOString().slice(0, 16).replace('T', ' ')
  const next = mode === 'replace' ? text.trim() : `${readLedger(project).trimEnd()}\n\n## ${stamp} · ${author}\n${text.trim()}`.trim()
  if (next.length > LEDGER_MAX) throw new Error(`The ledger would be ${next.length} characters, over the ${LEDGER_MAX} limit. Read it, then rewrite it shorter with mode "replace" (keep decisions, state and open work; drop history).`)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, `${next}\n`)
  return file
}
