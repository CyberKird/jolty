// The PC screen on the phone, for real: the app's own capture and input helper, a second window with no preload standing in
// for the phone. It checks the "off" state, then pictures arriving, the cursor, the display chips, the keys sheet and that the
// PC window shows who is looking. It only ever moves the pointer to where it already is: nothing is clicked on the machine.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { _electron as electron } from 'playwright-core'
import { WebSocket } from 'ws'

const shots = path.resolve(process.env.SHOTS || 'shots-remote')
fs.mkdirSync(shots, { recursive: true })
const data = fs.mkdtempSync(path.join(os.tmpdir(), 'jolty-screen-ui-'))
const PORT = 47824
fs.writeFileSync(path.join(data, 'profiles.json'), JSON.stringify([{ id: 'p1', name: 'Tools', engine: 'claude', auth: 'subscription', color: '#d97757' }]))
fs.writeFileSync(path.join(data, 'settings.json'), JSON.stringify({ language: 'en' }))
fs.writeFileSync(path.join(data, 'remote.json'), JSON.stringify({ enabled: true, port: PORT, devices: [] }))

const env = { ...process.env, JOLTY_TEST: '1', JOLTY_DATA_DIR: data }
delete env.ELECTRON_RUN_AS_NODE
const app = await electron.launch({ args: [path.resolve('out/main/index.js'), '--user-data-dir=' + path.join(data, 'electron')], env, timeout: 60000 })
try {
  const win = await app.firstWindow()
  win.setDefaultTimeout(30000)
  await win.waitForSelector('.brand-name', { timeout: 60000 })
  const { code } = await win.evaluate(() => window.jolty.remote.pair())
  const opened = app.waitForEvent('window')
  await app.evaluate(({ BrowserWindow }, url) => {
    const w = new BrowserWindow({ width: 390, height: 844, useContentSize: true, show: true, webPreferences: { sandbox: true } })
    void w.loadURL(url)
  }, `http://127.0.0.1:${PORT}/#pair=${code}`)
  const phone = await opened
  phone.setDefaultTimeout(30000)
  await phone.waitForSelector('.brand-name', { timeout: 60000 })
  await phone.locator('.titlebar-btn').first().click()
  await phone.locator('.pc-screen-btn').click()

  // 1. off at the PC: the phone says so
  await phone.waitForSelector('.pcs-state h2')
  assert.match(await phone.locator('.pcs-state h2').innerText(), /off/i)
  await phone.screenshot({ path: path.join(shots, 'screen-off.png') })

  // 2. the phone cannot switch it on by itself
  const refused = await phone.evaluate(() => window.jolty.app.saveSettings({ remoteScreen: true }).then(() => window.jolty.app.settings()).then((s) => s.remoteScreen === true))
  assert.equal(refused, false, 'remoteScreen is not a setting the phone may change')

  // 3. switched on at the PC
  await win.evaluate(() => window.jolty.app.saveSettings({ remoteScreen: true }))
  await phone.locator('.pcs-state .btn').click()
  await phone.waitForSelector('.pcs-dot.ok', { timeout: 60000 })
  const natural = await phone.evaluate(() => document.querySelector('.pcs-img').naturalWidth)
  assert.ok(natural > 300, `a picture arrived (${natural}px wide)`)
  await phone.screenshot({ path: path.join(shots, 'screen-live.png') })

  // 4. the PC window knows, and can end it
  await win.waitForSelector('.screen-bar')
  const status = await win.evaluate(() => window.jolty.remote.status())
  assert.equal(status.screen.viewers, 1)

  // 5. the pointer moves to where it already is (nothing changes on the machine), through the real helper
  await phone.evaluate(() => document.querySelector('.pcs-stage').dispatchEvent(new Event('noop')))
  // the real input helper: a second client sends a move to where the pointer already is, which starts and compiles it
  const where = await app.evaluate(({ screen }) => {
    const d = screen.getAllDisplays()[0]
    const r = screen.dipToScreenRect(null, d.bounds)
    const p = screen.dipToScreenPoint(screen.getCursorScreenPoint())
    return { x: (p.x - r.x) / (r.width - 1), y: (p.y - r.y) / (r.height - 1), inside: p.x >= r.x && p.y >= r.y && p.x < r.x + r.width && p.y < r.y + r.height }
  })
  if (where.inside) {
    const pairCode = (await win.evaluate(() => window.jolty.remote.pair())).code
    const token = await new Promise((resolve) => {
      const r = http.request({ host: '127.0.0.1', port: PORT, path: '/api/pair', method: 'POST' }, (x) => {
        let t = ''
        x.on('data', (c) => (t += c))
        x.on('end', () => resolve(JSON.parse(t).token))
      })
      r.end(JSON.stringify({ code: pairCode }))
    })
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`)
    await new Promise((resolve) => ws.on('open', resolve))
    ws.send(JSON.stringify({ t: 'auth', token }))
    ws.send(JSON.stringify({ t: 'screen', op: 'start', display: 0 }))
    ws.send(JSON.stringify({ t: 'screen', op: 'move', x: where.x, y: where.y }))
    const helperDir = path.join(data, 'computer')
    for (let i = 0; i < 90 && !(fs.existsSync(helperDir) && fs.readdirSync(helperDir).some((f) => f.endsWith('.exe'))); i++) await new Promise((r) => setTimeout(r, 1000))
    assert.ok(fs.readdirSync(helperDir).some((f) => f.endsWith('.exe')), 'the input helper was built and started by a phone move')
    ws.close()
  }
  const chips = await phone.locator('.pcs-chip').count()
  assert.ok(chips >= 1, 'display chips')
  if (chips > 1) {
    await phone.locator('.pcs-chip').nth(1).click()
    await phone.waitForFunction(() => document.querySelectorAll('.pcs-chip.on').length === 1 && document.querySelectorAll('.pcs-chip')[1].classList.contains('on'))
    await phone.waitForTimeout(1200)
    await phone.screenshot({ path: path.join(shots, 'screen-display2.png') })
    await phone.locator('.pcs-chip').nth(0).click()
  }

  // 6. keys sheet
  await phone.getByText('Keys', { exact: true }).click()
  await phone.waitForSelector('.pcs-keys')
  await phone.screenshot({ path: path.join(shots, 'screen-keys.png') })

  // 7. Stop at the PC ends it for the phone
  await win.locator('.screen-bar .btn').click()
  await phone.waitForSelector('.pcs-state h2')
  assert.match(await phone.locator('.pcs-state h2').innerText(), /stopped at the PC/i)
  await win.waitForFunction(() => !document.querySelector('.screen-bar'))

  // 8. switching the setting off ends a new view too
  await win.evaluate(() => window.jolty.app.saveSettings({ remoteScreen: false }))
  await phone.locator('.pcs-state .btn').click()
  await phone.waitForSelector('.pcs-state h2')
  assert.match(await phone.locator('.pcs-state h2').innerText(), /off/i)
  console.log('remote screen ui ok')
} finally {
  await app.close().catch(() => undefined)
  fs.rmSync(data, { recursive: true, force: true })
}
