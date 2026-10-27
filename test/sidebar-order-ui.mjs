// The sidebar: the conversation list's scrollbar is not covered by the width handle, and the sections (pages and
// project groups) can be reordered by drag or Alt+Up/Down, and stay that way after a reload. One window, local data only.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { _electron as electron } from 'playwright-core'

const data = fs.mkdtempSync(path.join(os.tmpdir(), 'jolty-sidebar-'))
fs.writeFileSync(path.join(data, 'profiles.json'), JSON.stringify([{ id: 'p1', name: 'Local', engine: 'claude', auth: 'endpoint', baseUrl: 'http://127.0.0.1:9', local: true, models: ['m'], color: '#d97757' }]))
const sessions = []
for (const [g, dir] of ['alpha', 'beta', 'gamma'].entries()) {
  for (let i = 0; i < 14; i++) sessions.push({ id: `s${g}-${i}`, profileId: 'p1', engine: 'claude', cwd: path.join(data, dir), title: `${dir} chat ${i}`, permissionMode: 'ask', createdAt: 1, updatedAt: 1000 - g * 100 - i })
}
fs.writeFileSync(path.join(data, 'sessions.json'), JSON.stringify(sessions))
fs.writeFileSync(path.join(data, 'settings.json'), JSON.stringify({ language: 'en', lastCwd: data }))
fs.mkdirSync(path.join(data, 'transcripts'))

const env = { ...process.env, JOLTY_TEST: '1', JOLTY_DATA_DIR: data }
delete env.ELECTRON_RUN_AS_NODE
const app = await electron.launch({ args: [path.resolve('out/main/index.js'), '--user-data-dir=' + path.join(data, 'electron')], env, timeout: 60000 })
const pause = (ms) => new Promise((r) => setTimeout(r, ms))
try {
  const win = await app.firstWindow()
  win.setDefaultTimeout(30000)
  await win.waitForSelector('.brand-name', { timeout: 60000 })
  await win.keyboard.press('Escape')

  // 1. the scrollbar is a real target: whatever is at its pixels is not the width handle
  const list = win.locator('.session-list')
  const hit = await list.evaluate((el) => {
    const r = el.getBoundingClientRect()
    const bar = el.offsetWidth - el.clientWidth
    const top = document.elementFromPoint(r.right - bar / 2, r.top + r.height / 2)
    const resizer = document.querySelector('.resizer-x').getBoundingClientRect()
    return { scrolls: el.scrollHeight > el.clientHeight, bar, onList: top === el, overlap: r.right - bar < resizer.right && r.right > resizer.left }
  })
  assert.ok(hit.scrolls, 'the list is long enough to scroll')
  assert.ok(hit.bar > 0, 'the list shows a scrollbar')
  assert.ok(hit.onList, 'the scrollbar pixels belong to the list')
  assert.ok(!hit.overlap, 'the width handle does not overlap the scrollbar')

  // 2. pages: drag the last one (Settings) onto the first (Import sessions)
  const names = () => win.locator('.nav-item').allInnerTexts().then((t) => t.map((x) => x.replace(/\d+$/, '').trim())) // without the Skills badge
  const before = await names()
  await win.locator('.nav-item').last().dragTo(win.locator('.nav-item').first())
  const after = await names()
  assert.equal(after[0], before.at(-1), 'dragging moves the page up')
  assert.equal(after.length, before.length)
  // Alt+Down moves it back one place
  await win.locator('.nav-item').first().focus()
  await win.keyboard.press('Alt+ArrowDown')
  assert.equal((await names())[1], before.at(-1), 'Alt+Down moves it one place down')

  // 3. project groups: gamma onto alpha
  // the titles are shown in capitals by CSS
  const groups = () => win.locator('.session-group-title').allInnerTexts().then((t) => t.map((x) => x.trim().toLowerCase()))
  const g0 = await groups()
  assert.deepEqual(g0, ['alpha', 'beta', 'gamma'])
  // the titles are far apart in a long list, so the drag is played as the events a drag fires
  await win.evaluate(async () => {
    const [from, to] = ['GAMMA', 'ALPHA'].map((n) => [...document.querySelectorAll('.session-group-title')].find((t) => t.textContent.trim().toUpperCase() === n))
    const dataTransfer = new DataTransfer()
    // a render in between, as in a real drag: the handlers read the drag state set by the one before
    for (const [el, type] of [[from, 'dragstart'], [to, 'dragover'], [to, 'drop'], [from, 'dragend']]) {
      el.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer }))
      await new Promise((r) => setTimeout(r, 80))
    }
  })
  assert.deepEqual(await groups(), ['gamma', 'alpha', 'beta'])

  // 4. it is remembered
  const savedNav = await names()
  await win.reload()
  await win.waitForSelector('.brand-name')
  assert.deepEqual(await names(), savedNav, 'page order survives a reload')
  assert.deepEqual(await groups(), ['gamma', 'alpha', 'beta'], 'group order survives a reload')
  const shot = path.join(data, 'sidebar.png')
  await win.locator('.sidebar').screenshot({ path: shot })
  console.log('sidebar order ok, screenshot: ' + shot)
} finally {
  const proc = app.process()
  await Promise.race([app.close().catch(() => undefined), pause(10000)])
  if (proc.exitCode === null) proc.kill()
}
