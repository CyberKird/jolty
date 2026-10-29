// The merge assistant in a real window: a throwaway repository with a lead chat and three worktree sessions
// (conflicting, clean, dirty). Opens the panel from the branch mark, runs the dry run, merges the clean one,
// and opens the remove confirm. Screenshots go to SHOTS (default: the temp data folder). Local data only.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { _electron as electron } from 'playwright-core'

const data = fs.mkdtempSync(path.join(os.tmpdir(), 'jolty-merge-ui-'))
const shots = process.env.SHOTS || data
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true, env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_COMMITTER_NAME: 't', GIT_AUTHOR_EMAIL: 't@e', GIT_COMMITTER_EMAIL: 't@e' } }).trim()
const write = (dir, file, text) => fs.writeFileSync(path.join(dir, file), text)
const commit = (dir, msg) => (git(dir, 'add', '-A'), git(dir, 'commit', '-q', '-m', msg))

const root = path.join(data, 'shop')
fs.mkdirSync(root)
git(root, 'init', '-q', '-b', 'main')
git(root, 'config', 'core.autocrlf', 'false')
write(root, 'app.ts', 'export const price = 10\nexport const name = "shop"\n')
commit(root, 'first')
const base = git(root, 'rev-parse', 'HEAD')
const tree = (name) => {
  const p = path.join(data, 'worktrees', name)
  git(root, 'worktree', 'add', '-q', '-b', `jolty/${name}`, p, base)
  return { path: p, branch: `jolty/${name}`, base, root }
}
const conflict = tree('pricing')
write(conflict.path, 'app.ts', 'export const price = 12\nexport const name = "shop"\n')
commit(conflict.path, 'Raise the price to 12')
write(conflict.path, 'cart.ts', 'export const cart: string[] = []\n')
commit(conflict.path, 'Add an empty cart')
const clean = tree('footer')
write(clean.path, 'footer.ts', 'export const footer = "(c) shop"\n')
commit(clean.path, 'Add the footer text')
const dirty = tree('header')
write(dirty.path, 'header.ts', 'export const header = "shop"\n')
commit(dirty.path, 'Add the header')
write(dirty.path, 'app.ts', 'export const price = 99\n')
// the lead moved on: the pricing branch now conflicts
write(root, 'app.ts', 'export const price = 15\nexport const name = "shop"\n')
commit(root, 'Price 15')

fs.writeFileSync(path.join(data, 'profiles.json'), JSON.stringify([{ id: 'p1', name: 'Local', engine: 'claude', auth: 'endpoint', baseUrl: 'http://127.0.0.1:8840', local: true, models: ['m'], color: '#d97757' }]))
const s = (id, title, extra) => ({ id, profileId: 'p1', engine: 'claude', title, permissionMode: 'ask', createdAt: 1, updatedAt: 1000, ...extra })
fs.writeFileSync(
  path.join(data, 'sessions.json'),
  JSON.stringify([
    s('lead', 'Magazin: lead', { cwd: root, updatedAt: 2000 }),
    s('c1', 'Prețuri noi', { cwd: conflict.path, parentId: 'lead', worktree: conflict }),
    s('c2', 'Footer', { cwd: clean.path, parentId: 'lead', worktree: clean }),
    s('c3', 'Header', { cwd: dirty.path, parentId: 'lead', worktree: dirty })
  ])
)
fs.writeFileSync(path.join(data, 'settings.json'), JSON.stringify({ language: 'ro', lastCwd: root }))
fs.mkdirSync(path.join(data, 'transcripts'))

