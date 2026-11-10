// GitHub on a button of its own: the pull request of the branch with its checks, auto-merge on and off, and an
// open issue that lands in the message box. Where gh finds no repository there is no button at all.
// gh is a stub script (test/fixtures/gh-stub.js); no network, no model.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { _electron as electron } from 'playwright-core'

const data = fs.mkdtempSync(path.join(os.tmpdir(), 'jolty-github-'))
fs.writeFileSync(path.join(data, 'profiles.json'), JSON.stringify([{ id: 'p1', name: 'Local', engine: 'claude', auth: 'endpoint', baseUrl: 'http://127.0.0.1:9', local: true, models: ['m'], color: '#d97757' }]))
fs.writeFileSync(path.join(data, 'limits.json'), JSON.stringify({ 'opencode-main': { profileId: 'opencode-main', windows: [{ label: 'test', usedPercent: 100 }] } }))
fs.writeFileSync(path.join(data, 'sessions.json'), JSON.stringify([{ id: 's1', profileId: 'p1', engine: 'claude', cwd: data, title: 'Shop', permissionMode: 'ask', createdAt: 1, updatedAt: 1 }]))
fs.writeFileSync(path.join(data, 'settings.json'), JSON.stringify({ language: 'en', lastCwd: data }))
fs.mkdirSync(path.join(data, 'transcripts'))
fs.writeFileSync(path.join(data, 'transcripts', 's1.json'), JSON.stringify([{ kind: 'user', id: 'u1', text: 'hello' }, { kind: 'assistant', id: 'a1', text: 'Hi.' }]))

const pause = (ms) => new Promise((r) => setTimeout(r, ms))
const launch = (mode) => {
  const env = { ...process.env, JOLTY_TEST: '1', JOLTY_DATA_DIR: data, JOLTY_GH: path.resolve('test/fixtures/gh-stub.js'), GH_STUB_DIR: data }
  if (mode) env.GH_STUB_MODE = mode
  else delete env.GH_STUB_MODE
  delete env.ELECTRON_RUN_AS_NODE
  return electron.launch({ args: [path.resolve('out/main/index.js'), '--user-data-dir=' + path.join(data, 'electron')], env, timeout: 60000 })
}
async function close(app) {
  const proc = app.process()
  await Promise.race([app.close().catch(() => undefined), pause(10000)])
  if (proc.exitCode === null) proc.kill()
}
async function open(app) {
  const win = await app.firstWindow()
  win.setDefaultTimeout(30000)
  await win.waitForSelector('.brand-name', { timeout: 60000 })
  await win.keyboard.press('Escape')
  await win.locator('.session-item').first().click()
  return win
}
const BUTTON = '.composer-bar button:has(svg.lucide-git-pull-request)'

let app = await launch()
try {
  const win = await open(app)
  const button = win.locator(BUTTON)
  await button.waitFor()
  assert.ok((await button.innerText()).includes('#12'), 'the button names the pull request')
  assert.equal(await win.locator('.composer-bar button:has(svg.lucide-sliders-horizontal)').count(), 1, 'the Tools menu is still its own button')

  await button.click()
  const pop = win.locator('.github-pop')
  await pop.waitFor()
  const text = await pop.innerText()
  assert.ok(text.includes('#12 Add checkout') && text.includes('1 of 3 checks passed'), 'the pull request and its checks')
  assert.ok(text.includes('#7 Cart loses items') && text.includes('bug') && text.includes('#9 Dark mode'), 'the open issues')

  const auto = pop.locator('[role=menuitemcheckbox]')
  assert.equal(await auto.getAttribute('aria-checked'), 'false')
  await auto.click()
  await win.waitForFunction(() => document.querySelector('.github-pop [role=menuitemcheckbox]')?.getAttribute('aria-checked') === 'true')
  assert.ok(fs.existsSync(path.join(data, 'auto-merge')), 'gh was asked for auto-merge')
  await auto.click()
  await win.waitForFunction(() => document.querySelector('.github-pop [role=menuitemcheckbox]')?.getAttribute('aria-checked') === 'false')
  assert.ok(!fs.existsSync(path.join(data, 'auto-merge')), 'and told to take it back')
  await win.screenshot({ path: path.join(data, 'github.png') })

  await win.locator('.github-pop .picker-opt', { hasText: '#7 Cart loses items' }).click()
  await win.locator('.github-pop').waitFor({ state: 'detached' })
  const box = await win.locator('.composer textarea').inputValue()
  assert.ok(box.startsWith('GitHub issue #7: Cart loses items') && box.includes('Items vanish after login.'), 'the issue is in the message box')
} finally {
  await close(app)
}

// no repository: nothing on the bar
app = await launch('norepo')
try {
  const win = await open(app)
  await win.locator('.composer-bar button:has(svg.lucide-sliders-horizontal)').waitFor()
  await pause(2500)
  assert.equal(await win.locator(BUTTON).count(), 0, 'no button without a GitHub repository')
  console.log('github ok, screenshot: ' + path.join(data, 'github.png'))
} finally {
  await close(app)
}
