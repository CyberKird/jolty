// Connectors (the user's MCP servers) of one chat sit on a button of their own, not in the Tools menu: the button
// counts how many are on, each server is a row that switches it off for this chat only, one row switches all, and
// the choice is saved with the chat and survives a restart. Needs no model: the profile is local, nothing is sent.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { _electron as electron } from 'playwright-core'

const data = fs.mkdtempSync(path.join(os.tmpdir(), 'jolty-connectors-'))
const claudeJson = path.join(data, 'claude.json')
fs.writeFileSync(claudeJson, JSON.stringify({ mcpServers: { alpha: { command: 'node', args: ['-e', '0'] }, beta: { type: 'http', url: 'http://127.0.0.1:9/mcp' } } }))
fs.writeFileSync(path.join(data, 'profiles.json'), JSON.stringify([{ id: 'p1', name: 'Local', engine: 'claude', auth: 'endpoint', baseUrl: 'http://127.0.0.1:9', local: true, models: ['m'], color: '#d97757' }]))
fs.writeFileSync(path.join(data, 'limits.json'), JSON.stringify({ 'opencode-main': { profileId: 'opencode-main', windows: [{ label: 'test', usedPercent: 100 }] } }))
fs.writeFileSync(path.join(data, 'sessions.json'), JSON.stringify([{ id: 's1', profileId: 'p1', engine: 'claude', cwd: data, title: 'Connectors', permissionMode: 'ask', createdAt: 1, updatedAt: 1 }]))
fs.writeFileSync(path.join(data, 'settings.json'), JSON.stringify({ language: 'en', lastCwd: data }))
fs.mkdirSync(path.join(data, 'transcripts'))
fs.writeFileSync(path.join(data, 'transcripts', 's1.json'), JSON.stringify([{ kind: 'user', id: 'u1', text: 'hello' }, { kind: 'assistant', id: 'a1', text: 'Hi.' }]))

const env = { ...process.env, JOLTY_TEST: '1', JOLTY_DATA_DIR: data, JOLTY_CLAUDE_JSON: claudeJson }
delete env.ELECTRON_RUN_AS_NODE
const pause = (ms) => new Promise((r) => setTimeout(r, ms))
const saved = () => JSON.parse(fs.readFileSync(path.join(data, 'sessions.json'), 'utf8')).find((s) => s.id === 's1').mcpOff
const launch = () => electron.launch({ args: [path.resolve('out/main/index.js'), '--user-data-dir=' + path.join(data, 'electron')], env, timeout: 60000 })

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

let app = await launch()
try {
  const win = await open(app)
  const button = win.locator('.composer-bar button:has(svg.lucide-plug)')
  await button.waitFor()
  assert.equal((await button.innerText()).trim(), '2/2', 'the button counts the connectors that are on')

  // the Tools menu keeps its own options and none of the connectors
  await win.locator('.composer-bar button:has(svg.lucide-sliders-horizontal)').click()
  const tools = await win.locator('.picker-pop').innerText()
  assert.ok(!/alpha|beta/.test(tools), 'connectors are not mixed into the Tools menu')
  await win.keyboard.press('Escape')

  await button.click()
  const alpha = win.locator('[role=menuitemcheckbox]', { hasText: 'alpha' })
  const beta = win.locator('[role=menuitemcheckbox]', { hasText: 'beta' })
  await alpha.waitFor()
  assert.equal(await alpha.getAttribute('aria-checked'), 'true', 'a connector is on by default')
  assert.equal(await beta.getAttribute('aria-checked'), 'true', 'remote servers are listed too')

  await alpha.click()
  await pause(600)
  assert.equal(await alpha.getAttribute('aria-checked'), 'false', 'clicking switches it off')
  assert.equal(await beta.getAttribute('aria-checked'), 'true', 'the others stay on')
  assert.equal((await button.innerText()).trim(), '1/2', 'the count follows')
  assert.deepEqual(saved(), ['alpha'], 'the choice is saved with the chat')

  await win.locator('.connectors-all').click() // one of the two is on: this turns everything off
  await pause(600)
  assert.equal((await button.innerText()).trim(), '0/2')
  assert.deepEqual(saved().sort(), ['alpha', 'beta'])
  await win.locator('.connectors-all').click() // now it turns everything on
  await pause(600)
  assert.equal((await button.innerText()).trim(), '2/2')
  assert.equal(saved(), undefined, 'nothing left in the file when all are on')

  await beta.click()
  await pause(600)
  assert.deepEqual(saved(), ['beta'])
  await win.screenshot({ path: path.join(data, 'connectors.png') })
} finally {
  await close(app)
}

// a restart keeps it
app = await launch()
try {
  const win = await open(app)
  const button = win.locator('.composer-bar button:has(svg.lucide-plug)')
  await button.waitFor()
  assert.equal((await button.innerText()).trim(), '1/2', 'still one off after a restart')
  await button.click()
  assert.equal(await win.locator('[role=menuitemcheckbox]', { hasText: 'beta' }).getAttribute('aria-checked'), 'false')
  console.log('connectors ok, screenshot: ' + path.join(data, 'connectors.png'))
} finally {
  await close(app)
}
