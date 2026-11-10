// Comments on diff lines: in the Changes tab a line shows a plus on hover, the comment is written in place, the
// bar counts them, and one button sends them all as a single message that quotes each line. No model is called.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { _electron as electron } from 'playwright-core'

const data = fs.mkdtempSync(path.join(os.tmpdir(), 'jolty-review-'))
fs.writeFileSync(path.join(data, 'profiles.json'), JSON.stringify([{ id: 'p1', name: 'Local', engine: 'claude', auth: 'endpoint', baseUrl: 'http://127.0.0.1:9', local: true, models: ['m'], color: '#d97757' }]))
fs.writeFileSync(path.join(data, 'limits.json'), JSON.stringify({ 'opencode-main': { profileId: 'opencode-main', windows: [{ label: 'test', usedPercent: 100 }] } }))
fs.writeFileSync(path.join(data, 'sessions.json'), JSON.stringify([{ id: 's1', profileId: 'p1', engine: 'claude', cwd: data, title: 'Review', permissionMode: 'ask', createdAt: 1, updatedAt: 1 }]))
fs.writeFileSync(path.join(data, 'settings.json'), JSON.stringify({ language: 'en', lastCwd: data }))
fs.mkdirSync(path.join(data, 'transcripts'))
const diff = ['-const old = 1', '+const renamed = 1', '+export { renamed }'].join('\n')
fs.writeFileSync(path.join(data, 'transcripts', 's1.json'), JSON.stringify([
  { kind: 'user', id: 'u1', text: 'rename it' },
  { kind: 'tool', id: 't1', name: 'Edit', title: 'Edit src/app.ts', status: 'done', diffs: [{ path: 'src/app.ts', kind: 'update', diff }] },
  { kind: 'assistant', id: 'a1', text: 'Done.' }
]))

const env = { ...process.env, JOLTY_TEST: '1', JOLTY_DATA_DIR: data }
delete env.ELECTRON_RUN_AS_NODE
const pause = (ms) => new Promise((r) => setTimeout(r, ms))
const app = await electron.launch({ args: [path.resolve('out/main/index.js'), '--user-data-dir=' + path.join(data, 'electron')], env, timeout: 60000 })
try {
  const win = await app.firstWindow()
  win.setDefaultTimeout(30000)
  await win.waitForSelector('.brand-name', { timeout: 60000 })
  await win.keyboard.press('Escape')
  await win.locator('.session-item').first().click()

  await win.locator('.change-row').click()
  const added = win.locator('.change-diff .diff-line.add').first()
  await added.waitFor()
  assert.equal(await win.locator('.review-bar').count(), 0, 'no bar while there is nothing to send')
  assert.equal(await win.locator('.change-diff .diff-line.hunk').count(), 0)

  await added.hover()
  await added.locator('.diff-add').click()
  const box = win.locator('.diff-note-input')
  await box.fill('keep the old name')
  await box.press('Enter')
  assert.equal(await box.count(), 0, 'Enter saves and closes the box')
  assert.equal(await win.locator('.diff-note span').innerText(), 'keep the old name', 'the comment shows under its line')
  assert.equal(await added.evaluate((el) => el.nextElementSibling?.className), 'diff-note', 'right under the line it was written on, not under another one')
  assert.equal((await win.locator('.review-bar span').innerText()).trim(), '1 comment')

  const removed = win.locator('.change-diff .diff-line.del').first()
  await removed.hover()
  await removed.locator('.diff-add').click()
  await win.locator('.diff-note-input').fill('why drop this?')
  await win.keyboard.press('Escape')
  assert.equal(await win.locator('.diff-note-input').count(), 0, 'Escape drops what was not saved')
  assert.equal(await win.locator('.diff-note').count(), 1)

  await removed.hover()
  await removed.locator('.diff-add').click()
  await win.locator('.diff-note-input').fill('why drop this?')
  await win.locator('.diff-note-input').press('Enter')
  assert.equal((await win.locator('.review-bar span').innerText()).trim(), '2 comments')
  await win.screenshot({ path: path.join(data, 'review.png') })

  // a tab switch does not lose them: the file folds, the comments are still there when it is opened again
  await win.locator('.live-tab').nth(1).click()
  await win.locator('.live-tab').first().click()
  await win.locator('.change-row').click()
  assert.equal(await win.locator('.diff-note').count(), 2, 'both comments survive a tab switch')

  await win.locator('.diff-note button').first().click() // the first note in the page is the one on the removed line: it goes
  assert.equal((await win.locator('.review-bar span').innerText()).trim(), '1 comment')

  await win.locator('.review-bar .btn.primary').click()
  await win.getByText('Comments on the changes:').waitFor()
  assert.equal(await win.locator('.review-bar').count(), 0, 'sent: the bar and the comments are gone')
  const said = await win.locator('body').innerText()
  assert.ok(said.includes('keep the old name') && said.includes('const renamed = 1'), 'the message quotes the line and carries the comment')
  assert.ok(!said.includes('why drop this?'), 'what was deleted is not sent')
  console.log('review ok, screenshot: ' + path.join(data, 'review.png'))
} finally {
  const proc = app.process()
  await Promise.race([app.close().catch(() => undefined), pause(10000)])
  if (proc.exitCode === null) proc.kill()
}
