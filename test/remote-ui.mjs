// The phone page: a second window with no preload (like a phone's browser) pairs with the running Jolty through
// the phone link, lists the conversations and opens one. Run once and short: it opens two windows.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { _electron as electron } from 'playwright-core'

const shots = path.resolve(process.env.SHOTS || 'shots-remote')
fs.mkdirSync(shots, { recursive: true })
const data = fs.mkdtempSync(path.join(os.tmpdir(), 'jolty-remote-ui-'))
const PORT = 47823
const items = [
  { kind: 'user', id: 'u1', text: 'Make the bridge deck longer' },
  { kind: 'assistant', id: 'a1', text: 'Done. The deck is now **12 m** long.\n\n```py\nbpy.data.objects["Deck"].scale.x = 1.5\n```' }
]
fs.writeFileSync(path.join(data, 'profiles.json'), JSON.stringify([{ id: 'p1', name: 'Tools', engine: 'claude', auth: 'subscription', color: '#d97757' }]))
fs.writeFileSync(path.join(data, 'sessions.json'), JSON.stringify([{ id: 's1', profileId: 'p1', engine: 'claude', cwd: data, title: 'Blender bridge', permissionMode: 'ask', createdAt: 1, updatedAt: 1 }]))
fs.writeFileSync(path.join(data, 'settings.json'), JSON.stringify({ language: 'en', lastCwd: data }))
fs.writeFileSync(path.join(data, 'remote.json'), JSON.stringify({ enabled: true, port: PORT, devices: [] }))
fs.mkdirSync(path.join(data, 'transcripts'))
fs.writeFileSync(path.join(data, 'transcripts', 's1.json'), JSON.stringify(items))

const env = { ...process.env, JOLTY_TEST: '1', JOLTY_DATA_DIR: data }
delete env.ELECTRON_RUN_AS_NODE
const app = await electron.launch({ args: [path.resolve('out/main/index.js'), '--user-data-dir=' + path.join(data, 'electron')], env, timeout: 60000 })
try {
  const win = await app.firstWindow()
  win.setDefaultTimeout(30000)
  await win.waitForSelector('.brand-name', { timeout: 60000 })
  // the phone link is a section of Settings, only in the desktop window
  const { code } = await win.evaluate(() => window.jolty.remote.pair())
  assert.match(code, /^[0-9A-F]{10}$/)

  const opened = app.waitForEvent('window')
  await app.evaluate(({ BrowserWindow }, url) => {
    const w = new BrowserWindow({ width: 390, height: 844, show: true, webPreferences: { sandbox: true } })
    void w.loadURL(url)
  }, `http://127.0.0.1:${PORT}/#pair=${code}`)
  const phone = await opened
  phone.setDefaultTimeout(30000)
  await phone.waitForSelector('.brand-name', { timeout: 60000 })
  // a phone starts with the sidebar closed, as a drawer: the button opens it
  assert.ok(await phone.evaluate(() => document.documentElement.classList.contains('remote')))
  assert.ok(await phone.evaluate(() => document.querySelector('.app')?.classList.contains('no-sidebar')))
  await phone.locator('.titlebar-btn').first().click()
  await phone.waitForSelector('.session-item')
  // only the pages that work from a phone are offered
  assert.deepEqual(await phone.locator('.nav-item').allInnerTexts(), ['Usage'])
  assert.equal(await phone.evaluate(() => typeof window.jolty.remote), 'object')
  // the phone cannot manage the link itself
  const denied = await phone.evaluate(() => window.jolty.remote.enable(true).then(() => 'allowed', (e) => e.message))
  assert.match(denied, /Not available from the phone/)
  assert.ok(await phone.evaluate(() => Boolean(localStorage.getItem('jolty-remote-token'))), 'the key is kept on the phone')
  await phone.locator('.session-item').first().click({ position: { x: 10, y: 10 } })
  phone.on('console', (m) => m.type() === 'error' && console.log('phone console:', m.text()))
  await phone.waitForSelector('.msg-assistant .md').catch(async (e) => {
    await phone.screenshot({ path: path.join(shots, 'phone-fail.png') })
    throw e
  })
  assert.match(await phone.locator('.msg-assistant').first().innerText(), /12 m/)
  // choosing a conversation closes the drawer, and the PC-only panels are gone
  assert.ok(await phone.evaluate(() => document.querySelector('.app')?.classList.contains('no-sidebar')))
  assert.equal(await phone.locator('.live').first().isVisible(), false)
  assert.equal(await phone.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, 'nothing wider than the screen')
  await phone.screenshot({ path: path.join(shots, 'phone-chat.png') })

  // the desktop sees the paired phone
  const st = await win.evaluate(() => window.jolty.remote.status())
  assert.equal(st.running, true)
  assert.equal(st.devices.length, 1)
  // a revoked phone is sent back to pairing
  await win.evaluate((id) => window.jolty.remote.revoke(id), st.devices[0].id)
  await phone.waitForSelector('input[placeholder="Pairing code"]', { timeout: 15000 })
  console.log('remote ui ok')
} finally {
  await app.close().catch(() => undefined)
  fs.rmSync(data, { recursive: true, force: true })
}
