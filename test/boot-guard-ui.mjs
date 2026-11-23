// The phone page must never stay on the server's bare bar (bolt only, black screen): when the app's entry script cannot be loaded
// (a copy kept on the phone is older than the PC's Jolty) the guard clears the kept copy and reloads once, then says so with a way out.
// Needs `npm run build` first. Opens one extra window; run once.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { _electron as electron } from 'playwright-core'

const data = fs.mkdtempSync(path.join(os.tmpdir(), 'jolty-boot-guard-'))
const PORT = Number(process.env.BOOT_GUARD_PORT) || 47827
fs.writeFileSync(path.join(data, 'profiles.json'), JSON.stringify([{ id: 'p1', name: 'Tools', engine: 'claude', auth: 'subscription', color: '#d97757' }]))
fs.writeFileSync(path.join(data, 'sessions.json'), '[]')
fs.writeFileSync(path.join(data, 'settings.json'), JSON.stringify({ language: 'en', lastCwd: data }))
fs.writeFileSync(path.join(data, 'remote.json'), JSON.stringify({ enabled: true, port: PORT, devices: [] }))

const env = { ...process.env, JOLTY_TEST: '1', JOLTY_DATA_DIR: data }
delete env.ELECTRON_RUN_AS_NODE
const app = await electron.launch({ args: [path.resolve('out/main/index.js'), '--user-data-dir=' + path.join(data, 'electron')], env, timeout: 60000 })
try {
  const win = await app.firstWindow()
  await win.waitForSelector('.brand-name', { timeout: 60000 })

  // the page's guard script is served and named in the page
  const html = await (await fetch(`http://127.0.0.1:${PORT}/`)).text()
  assert.match(html, /<script src="\/boot-guard\.js"><\/script>/, 'the phone page loads the boot guard')
  assert.match(html, /class="titlebar boot-shell"/, 'the server still draws its bar first')
  assert.equal((await fetch(`http://127.0.0.1:${PORT}/boot-guard.js`)).status, 200)

  // a phone window whose entry script is gone
  const opened = app.waitForEvent('window')
  await app.evaluate(({ BrowserWindow }, port) => {
    const w = new BrowserWindow({ width: 390, height: 844, useContentSize: true, show: true, webPreferences: { sandbox: true, partition: 'boot-guard-test' } })
    globalThis.__block = true
    w.webContents.session.webRequest.onBeforeRequest({ urls: [`http://127.0.0.1:${port}/assets/index-*.js`] }, (_d, cb) => cb({ cancel: globalThis.__block === true }))
    globalThis.__phone = w
    void w.loadURL(`http://127.0.0.1:${port}/`)
  }, PORT)
  const phone = await opened
  phone.setDefaultTimeout(30000)

  // first the kept copy is cleared and the page loads again; it still cannot, so the note appears (not a black screen)
  await phone.waitForSelector('[role="alert"]', { timeout: 30000 })
  const note = await phone.evaluate(() => ({ text: document.querySelector('[role="alert"]').textContent, bar: Boolean(document.querySelector('.boot-shell')) }))
  assert.match(note.text, /did not finish loading/)
  assert.match(note.text, /Clear and reload/)
  assert.match(note.text, /load failed: \/assets\/index-/, 'the last error is printed so a screenshot says what happened')
  assert.ok(note.bar, 'the bar is what the user saw before')
  const tried = await phone.evaluate(() => sessionStorage.getItem('jolty-heal'))
  assert.ok(tried, 'one automatic clean-up was made')

  // the PC serves the script again: Reload brings the app up and the note is gone
  await app.evaluate(() => void (globalThis.__block = false))
  await phone.click('text=Reload')
  await phone.waitForSelector('.pair-headline', { timeout: 30000 })
  const after = await phone.evaluate(() => ({ alert: Boolean(document.querySelector('[role="alert"]:not(.pair-error)')), bar: Boolean(document.querySelector('.boot-shell')) }))
  assert.equal(after.bar, false, 'the app took over from the bare bar')
  assert.equal(after.alert, false, 'no note over a page that loaded')
  console.log('boot guard ok')
} finally {
  await app.close().catch(() => undefined)
  fs.rmSync(data, { recursive: true, force: true })
}
