// Drives the built app (Windows): closing the window hides it to the tray, a second launch shows it again,
// the global shortcut opens the quick entry box, and Enter there starts a chat on the mock model in the main window.
// Starts its own mock on MOCK_PORT (default 8830) and stops it by PID; data, HOME and APPDATA go to a temp folder.
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { _electron as electron } from 'playwright-core'

const port = Number(process.env.MOCK_PORT || 8830)
const KEY = 'Ctrl+Alt+Shift+F9'
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jolty-tray-'))
const data = path.join(root, 'data')
const project = path.join(root, 'project')
for (const d of [data, project, path.join(root, 'home'), path.join(root, 'appdata')]) fs.mkdirSync(d, { recursive: true })
fs.writeFileSync(path.join(data, 'profiles.json'), JSON.stringify([{ id: 'mock', name: 'Mock', engine: 'claude', auth: 'endpoint', isDefaultDir: true, baseUrl: `http://127.0.0.1:${port}`, models: ['mock-model'], vision: false, color: '#e0a23b' }]))
fs.writeFileSync(path.join(data, 'secrets.json'), JSON.stringify({ mock: { enc: false, value: 'sk-mock' } }))
fs.writeFileSync(path.join(data, 'settings.json'), JSON.stringify({ language: 'ro', lastCwd: project, lastProfileId: 'mock', keepInBackground: true, quickKey: KEY }))

const log = path.join(root, 'mock.log')
const mock = spawn('python', [path.resolve('test/mocks/mock_anthropic.py'), String(port), log], { stdio: 'ignore', windowsHide: true })
const env = { ...process.env, JOLTY_TEST: '1', JOLTY_DATA_DIR: data, HOME: path.join(root, 'home'), USERPROFILE: path.join(root, 'home'), APPDATA: path.join(root, 'appdata') }
delete env.ELECTRON_RUN_AS_NODE
const exe = path.resolve('node_modules/electron/dist/electron.exe')
const args = [path.resolve('out/main/index.js'), '--user-data-dir=' + path.join(root, 'electron')]
const app = await electron.launch({ executablePath: exe, args, env, timeout: 60000 })
const visible = () => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().filter((w) => w.isVisible()).map((w) => w.getTitle()))
const waitFor = async (fn, what) => {
  for (let i = 0; i < 60; i++) {
    if (await fn()) return
    await new Promise((r) => setTimeout(r, 500))
  }
  throw new Error(`timed out: ${what}`)
}
try {
  const win = await app.firstWindow()
  await win.waitForSelector('.brand-name', { timeout: 60000 })

  // close: the window hides, the app and its main window stay
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close())
  await waitFor(async () => (await visible()).length === 0, 'window hidden')
  assert.equal(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length), 1, 'main window kept')
  console.log('ok   close hides to the tray')

  // a second launch exits at once and brings the hidden window back
  execFileSync(exe, args, { env, timeout: 30000 })
  await waitFor(async () => (await visible()).length === 1, 'second launch reveals')
  console.log('ok   second launch shows the hidden window')

  // hide again, then the global shortcut (real key presses) opens the quick entry over everything
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close())
  await waitFor(async () => (await visible()).length === 0, 'hidden again')
  const quickPage = app.waitForEvent('window', { timeout: 30000 })
  execFileSync('powershell', ['-NoProfile', '-Command', "Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait('^%+{F9}')"])
  const quick = await quickPage
  await quick.waitForSelector('.quick-box textarea', { timeout: 30000 })
  await waitFor(async () => (await visible()).length === 1, 'quick entry shown')
  const box = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().filter((w) => w.isVisible()).map((w) => ({ top: w.isAlwaysOnTop(), ...w.getBounds() }))[0])
  assert.ok(box.top && box.width === 640, 'small always-on-top box')
  assert.equal(await quick.locator('.quick-pick').first().inputValue(), 'mock', 'last profile picked')
  await quick.screenshot({ path: path.join(root, 'quick.png') })
  console.log('ok   shortcut opens the quick entry', JSON.stringify(box))

  // Enter: a new chat in the main window, the message reaches the model
  await quick.fill('.quick-box textarea', 'salut din intrarea rapida')
  await quick.keyboard.press('Enter')
  await waitFor(async () => (await visible()).length === 1 && (await win.locator('.msg-user').count()) > 0, 'chat opened in the main window')
  assert.match(await win.locator('.msg-user').first().innerText(), /salut din intrarea rapida/)
  await waitFor(async () => /salut din mock/.test(await win.locator('.msg-assistant').last().innerText().catch(() => '')), 'the model answered').catch(async (e) => {
    await win.screenshot({ path: path.join(root, 'main-fail.png') })
    throw new Error(`${e.message} (shots in ${root})`)
  })
  await win.screenshot({ path: path.join(root, 'main.png') })
  console.log('ok   Enter starts the chat in the main window')
  console.log('shots in', root)
} finally {
  // Quit in the tray ends here: before-quit lets the hidden window close for real
  const pid = app.process().pid
  await app.evaluate(({ app: a }) => a.quit()).catch(() => undefined)
  await new Promise((r) => setTimeout(r, 5000))
  try {
    process.kill(pid, 0)
    console.log('FAIL app still running after quit, killing pid', pid)
    process.kill(pid)
    process.exitCode = 1
  } catch {
    console.log('ok   quit really quits')
  }
  mock.kill()
}
