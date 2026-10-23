import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { liveRows } from '../src/shared/live'

const data = fs.mkdtempSync(path.join(os.tmpdir(), 'jolty-workers-data-'))
process.env.JOLTY_DATA_DIR = data
process.env.GIT_AUTHOR_NAME = process.env.GIT_COMMITTER_NAME = 'test'
process.env.GIT_AUTHOR_EMAIL = process.env.GIT_COMMITTER_EMAIL = 'test@example.com'
// imported after the env var is set
const w = await import('../src/main/workers')

const git = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true }).trim()

function repo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jolty-workers-repo-'))
  git(dir, 'init', '-q')
  fs.mkdirSync(path.join(dir, 'src'))
  fs.writeFileSync(path.join(dir, 'src', 'a.txt'), 'a')
  git(dir, 'add', '.')
  git(dir, 'commit', '-q', '-m', 'first')
  return dir
}

test('a worktree is cut from HEAD on its own branch, in the data folder, at the same place in the repo', async () => {
  const dir = repo()
  const made = await w.addWorktree(path.join(dir, 'src'), 'abcd1234', 'Fix the Login bug')
  assert.ok(made)
  assert.match(made.info.branch, /^jolty\/fix-the-login-bug-abcd$/)
  assert.ok(made.info.path.startsWith(path.join(data, 'worktrees')))
  assert.equal(made.cwd, path.join(made.info.path, 'src'))
  assert.equal(fs.readFileSync(path.join(made.cwd, 'a.txt'), 'utf8'), 'a')
  assert.equal(git(made.info.path, 'rev-parse', 'HEAD'), made.info.base)
  assert.equal(await w.removeWorktree(made.info), 'removed')
  assert.ok(!fs.existsSync(made.info.path))
  assert.equal(git(dir, 'branch', '--list', made.info.branch), '')
})

test('a worktree with changes or commits is kept, a folder outside git gets none', async () => {
  const dir = repo()
  const dirty = await w.addWorktree(dir, 'dirty001', 'dirty')
  fs.writeFileSync(path.join(dirty!.cwd, 'new.txt'), 'x')
  assert.equal(await w.removeWorktree(dirty!.info), 'kept')
  const committed = await w.addWorktree(dir, 'commit01', 'committed')
  fs.writeFileSync(path.join(committed!.cwd, 'b.txt'), 'b')
  git(committed!.cwd, 'add', '.')
  git(committed!.cwd, 'commit', '-q', '-m', 'work')
  assert.equal(await w.removeWorktree(committed!.info), 'kept')
  assert.ok(fs.existsSync(committed!.info.path))
  const plain = fs.mkdtempSync(path.join(os.tmpdir(), 'jolty-workers-plain-'))
  assert.equal(await w.addWorktree(plain, 'plain001', 'x'), undefined)
})

test('the ledger is shared by the lead and its worktree sessions, appends, replaces and has a limit', async () => {
  const dir = repo()
  const made = await w.addWorktree(dir, 'ledger01', 'job')
  const lead = { cwd: dir }
  const child = { cwd: made!.cwd, worktree: made!.info }
  assert.equal(w.projectOf(lead), w.projectOf(child))
  assert.equal(w.readLedger(w.projectOf(lead)), '')
  w.writeLedger(w.projectOf(lead), 'decided A', 'append', 'lead')
  w.writeLedger(w.projectOf(child), 'did B', 'append', 'child')
  const text = w.readLedger(w.projectOf(lead))
  assert.match(text, /decided A/)
  assert.match(text, /· child\ndid B/)
  w.writeLedger(w.projectOf(lead), 'short', 'replace', 'lead')
  assert.equal(w.readLedger(w.projectOf(lead)).trim(), 'short')
  assert.throws(() => w.writeLedger(w.projectOf(lead), 'x'.repeat(w.LEDGER_MAX), 'append', 'lead'), /limit/)
  assert.equal(w.readLedger(w.projectOf(lead)).trim(), 'short')
  // another project does not see it
  assert.equal(w.readLedger(w.projectOf({ cwd: repo() })), '')
})

test('the Live list: waiting first, then working, then finished; a started session follows its lead', () => {
  const s = (id: string, createdAt: number, parentId?: string) => ({ id, createdAt, parentId })
  const rows = liveRows({
    sessions: [s('idle', 1), s('done', 2), s('run2', 4), s('run1', 3), s('wait', 5), s('kid', 6, 'run1'), s('kidDone', 7, 'run1'), s('orphan', 8, 'gone')],
    status: { run1: 'running', run2: 'running', kid: 'running', orphan: 'running', idle: 'idle' },
    permissions: { wait: [{ id: 'r', toolName: 'Bash', title: 'npm test', canAllowForSession: false }] },
    unseen: { done: true, kidDone: true }
  })
  assert.deepEqual(
    rows.map((r) => `${r.session.id}:${r.state}:${r.depth}`),
    ['wait:waiting:0', 'run1:running:0', 'kid:running:1', 'kidDone:done:1', 'run2:running:0', 'orphan:running:0', 'done:done:0']
  )
})
