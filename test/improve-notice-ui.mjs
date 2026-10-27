// What "improve message" has to say shows in one slot right above the box, not as a toast: it stays until closed
// or until the next send, and a newer one replaces it instead of stacking. The profile is local, so no model is called.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { _electron as electron } from 'playwright-core'

const data = fs.mkdtempSync(path.join(os.tmpdir(), 'jolty-notice-'))
const shots = path.join(data, 'shots')
fs.mkdirSync(shots)
fs.writeFileSync(path.join(data, 'profiles.json'), JSON.stringify([{ id: 'p1', name: 'Local', engine: 'claude', auth: 'endpoint', baseUrl: 'http://127.0.0.1:9', local: true, models: ['m'], color: '#d97757' }]))
// the app adds its default OpenCode profile at start; marking it full keeps it out of the helper models, so improve fails at once
fs.writeFileSync(path.join(data, 'limits.json'), JSON.stringify({ 'opencode-main': { profileId: 'opencode-main', windows: [{ label: 'test', usedPercent: 100 }] } }))
fs.writeFileSync(path.join(data, 'sessions.json'), JSON.stringify([{ id: 's1', profileId: 'p1', engine: 'claude', cwd: data, title: 'Notice', permissionMode: 'ask', createdAt: 1, updatedAt: 1 }]))
fs.writeFileSync(path.join(data, 'settings.json'), JSON.stringify({ language: 'en', lastCwd: data }))
fs.mkdirSync(path.join(data, 'transcripts'))
fs.writeFileSync(path.join(data, 'transcripts', 's1.json'), JSON.stringify([{ kind: 'user', id: 'u1', text: 'hello' }, { kind: 'assistant', id: 'a1', text: 'Hi.' }]))

const env = { ...process.env, JOLTY_TEST: '1', JOLTY_DATA_DIR: data }
delete env.ELECTRON_RUN_AS_NODE
const app = await electron.launch({ args: [path.resolve('out/main/index.js'), '--user-data-dir=' + path.join(data, 'electron')], env, timeout: 60000 })
const pause = (ms) => new Promise((r) => setTimeout(r, ms))
try {
  const win = await app.firstWindow()
  win.setDefaultTimeout(30000)
  await win.waitForSelector('.brand-name', { timeout: 60000 })
  await win.keyboard.press('Escape')
  await win.locator('.session-item').first().click()
  const box = win.locator('.composer textarea')
  const improve = win.locator('.composer-bar button:has(svg.lucide-sparkles)')
  const notice = win.locator('.composer-notice')
  await box.fill('make this clearer')
  await improve.click()
  await notice.waitFor()
  assert.equal(await win.locator('.toast').count(), 0, 'no toast: the notice is the only message')
  assert.equal(await notice.getAttribute('role'), 'alert', 'a failure is announced as an alert')
  const n = await notice.boundingBox()
  const c = await win.locator('.composer').boundingBox()
  assert.ok(n.y + n.height <= c.y + 1, 'the notice sits above the box')
  assert.ok(Math.abs(n.x - c.x) < 2 && Math.abs(n.width - c.width) < 2, 'same width as the box')
  await win.screenshot({ path: path.join(shots, 'notice.png') })

  await pause(7000) // longer than a toast lives
  assert.equal(await notice.count(), 1, 'it stays while nothing is done')

  await improve.click() // the same failure again: replaced, not stacked
  await pause(800)
  assert.equal(await notice.count(), 1, 'one slot, never two notices')

  await notice.locator('button').click()
  assert.equal(await notice.count(), 0, 'the close button removes it')

  await improve.click()
  await notice.waitFor()
  await box.press('Enter') // sending a message clears it
  await pause(500)
  assert.equal(await notice.count(), 0, 'sending a message removes it')
  console.log('improve notice ok, screenshot: ' + path.join(shots, 'notice.png'))
} finally {
  // the last step sends a message, and a started turn can hold the app open: close politely, then by PID
  const proc = app.process()
  await Promise.race([app.close().catch(() => undefined), pause(10000)])
  if (proc.exitCode === null) proc.kill()
}
