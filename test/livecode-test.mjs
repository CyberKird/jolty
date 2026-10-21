// While the model writes a big file the page must stay clickable: the mock model streams a 4000-line HTML
// page through the real Claude engine with the Live code tab open. Before the fix the page was blocked
// about all the time and clicks stopped landing. Needs test/mocks/mock_anthropic.py on 8766.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { _electron as electron } from 'playwright-core'

const data = fs.mkdtempSync(path.join(os.tmpdir(), 'jolty-livecode-'))
const project = fs.mkdtempSync(path.join(os.tmpdir(), 'jolty-livecode-project-'))
fs.writeFileSync(path.join(data, 'profiles.json'), JSON.stringify([{ id: 'mock', name: 'Mock', engine: 'claude', auth: 'endpoint', isDefaultDir: true, baseUrl: process.env.MOCK_ANTHROPIC || 'http://127.0.0.1:8766', models: ['mock-model'], vision: false, color: '#e0a23b' }]))
fs.writeFileSync(path.join(data, 'secrets.json'), JSON.stringify({ mock: { enc: false, value: 'sk-mock' } }))
fs.writeFileSync(path.join(data, 'settings.json'), JSON.stringify({ lastCwd: project, lastProfileId: 'mock', mascot: false }))

const app = await electron.launch({
  executablePath: path.resolve('node_modules/.bin/electron'),
  args: ['--no-sandbox', path.resolve('out/main/index.js')],
  env: { ...process.env, JOLTY_DATA_DIR: data, JOLTY_TEST: '1' }
})
try {
  const win = await app.firstWindow()
  await win.setViewportSize({ width: 1400, height: 860 })
  // Manual mode: the write waits for approval, so the test ends at the card and nothing lands on disk
  await win.click('.composer .picker-btn[class*="mode-"]')
  await win.click('.picker-opt:has-text("Manual")')
  await win.evaluate(() => {
    window.__long = []
    new PerformanceObserver((l) => l.getEntries().forEach((e) => window.__long.push(Math.round(e.duration)))).observe({ type: 'longtask' })
  })
  await win.fill('.composer textarea', 'Scrie pagina. RUN_WRITE WRITE_LINES=4000 WRITE_NAME=page.html')
  await win.keyboard.press('Enter')
  const tab = win.locator('.live button', { hasText: /Cod live|Live code/ }).first()
  await tab.click()
  // measure only once the file streams (the engine takes a few seconds to start)
  await win.waitForFunction(() => (document.querySelector('.code-live pre')?.textContent.length ?? 0) > 2000, null, { timeout: 60000 })
  await win.evaluate(() => (window.__long = []))
  const clicks = []
  let shown = 0
  for (let i = 0; i < 12; i++) {
    const t = Date.now()
    await tab.click({ timeout: 5000 })
    clicks.push(Date.now() - t)
    shown = Math.max(shown, await win.evaluate(() => document.querySelector('.code-live pre')?.textContent.split('\n').length ?? 0))
    await win.waitForTimeout(400)
  }
  const long = await win.evaluate(() => window.__long)
  console.log(`clicks ${clicks.join(' ')} ms; long tasks ${long.join(' ') || 'none'}; live code shows ${shown} lines`)
  assert.ok(Math.max(...clicks) < 1000, 'a click took over a second while the file streamed')
  assert.ok(Math.max(0, ...long) < 200, 'the page blocked for over 200 ms while the file streamed')
  assert.ok(shown > 100 && shown < 400, `live code showed ${shown} lines: it should show the tail of the file while it is written`)
  await win.waitForSelector('.permission', { timeout: 60000 })
  console.log('ok')
} finally {
  await app.close()
  fs.rmSync(data, { recursive: true, force: true })
  fs.rmSync(project, { recursive: true, force: true })
}
