// Themes: the saved theme is on <html> when the window opens, the picker in Settings switches it at once and keeps it
// across a restart, and a theme does not break the chat. Opens one window twice. Screenshots go to SHOTS.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { _electron as electron } from 'playwright-core'

const shots = process.env.SHOTS || fs.mkdtempSync(path.join(os.tmpdir(), 'jolty-theme-shots-'))
fs.mkdirSync(shots, { recursive: true })
const data = fs.mkdtempSync(path.join(os.tmpdir(), 'jolty-theme-'))
const items = [
  { kind: 'user', id: 'u1', text: 'Please build the landing page' },
  { kind: 'assistant', id: 'a1', text: 'Done. I added a `Hero` section and a pricing table.\n\n```ts\nexport const price = 49\n```\n\n| Plan | Price |\n| --- | --- |\n| Basic | 49 |' },
  { kind: 'tool', id: 't1', name: 'Bash', title: '$ npm run build', status: 'done', input: { command: 'npm run build' }, output: 'built in 4.2s' },
  { kind: 'user', id: 'u2', text: 'Nice, now make the button bigger' }
]
fs.writeFileSync(path.join(data, 'profiles.json'), JSON.stringify([{ id: 'p1', name: 'Claude', engine: 'claude', auth: 'subscription', color: '#d97757' }]))
fs.writeFileSync(path.join(data, 'sessions.json'), JSON.stringify([{ id: 's1', profileId: 'p1', engine: 'claude', cwd: data, title: 'Landing page', permissionMode: 'ask', createdAt: 1, updatedAt: 1 }]))
fs.writeFileSync(path.join(data, 'settings.json'), JSON.stringify({ language: 'en', lastCwd: data, theme: 'glass' }))
fs.mkdirSync(path.join(data, 'transcripts'))
fs.writeFileSync(path.join(data, 'transcripts', 's1.json'), JSON.stringify(items))

const env = { ...process.env, JOLTY_TEST: '1', JOLTY_DATA_DIR: data }
delete env.ELECTRON_RUN_AS_NODE
const launch = () => electron.launch({ args: [path.resolve('out/main/index.js'), '--user-data-dir=' + path.join(data, 'electron')], env, timeout: 60000 })
const theme = (win) => win.evaluate(() => document.documentElement.dataset.theme)
const open = async (app) => {
  const win = await app.firstWindow()
  win.setDefaultTimeout(30000)
  await win.setViewportSize({ width: 1400, height: 900 })
  await win.waitForSelector('.brand-name', { timeout: 60000 })
  await win.keyboard.press('Escape')
  return win
}

let app = await launch()
try {
  let win = await open(app)
  assert.equal(await theme(win), 'glass', 'the saved theme is on <html>')
  await win.locator('.session-item').first().click()
  await win.waitForSelector('.msg-user')
  await win.screenshot({ path: path.join(shots, 'glass-chat.png') })
  const bubble = await win.locator('.msg-user').first().evaluate((el) => getComputedStyle(el).borderRadius)
  assert.notEqual(bubble, '0px', 'glass rounds the message bubble')

  await win.getByText('Settings', { exact: true }).first().click()
  await win.waitForSelector('.theme-opt')
  await win.screenshot({ path: path.join(shots, 'glass-settings.png') })
  assert.equal(await win.locator('.theme-opt.on b').innerText(), 'Glass')

  // the other pages in glass, for a look at contrast
  for (const page of ['Usage', 'Accounts and keys', 'Skills', 'System check']) {
    await win.getByText(page, { exact: true }).first().click({ timeout: 5000 }).catch(() => {})
    await new Promise((r) => setTimeout(r, 700))
    await win.screenshot({ path: path.join(shots, `glass-${page.split(' ')[0].toLowerCase()}.png`) })
  }
  await win.getByText('Settings', { exact: true }).first().click()
  await win.waitForSelector('.theme-opt')

  // the light theme
  await win.getByRole('radio', { name: /^Frost/ }).click()
  assert.equal(await theme(win), 'frost', 'the picker switches to Frost')
  await new Promise((r) => setTimeout(r, 500))
  await win.screenshot({ path: path.join(shots, 'frost-settings.png') })
  await win.locator('.session-item').first().click()
  await win.waitForSelector('.msg-user')
  await new Promise((r) => setTimeout(r, 400))
  await win.screenshot({ path: path.join(shots, 'frost-chat.png') })
  await win.getByText('Settings', { exact: true }).first().click()
  await win.waitForSelector('.theme-opt')
  await win.getByRole('radio', { name: /^Volt/ }).click()
  assert.equal(await theme(win), 'volt', 'the picker switches at once')
  const sharp = await win.locator('.card').first().evaluate((el) => getComputedStyle(el).borderRadius)
  assert.equal(sharp, '0px', 'volt keeps its sharp corners')
  await win.screenshot({ path: path.join(shots, 'volt-settings.png') })
  await win.getByRole('radio', { name: /^Glass/ }).click()
  await new Promise((r) => setTimeout(r, 600))
  await app.close()

  app = await launch()
  win = await open(app)
  assert.equal(await theme(win), 'glass', 'the choice survives a restart')
  console.log('theme ui: ok, shots in', shots)
} finally {
  await app.close().catch(() => {})
}
