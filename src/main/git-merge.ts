// Merge assistant for the branches parallel sessions leave behind: shows what a branch holds and merges,
// rebases, opens a PR or removes it, each only on the user's click. Plain git through execFile, no force flags;
// every change is checked first with a dry run, and the branch tips seen by the user must still match.
import { execFile } from 'child_process'
import fs from 'fs'
import path from 'path'
import type { FileDiff, SessionMeta } from '@shared/types'
import type { MergeAction, MergeCheck, MergeCommit, MergeStatus } from '@shared/merge'
import { tr } from '@shared/i18n'

type Worktree = NonNullable<SessionMeta['worktree']>
interface Run {
  code: number
  out: string
  err: string
}

const DIFF_MAX = 400_000
// branch names reach git as arguments: refuse anything that could read as an option or a range
const REF = /^(?!-)(?!.*\.\.)[\w][\w./-]{0,199}$/

function run(cmd: 'git' | 'gh', cwd: string, args: string[]): Promise<Run> {
  // a missing cwd makes execFile report ENOENT too, which would read as "git is not installed"
  if (!fs.existsSync(cwd)) return Promise.reject(new Error(tr("Folderul {path} nu mai există.", { path: cwd })))
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { cwd, timeout: 120000, windowsHide: true, maxBuffer: 32 * 1024 * 1024 }, (err, out, errOut) => {
      if (err && (err as NodeJS.ErrnoException).code === 'ENOENT') return reject(new Error(cmd === 'git' ? tr("Git nu e instalat sau nu e în PATH.") : tr("GitHub CLI (gh) nu e instalat.")))
      const code = err ? (typeof err.code === 'number' ? err.code : 1) : 0
      resolve({ code, out: String(out), err: String(errOut || (err && !err.code ? err.message : '')).trim() })
    })
  })
}

async function git(cwd: string, args: string[]): Promise<string> {
  const r = await run('git', cwd, args)
  if (r.code) throw new Error(r.err || `git ${args[0]} failed (${r.code})`)
  return r.out.trim()
}

function ref(name: string): string {
  if (!REF.test(name)) throw new Error(tr("Nume de branch nevalid: {name}", { name }))
  return name
}

/** `git diff` output split per file, for DiffView; very large diffs are cut. */
export function parseDiff(text: string, max = DIFF_MAX): { diffs: FileDiff[]; truncated: boolean } {
  const parts = text.slice(0, max).split(/^(?=diff --git )/m).filter((p) => p.startsWith('diff --git '))
  const diffs = parts.map((p): FileDiff => {
    const head = p.split('\n', 1)[0]
    const name = /^\+\+\+ b\/(.*)$/m.exec(p)?.[1] ?? /^--- a\/(.*)$/m.exec(p)?.[1] ?? / b\/(.*)$/.exec(head)?.[1] ?? head
    const kind = /^new file mode/m.test(p) ? 'add' : /^deleted file mode/m.test(p) ? 'delete' : 'update'
    const at = p.search(/^@@/m)
    return { path: name.replace(/\t$/, ''), kind, diff: at >= 0 ? p.slice(at).trimEnd() : (/^Binary files.*$/m.exec(p)?.[0] ?? '') }
  })
  return { diffs, truncated: text.length > max }
}

let ghSeen: boolean | undefined
async function hasGh(root: string): Promise<boolean> {
  ghSeen ??= await run('gh', root, ['--version']).then((r) => r.code === 0, () => false)
  if (!ghSeen) return false
  const url = await git(root, ['remote', 'get-url', 'origin']).catch(() => '')
  return /github\.com[:/]/i.test(url)
}

