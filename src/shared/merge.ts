// What the merge assistant shows about the branch of a parallel session, shared by main and renderer.
import type { FileDiff } from './types'
import { tr } from './i18n'

export interface MergeCommit {
  sha: string
  subject: string
  body: string
}

export interface MergeStatus {
  branch: string
  /** the branch checked out in the main tree, which the session branch merges into */
  base?: string
  /** detached: the main tree has no branch checked out; same: the session branch itself is checked out there; nobranch: the branch is gone */
  problem?: 'detached' | 'same' | 'nobranch'
  root: string
  path: string
  /** the worktree folder no longer exists */
  missing: boolean
  /** `git status --porcelain` lines of the worktree */
  dirty: string[]
  /** the main tree has uncommitted changes to tracked files */
  rootDirty: boolean
  ahead: number
  behind: number
  merged: boolean
  tip: string
  baseTip: string
  commits: MergeCommit[]
  stat: string
  diffs: FileDiff[]
  truncated: boolean
  /** gh is installed and origin is on GitHub */
  pr: boolean
}

/** What a dry run found; `tip`/`baseTip` go back with the real action so a moved branch is caught. */
export interface MergeCheck {
  conflicts: string[]
  tip: string
  baseTip: string
}

export type MergeAction = 'merge' | 'rebase'

/** Title and body of a pull request, prefilled from the commits. */
export function prDraft(title: string, commits: MergeCommit[]): { title: string; body: string } {
  if (commits.length === 1) return { title: commits[0].subject, body: commits[0].body }
  // git log lists the newest first; the description reads in the order the work was done
  return { title, body: [...commits].reverse().map((c) => `- ${c.subject}`).join('\n') }
}

/** The message that asks the lead chat to resolve the conflicts itself. */
export function conflictMessage(s: Pick<MergeStatus, 'branch' | 'base' | 'path'>, action: MergeAction, files: string[]): string {
  const list = files.map((f) => `- ${f}`).join('\n')
  return action === 'merge'
    ? tr("Merge-ul branch-ului {branch} în {base} are conflicte în fișierele de mai jos. Nu am schimbat nimic. Rezolvă tu conflictele și fă merge-ul:\n{list}", { branch: s.branch, base: s.base ?? '', list })
    : tr("Rebase-ul branch-ului {branch} (worktree {path}) pe {base} are conflicte în fișierele de mai jos. Nu am schimbat nimic. Rezolvă tu conflictele și fă rebase-ul:\n{list}", { branch: s.branch, base: s.base ?? '', path: s.path, list })
}