// a temp HOME has no git identity, and the merge commit needs one
const env = { ...process.env, JOLTY_TEST: '1', JOLTY_DATA_DIR: data, GIT_AUTHOR_NAME: 't', GIT_COMMITTER_NAME: 't', GIT_AUTHOR_EMAIL: 't@e', GIT_COMMITTER_EMAIL: 't@e' }
delete env.ELECTRON_RUN_AS_NODE
const app = await electron.launch({ args: [path.resolve('out/main/index.js'), '--user-data-dir=' + path.join(data, 'electron')], env, timeout: 60000 })
try {
  const win = await app.firstWindow()
  win.setDefaultTimeout(30000)
  await win.setViewportSize({ width: 1400, height: 900 }).catch(() => undefined)
  await win.waitForSelector('.brand-name', { timeout: 60000 })
  await win.keyboard.press('Escape')
  const open = async (branch) => {
    await win.locator(`.session-item .merge-open[title$="${branch}"]`).click()
    await win.waitForSelector('.merge-modal .merge-head')
    await win.waitForTimeout(400)
  }
  const shot = async (name) => {
    await win.screenshot({ path: path.join(shots, `merge-${name}.png`) })
  }

  // 1. conflicting branch: status, then the dry run lists the file and the lead's folder stays as it was
  await open('jolty/pricing')
  const head = await win.locator('.merge-head').innerText()
  assert.match(head, /jolty\/pricing/)
  assert.match(head, /main/)
  assert.match(head, /2 înainte/)
  assert.match(head, /1 în urmă/)
  assert.equal(await win.locator('.merge-commits li').count(), 2)
  assert.ok(await win.locator('.merge-diff .diff-file').count() >= 2)
  await shot('1-status')
  const before = git(root, 'rev-parse', 'HEAD')
  await win.getByRole('button', { name: 'Verifică și fă merge' }).click()
  await win.waitForSelector('.merge-box.warn')
  assert.match(await win.locator('.merge-box.warn').innerText(), /app\.ts/)
  assert.equal(git(root, 'rev-parse', 'HEAD'), before)
  assert.equal(git(root, 'status', '--porcelain'), '')
  await shot('2-conflict')
  // the conflict list goes to the lead chat as a normal message (the model answers from the mock on 8840)
  await win.getByRole('button', { name: 'Cere modelului să rezolve' }).click()
  await win.waitForSelector('.merge-modal', { state: 'detached' })
  await win.waitForSelector('text=/are conflicte în fișierele de mai jos/')
  assert.equal(git(root, 'rev-parse', 'HEAD'), before)
  await win.waitForTimeout(1500)
  await shot('2b-asked-lead')
  // 2. remove on an unmerged branch names what is lost
  await open('jolty/pricing')
  await win.getByRole('button', { name: 'Verifică și fă merge' }).click()
  await win.waitForSelector('.merge-box.warn')
  await win.getByRole('button', { name: 'Anulează' }).click()
  await win.getByRole('button', { name: 'Șterge worktree și branch' }).click()
  assert.match(await win.locator('.merge-box').innerText(), /Se pierd commiturile care nu sunt în main \(2\)/)
  await shot('3-remove-confirm')
  await win.getByRole('button', { name: 'Anulează' }).click()
  await win.locator('.merge-modal').getByRole('button', { name: 'Închide', exact: true }).click()
  await win.waitForSelector('.merge-modal', { state: 'detached' })

  // 3. clean branch: confirm says what happens, then the merge lands in the lead's folder
  await open('jolty/footer')
  await win.getByRole('button', { name: 'Verifică și fă merge' }).click()
  await win.waitForSelector('.merge-confirm')
  assert.match(await win.locator('.merge-confirm').innerText(), /commit de merge/)
  await shot('4-merge-confirm')
  await win.getByRole('button', { name: 'Fă merge', exact: true }).click()
  await win.waitForSelector('.merge-done')
  await win.waitForSelector('.merge-chip:has-text("deja în main")')
  assert.ok(fs.existsSync(path.join(root, 'footer.ts')))
  await shot('5-merged')
  // merged: removing deletes worktree and branch, and the branch mark leaves the row
  await win.getByRole('button', { name: 'Șterge worktree și branch' }).click()
  assert.match(await win.locator('.merge-confirm').innerText(), /Șterg folderul/)
  await win.getByRole('button', { name: 'Șterge', exact: true }).click()
  await win.waitForSelector('.merge-modal', { state: 'detached' })
  assert.equal(fs.existsSync(clean.path), false)
  assert.equal(git(root, 'branch', '--list', 'jolty/footer'), '')
  await win.waitForSelector('.session-item .merge-open[title$="jolty/footer"]', { state: 'detached' })

  // 4. dirty worktree: said plainly, and it cannot be removed
  await open('jolty/header')
  assert.match(await win.locator('.merge-notes').innerText(), /necomise.*: app\.ts/)
  assert.ok(await win.getByRole('button', { name: 'Șterge worktree și branch' }).isDisabled())
  await shot('6-dirty')
  console.log('merge ui ok, screenshots in ' + shots)
} finally {
  await app.close()
}
