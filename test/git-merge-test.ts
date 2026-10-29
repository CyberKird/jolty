import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { conflictMessage, prDraft } from '../src/shared/merge'

const data = fs.mkdtempSync(path.join(os.tmpdir(), 'jolty-merge-data-'))
process.env.JOLTY_DATA_DIR = data
process.env.GIT_AUTHOR_NAME = process.env.GIT_COMMITTER_NAME = 'test'
process.env.GIT_AUTHOR_EMAIL = process.env.GIT_COMMITTER_EMAIL = 'test@example.com'
// imported after the env var is set
const { addWorktree } = await import('../src/main/workers')
const m = await import('../src/main/git-merge')

const git = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true }).trim()
const write = (dir: string, file: string, text: string): void => fs.writeFileSync(path.join(dir, file), text)
const commit = (dir: string, msg: string): void => {
  git(dir, 'add', '-A')
  git(dir, 'commit', '-q', '-m', msg)
}

/** A repository on branch main with one commit, and a session worktree cut from it. */
async function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jolty-merge-repo-'))
  git(root, 'init', '-q', '-b', 'main')
  git(root, 'config', 'core.autocrlf', 'false')
  write(root, 'a.txt', 'one\ntwo\nthree\n')
  write(root, '.gitignore', 'node_modules\n')
  commit(root, 'first')
  const t = await addWorktree(root, Math.random().toString(16).slice(2, 10), 'job')
  assert.ok(t)
  return { root, w: t.info }
}

test('clean merge: status, dry run, merge, then remove worktree and the merged branch', async () => {
  const { root, w } = await setup()
  write(w.path, 'b.txt', 'new file\n')
  commit(w.path, 'add b')
  const s = await m.mergeStatus(w)
  assert.equal(s.base, 'main')
  assert.equal(s.ahead, 1)
  assert.equal(s.behind, 0)
  assert.equal(s.merged, false)
  assert.deepEqual(s.dirty, [])
  assert.equal(s.commits[0].subject, 'add b')
  assert.match(s.stat, /b\.txt/)
  assert.deepEqual(s.diffs.map((d) => [d.path, d.kind]), [['b.txt', 'add']])
  const check = await m.mergeCheck(w, 'merge')
  assert.deepEqual(check.conflicts, [])
  // the dry run changed nothing
  assert.equal(git(root, 'rev-parse', 'HEAD'), s.baseTip)
  await m.mergeBranch(w, check)
  assert.equal(fs.readFileSync(path.join(root, 'b.txt'), 'utf8'), 'new file\n')
  const after = await m.mergeStatus(w)
  assert.equal(after.merged, true)
  await assert.rejects(m.mergeCheck(w, 'merge'), /nimic de adus/)
  // a junction to a folder outside, as sessions do with node_modules: removing the worktree must not empty its target
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'jolty-merge-outside-'))
  write(outside, 'keep.txt', 'keep')
  fs.symlinkSync(outside, path.join(w.path, 'node_modules'), 'junction')
  await m.removeBranch(w, after.tip, false)
  assert.equal(fs.existsSync(w.path), false)
  assert.equal(fs.readFileSync(path.join(outside, 'keep.txt'), 'utf8'), 'keep')
  assert.equal(git(root, 'branch', '--list', w.branch), '')
})

test('conflicting merge: the dry run lists the files and nothing in the main tree changes', async () => {
  const { root, w } = await setup()
  write(w.path, 'a.txt', 'one\nTWO from session\nthree\n')
  commit(w.path, 'session edit')
  write(root, 'a.txt', 'one\nTWO from lead\nthree\n')
  commit(root, 'lead edit')
  const head = git(root, 'rev-parse', 'HEAD')
  const s = await m.mergeStatus(w)
  assert.equal(s.behind, 1)
  const check = await m.mergeCheck(w, 'merge')
  assert.deepEqual(check.conflicts, ['a.txt'])
  await assert.rejects(m.mergeBranch(w, check), /conflicte/)
  await assert.rejects(m.rebaseBranch(w, check), /conflicte/)
  assert.equal(git(root, 'rev-parse', 'HEAD'), head)
  assert.equal(git(root, 'status', '--porcelain'), '')
  assert.match(conflictMessage(s, 'merge', check.conflicts), /a\.txt/)
})

