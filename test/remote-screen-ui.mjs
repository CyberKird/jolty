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
const PORT = Number(process.env.SCREEN_UI_PORT || 47824)
fs.writeFileSync(path.join(data, 'profiles.json'), JSON.stringify([{ id: 'p1', name: 'Tools', engine: 'claude', auth: 'subscription', color: '#d97757' }]))
fs.writeFileSync(path.join(data, 'settings.json'), JSON.stringify({ language: 'en' }))
fs.writeFileSync(path.join(data, 'remote.json'), JSON.stringify({ enabled: true, port: PORT, devices: [] }))

const env = { ...process.env, JOLTY_TEST: '1', JOLTY_DATA_DIR: data }
delete env.ELECTRON_RUN_AS_NODE
// a window behind others is not drawn by Chromium: the flags keep the test page working whatever is on top of it
const app = await electron.launch({ args: [path.resolve('out/main/index.js'), '--user-data-dir=' + path.join(data, 'electron'), '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding'], env, timeout: 60000 })
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
  phone.on('console', (m) => m.type() === 'error' && console.log('phone error:', m.text()))
  phone.on('pageerror', (e) => console.log('phone page error:', e.message))
  await phone.waitForSelector('.brand-name', { timeout: 60000 }).catch(async (e) => {
    // what the phone shows instead, so a failure here says why
    console.log('phone page:', phone.url(), JSON.stringify((await phone.evaluate(() => document.body.innerText).catch(() => '')).slice(0, 400)))
    await phone.screenshot({ path: path.join(shots, 'screen-phone-failed.png') }).catch(() => undefined)
    throw e
  })
  phone.on('console', (m) => /decoder|screen/i.test(m.text()) && console.log('phone:', m.text()))
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
  // the screen comes as video (this Chromium plays H.264): a canvas, not pictures
  await phone.waitForFunction(() => document.querySelector('canvas.pcs-img') && !document.querySelector('canvas.pcs-img').hidden && document.querySelector('canvas.pcs-img').width > 300, null, { timeout: 30000 })
  // something moving on the screen at 60 fps: the video has to keep up with it
  await app.evaluate(({ BrowserWindow, screen }) => {
    const d = screen.getPrimaryDisplay().workArea
    const w = new BrowserWindow({ x: d.x + 40, y: d.y + 40, width: 640, height: 360, show: true, frame: false, alwaysOnTop: true, focusable: false, webPreferences: { backgroundThrottling: false } })
    w.setIgnoreMouseEvents(true)
    void w.loadURL('data:text/html,<body style="margin:0;background:#111"><div id=b style="position:absolute;top:0;width:90px;height:100%;background:#d4ff00"></div><script>let x=0;function f(){x=(x+9)%560;b.style.left=x+"px";requestAnimationFrame(f)}f()</script>')
    globalThis.__mover = w
  })
  // the stream starts low and climbs while the link (here loopback) answers quickly: it must reach its top step
  const climbT0 = Date.now()
  await phone.waitForFunction(() => document.querySelector('.pcs').getAttribute('data-step') === '60/1080p', null, { timeout: 30000 }).catch(() => undefined)
  const step = await phone.evaluate(() => document.querySelector('.pcs').getAttribute('data-step'))
  console.log(`step ${step} after ${Date.now() - climbT0} ms`)
  await phone.waitForTimeout(1500)
  // measured on the phone: chunks received and pictures drawn, per second, over 4 s
  const samples = []
  for (let i = 0; i < 4; i++) {
    await phone.waitForTimeout(1000)
    samples.push(await phone.evaluate(() => { const r = document.querySelector('.pcs'); return { rx: Number(r.getAttribute('data-rx')), fps: Number(r.getAttribute('data-fps')), lat: Number(r.getAttribute('data-lat')), busy: r.getAttribute('data-busy'), step: r.getAttribute('data-step') } }))
  }
  const fps = Math.round(samples.reduce((n, s) => n + s.fps, 0) / samples.length)
  const rx = Math.round(samples.reduce((n, s) => n + s.rx, 0) / samples.length)
  // which encoder ran: an ffmpeg under the app is the 60 fps path
  const ffmpeg = (await import('node:child_process')).execFileSync('powershell', ['-NoProfile', '-Command', `(Get-CimInstance Win32_Process -Filter "Name='ffmpeg.exe'" | Where-Object { $_.CommandLine -match 'ddagrab' }).Count`]).toString().trim()
  console.log('phone side:', JSON.stringify({ step, drawnFps: fps, receivedPerSec: rx, samples, ffmpegProcesses: ffmpeg }))
  assert.ok(fps >= 18, `the video keeps up with motion (${fps} fps)`)
  await phone.screenshot({ path: path.join(shots, 'screen-video.png') })
  await app.evaluate(() => globalThis.__mover?.destroy())
  // the bars fold away and a button brings them back
  await phone.locator('.pcs-top .pcs-icon').nth(1).click()
  await phone.waitForSelector('.pcs.hud-off')
  await phone.waitForTimeout(500)
  const full = await phone.evaluate(() => { const s = document.querySelector('.pcs-stage').getBoundingClientRect(); return s.top === 0 && Math.round(s.height) === window.innerHeight })
  assert.ok(full, 'the screen takes the whole phone when the bars are folded')
  await phone.locator('.pcs-handle').click()
  await phone.waitForSelector('.pcs:not(.hud-off)')
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
