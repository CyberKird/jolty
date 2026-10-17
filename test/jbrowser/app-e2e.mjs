// Manual end-to-end check (needs a logged-in Claude and/or Codex on this PC): the real Jolty app, a real
// model and a real Chromium with the Jolty extension. Usage: node test/jbrowser/app-e2e.mjs [claude|codex]
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { _electron as electron } from 'playwright-core'

const engine = process.argv[2] || 'claude'
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jolty-browser-e2e-'))
const data = path.join(root, 'data')
const ext = path.join(data, 'browser-extension')
fs.mkdirSync(ext, { recursive: true })
fs.cpSync(path.resolve('browser-extension'), ext, { recursive: true })
const cwd = path.join(root, 'proj')
fs.mkdirSync(cwd)
fs.writeFileSync(path.join(data, 'settings.json'), JSON.stringify({ language: 'ro', lastCwd: cwd }))

const site = http.createServer((req, res) => {
  const page = req.url === '/second' ? '<title>Second</title><h1>Second page reached</h1>' : '<title>Jolty e2e</title><h1>Zebra-4471 landing</h1><a href="/second">Continue to the second page</a><button onclick="document.body.append(\'CLICKED-OK\')">Press me</button>'
  res.writeHead(200, { 'content-type': 'text/html' }).end(page)
})
await new Promise((r) => site.listen(0, '127.0.0.1', r))
const url = `http://127.0.0.1:${site.address().port}/`

const env = { ...process.env, JOLTY_TEST: '1', JOLTY_DATA_DIR: data }
delete env.ELECTRON_RUN_AS_NODE
const app = await electron.launch({ executablePath: path.resolve('node_modules/electron/dist/electron.exe'), args: ['out/main/index.js', '--user-data-dir=' + path.join(data, 'electron')], env })
const chrome = path.join(process.env.LOCALAPPDATA, 'ms-playwright/chromium-1234/chrome-win64/chrome.exe')
let proc
try {
  const win = await app.firstWindow()
  win.setDefaultTimeout(60000)
  await win.waitForSelector('.composer textarea')
  // the hub writes config.json into the installed extension folder when the app starts
  for (let i = 0; i < 40 && !fs.existsSync(path.join(ext, 'config.json')); i++) await new Promise((r) => setTimeout(r, 250))
  proc = spawn(chrome, [`--user-data-dir=${path.join(root, 'profile')}`, `--load-extension=${ext}`, `--disable-extensions-except=${ext}`, '--headless=new', '--no-first-run', 'about:blank'], { stdio: 'ignore' })
  await win.getByText('Conexiune', { exact: false }).first().waitFor({ timeout: 1000 }).catch(() => undefined)
  // wait for the extension to connect (the Settings status would show it; here ask the app directly)
  let connected = false
  for (let i = 0; i < 60 && !connected; i++) {
    connected = await win.evaluate(async () => (await window.jolty.browser.native()).connected)
    if (!connected) await new Promise((r) => setTimeout(r, 500))
  }
  console.log('extension connected:', connected)
  if (!connected) throw new Error('extension did not connect')

  if (engine === 'codex') {
    await win.locator('.picker-btn').first().click()
    await win.locator('.picker-group-head', { hasText: 'Codex' }).first().waitFor()
    await win.locator('.picker-group:has(.picker-group-head:has-text("Codex")) .picker-opt').first().click()
    await win.keyboard.press('Escape')
  }
  await win.locator('.chrome-toggle:has(svg.lucide-globe)').click()
  await win.fill('.composer textarea', `Use the browser tools (browser_navigate, browser_snapshot, browser_click) to open ${url} . Tell me the big heading you see, then click the link to the second page and tell me its heading, then go back and press the "Press me" button. Answer in one short line with the two headings and whether CLICKED-OK appeared.`)
  await win.keyboard.press('Enter')
  const t0 = Date.now()
  await win.waitForSelector('.dot.running', { timeout: 60000 }).catch(() => undefined)
  // approve the page actions once per site, like the user would, until the answer is in
  const deadline = Date.now() + 200000
  while (Date.now() < deadline) {
    const allow = win.getByRole('button', { name: /^Mereu pe /i })
    if (await allow.count()) await allow.first().click().catch(() => undefined)
    if (!(await win.locator('.dot.running').count()) && Date.now() - t0 > 8000) break
    await new Promise((r) => setTimeout(r, 1000))
  }
  await win.screenshot({ path: path.join(os.tmpdir(), 'jolty-e2e.png') })
  const text = await win.locator('.msg, .message, .assistant, .bubble').allInnerTexts().catch(() => [])
  const body = await win.locator('body').innerText()
  console.log(`done in ${Math.round((Date.now() - t0) / 1000)}s`)
  console.log(body.split('\n').filter((l) => /Zebra|Second page|CLICKED|browser_|jolty-browser|permisiune|Permission/i.test(l)).slice(0, 30).join('\n'))
  void text
} finally {
  proc?.kill()
  await app.close().catch(() => undefined)
  site.close()
  fs.rmSync(root, { recursive: true, force: true })
}