test('base moved after the check: merge refuses; rebase on the new base works', async () => {
  const { root, w } = await setup()
  write(w.path, 'b.txt', 'b\n')
  commit(w.path, 'add b')
  const check = await m.mergeCheck(w, 'merge')
  write(root, 'c.txt', 'c\n')
  commit(root, 'lead adds c')
  await assert.rejects(m.mergeBranch(w, check), /s-au mutat/)
  const again = await m.mergeCheck(w, 'rebase')
  await m.rebaseBranch(w, again)
  const s = await m.mergeStatus(w)
  assert.equal(s.behind, 0)
  assert.equal(s.ahead, 1)
  assert.ok(fs.existsSync(path.join(w.path, 'c.txt')))
})

test('dirty worktree: shown, never removed, rebase refused', async () => {
  const { w } = await setup()
  write(w.path, 'b.txt', 'b\n')
  commit(w.path, 'add b')
  write(w.path, 'a.txt', 'changed but not committed\n')
  const s = await m.mergeStatus(w)
  assert.deepEqual(s.dirty, [' M a.txt'])
  await assert.rejects(m.removeBranch(w, s.tip, true), /necomise/)
  assert.ok(fs.existsSync(path.join(w.path, 'a.txt')))
  await assert.rejects(m.mergeCheck(w, 'rebase'), /necomise/)
})

test('missing worktree folder: status still reads the branch; unmerged branch needs the explicit loss', async () => {
  const { root, w } = await setup()
  write(w.path, 'b.txt', 'b\n')
  commit(w.path, 'add b')
  fs.rmSync(w.path, { recursive: true, force: true })
  const s = await m.mergeStatus(w)
  assert.equal(s.missing, true)
  assert.equal(s.ahead, 1)
  await assert.rejects(m.mergeCheck(w, 'rebase'), /lipsește/)
  await assert.rejects(m.removeBranch(w, s.tip, false), /commituri care nu sunt/)
  await assert.rejects(m.removeBranch(w, 'f'.repeat(40), true), /s-au mutat/)
  await m.removeBranch(w, s.tip, true)
  assert.equal(git(root, 'branch', '--list', w.branch), '')
  assert.equal(git(root, 'worktree', 'list').split('\n').length, 1)
})

test('detached HEAD and a branch checked out in the main tree are reported, not acted on', async () => {
  const { root, w } = await setup()
  write(w.path, 'b.txt', 'b\n')
  commit(w.path, 'add b')
  git(root, 'checkout', '-q', '--detach')
  const d = await m.mergeStatus(w)
  assert.equal(d.problem, 'detached')
  assert.equal(d.ahead, 1)
  await assert.rejects(m.mergeCheck(w, 'merge'), /detached/)
  git(root, 'checkout', '-q', 'main')
  fs.rmSync(w.path, { recursive: true, force: true })
  git(root, 'worktree', 'prune')
  git(root, 'checkout', '-q', w.branch)
  const same = await m.mergeStatus(w)
  assert.equal(same.problem, 'same')
  await assert.rejects(m.mergeCheck(w, 'merge'), /folderul principal/)
  await assert.rejects(m.removeBranch(w, same.tip, true), /folderul principal/)
})

test('branch names that could pass as options are refused', async () => {
  const { w } = await setup()
  await assert.rejects(m.mergeStatus({ ...w, branch: '--upload-pack=x' }), /nevalid/)
  await assert.rejects(m.mergeStatus({ ...w, branch: 'a..b' }), /nevalid/)
})

test('parseDiff splits files and keeps the kind; pr draft reads from the commits', () => {
  const text = 'diff --git a/x.ts b/x.ts\nindex 1..2 100644\n--- a/x.ts\n+++ b/x.ts\n@@ -1 +1 @@\n-a\n+b\ndiff --git a/old.txt b/old.txt\ndeleted file mode 100644\n--- a/old.txt\n+++ /dev/null\n@@ -1 +0,0 @@\n-gone\n'
  const { diffs, truncated } = m.parseDiff(text)
  assert.equal(truncated, false)
  assert.deepEqual(diffs.map((d) => [d.path, d.kind]), [['x.ts', 'update'], ['old.txt', 'delete']])
  assert.equal(diffs[0].diff, '@@ -1 +1 @@\n-a\n+b')
  assert.equal(m.parseDiff(text, 50).truncated, true)
  assert.deepEqual(prDraft('Job', [{ sha: '1', subject: 'Only', body: 'why' }]), { title: 'Only', body: 'why' })
  assert.deepEqual(prDraft('Job', [{ sha: '2', subject: 'second', body: '' }, { sha: '1', subject: 'first', body: '' }]), { title: 'Job', body: '- first\n- second' })
})