/** Everything the panel shows about a session branch. Reads only. */
export async function mergeStatus(w: Worktree): Promise<MergeStatus> {
  const root = w.root
  const branch = ref(w.branch)
  const missing = !fs.existsSync(w.path)
  const current = await git(root, ['symbolic-ref', '--quiet', '--short', 'HEAD']).catch(() => '')
  const exists = await git(root, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]).catch(() => '')
  const problem = !exists ? 'nobranch' : !current ? 'detached' : current === branch ? 'same' : undefined
  const base = current && current !== branch ? ref(current) : undefined
  // without a base branch the diff is shown against the commit the session started from
  const from = base ?? w.base
  const tip = exists
  const baseTip = await git(root, ['rev-parse', 'HEAD']).catch(() => '')
  const status: MergeStatus = { branch, base, problem, root, path: w.path, missing, dirty: [], rootDirty: false, ahead: 0, behind: 0, merged: false, tip, baseTip, commits: [], stat: '', diffs: [], truncated: false, pr: false }
  status.rootDirty = Boolean(await git(root, ['status', '--porcelain', '--untracked-files=no']).catch(() => ''))
  // raw output: trimming would eat the leading space of the first ' M file' line
  if (!missing) status.dirty = (await run('git', w.path, ['status', '--porcelain']).catch(() => ({ out: '' }))).out.split('\n').map((l) => l.trimEnd()).filter(Boolean)
  if (!exists) return status
  const [behind, ahead] = (await git(root, ['rev-list', '--left-right', '--count', `${from}...${branch}`])).split(/\s+/).map(Number)
  Object.assign(status, { ahead, behind })
  status.merged = (await run('git', root, ['merge-base', '--is-ancestor', branch, from])).code === 0
  const log = await git(root, ['log', '--max-count=200', '--format=%H%x1f%s%x1f%b%x1e', `${from}..${branch}`])
  status.commits = log.split('\x1e').map((c) => c.trim()).filter(Boolean).map((c): MergeCommit => {
    const [sha, subject, body] = c.split('\x1f')
    return { sha, subject, body: (body ?? '').trim() }
  })
  status.stat = await git(root, ['diff', '--stat', `${from}...${branch}`])
  Object.assign(status, parseDiff((await run('git', root, ['diff', '--no-color', '--no-ext-diff', `${from}...${branch}`])).out))
  status.pr = Boolean(base) && (await hasGh(root))
  return status
}

/** A dry run that changes nothing: the files that would conflict if the branch met its base. */
export async function mergeCheck(w: Worktree, action: MergeAction): Promise<MergeCheck> {
  const s = await mergeStatus(w)
  ready(s, action)
  // shortcut: a rebase replays commit by commit and can still stop where the whole-branch merge is clean; the real run aborts then
  const r = await run('git', s.root, ['merge-tree', '--write-tree', '--name-only', '--no-messages', s.base!, s.branch])
  if (r.code > 1) throw new Error(r.err || tr("Verificarea de conflicte a eșuat (git 2.38 sau mai nou e necesar)."))
  const conflicts = r.code === 1 ? [...new Set(r.out.split('\n').slice(1).map((l) => l.trim()).filter(Boolean))] : []
  return { conflicts, tip: s.tip, baseTip: s.baseTip }
}

/** Refuses the states an action cannot run in, with a reason the user can act on. */
function ready(s: MergeStatus, action: MergeAction | 'pr'): void {
  if (s.problem === 'nobranch') throw new Error(tr("Branch-ul {branch} nu mai există.", { branch: s.branch }))
  if (s.problem === 'detached') throw new Error(tr("Folderul principal nu e pe niciun branch (detached HEAD). Fă checkout pe branch-ul de bază, apoi încearcă din nou."))
  if (s.problem === 'same') throw new Error(tr("Branch-ul {branch} e deschis chiar în folderul principal. Fă checkout pe branch-ul de bază acolo, apoi încearcă din nou.", { branch: s.branch }))
  if (action === 'pr') return
  if (s.merged || !s.ahead) throw new Error(tr("Nu e nimic de adus: {branch} nu are commituri care să lipsească din {base}.", { branch: s.branch, base: s.base ?? '' }))
  if (action === 'merge' && s.rootDirty) throw new Error(tr("Folderul principal are modificări necomise. Fă commit sau stash acolo, apoi încearcă din nou."))
  if (action === 'rebase' && s.missing) throw new Error(tr("Folderul worktree-ului lipsește, deci rebase-ul nu are unde rula."))
  if (action === 'rebase' && s.dirty.length) throw new Error(tr("Worktree-ul are modificări necomise. Fă commit în el, apoi încearcă din nou."))
}

/** The branches still point where the user saw them, or the action stops. */
async function unchanged(w: Worktree, action: MergeAction, seen: Pick<MergeCheck, 'tip' | 'baseTip'>): Promise<MergeStatus> {
  const s = await mergeStatus(w)
  ready(s, action)
  if (s.tip !== seen.tip || s.baseTip !== seen.baseTip) throw new Error(tr("Branch-urile s-au mutat de la verificare. Verifică din nou."))
  return s
}

/** Merges the session branch into the base branch, in the main tree, as a merge commit. */
export async function mergeBranch(w: Worktree, seen: Pick<MergeCheck, 'tip' | 'baseTip'>): Promise<void> {
  const s = await unchanged(w, 'merge', seen)
  if ((await mergeCheck(w, 'merge')).conflicts.length) throw new Error(tr("Merge-ul ar avea conflicte. Verifică din nou."))
  const r = await run('git', s.root, ['merge', '--no-ff', '--no-edit', s.branch])
  if (r.code) {
    await run('git', s.root, ['merge', '--abort'])
    throw new Error(r.err || r.out.trim())
  }
}

/** Replays the session branch on top of the base branch, inside the worktree. */
export async function rebaseBranch(w: Worktree, seen: Pick<MergeCheck, 'tip' | 'baseTip'>): Promise<void> {
  const s = await unchanged(w, 'rebase', seen)
  if ((await mergeCheck(w, 'rebase')).conflicts.length) throw new Error(tr("Rebase-ul ar avea conflicte. Verifică din nou."))
  const r = await run('git', w.path, ['rebase', s.base!])
  if (r.code) {
    await run('git', w.path, ['rebase', '--abort'])
    throw new Error(r.err || r.out.trim())
  }
}

/** Pushes the branch to origin and opens a pull request into the base branch; returns its address. */
export async function createPr(w: Worktree, title: string, body: string): Promise<string> {
  const s = await mergeStatus(w)
  ready(s, 'pr')
  if (!s.pr) throw new Error(tr("Pentru PR e nevoie de GitHub CLI (gh) și de un remote origin pe GitHub."))
  const t = title.replace(/\s+/g, ' ').trim().slice(0, 250)
  if (!t) throw new Error(tr("PR-ul are nevoie de un titlu."))
  await git(s.root, ['push', '--set-upstream', 'origin', `refs/heads/${s.branch}:refs/heads/${s.branch}`])
  const r = await run('gh', s.root, ['pr', 'create', `--base=${s.base}`, `--head=${s.branch}`, `--title=${t}`, `--body=${body.slice(0, 60000)}`])
  if (r.code) throw new Error(r.err || r.out.trim())
  return r.out.trim().split('\n').pop() ?? ''
}

/** Links (junctions) inside the worktree, such as a node_modules borrowed from the main tree. */
function links(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isSymbolicLink()) out.push(p)
    else if (e.isDirectory() && e.name !== '.git') links(p, out)
  }
  return out
}

/**
 * Removes the worktree folder and deletes the branch. A dirty worktree is never removed; an unmerged
 * branch only with `lose` set, and only while it still points at `tip`, the commit the user confirmed losing.
 */
export async function removeBranch(w: Worktree, tip: string, lose: boolean): Promise<void> {
  const s = await mergeStatus(w)
  if (s.problem === 'same') throw new Error(tr("Branch-ul {branch} e deschis chiar în folderul principal. Fă checkout pe branch-ul de bază acolo, apoi încearcă din nou.", { branch: s.branch }))
  if (s.dirty.length) throw new Error(tr("Worktree-ul are modificări necomise, deci nu îl șterg: {files}", { files: s.dirty.slice(0, 8).join(', ') }))
  if (s.tip && s.tip !== tip) throw new Error(tr("Branch-urile s-au mutat de la verificare. Verifică din nou."))
  if (s.tip && !s.merged && !lose) throw new Error(tr("Branch-ul {branch} are commituri care nu sunt în {base}.", { branch: s.branch, base: s.base ?? '' }))
  if (!s.missing) {
    // git can follow a junction and empty its target (the main tree's node_modules): unlink those first
    for (const l of links(w.path)) fs.unlinkSync(l)
    await git(s.root, ['worktree', 'remove', w.path])
  } else await git(s.root, ['worktree', 'prune'])
  if (!s.tip) return
  // `branch -d` refuses unmerged work; the confirmed loss goes through update-ref, which still checks the old tip
  if (s.merged) await git(s.root, ['branch', '-d', s.branch])
  else await git(s.root, ['update-ref', '-d', `refs/heads/${s.branch}`, tip])
}
