// Find in the conversation (Ctrl+F) over a long, windowed chat, and the keyboard shortcuts sheet (Ctrl+/).
// One window, local data only. SHOTS=<dir> keeps the screenshots (default: a temp dir).
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { _electron as electron } from 'playwright-core'

const data = fs.mkdtempSync(path.join(os.tmpdir(), 'jolty-find-'))
const shots = process.env.SHOTS || data
fs.mkdirSync(shots, { recursive: true })
const COUNT = 500
const items = Array.from({ length: COUNT }, (_, i) => ({
  kind: i % 2 ? 'assistant' : 'user',
  id: `i${i}`,
  text: i === 4 ? 'question 4 about the needle' : i === 250 ? 'answer 250 with a **needle** in bold\n\nand a second paragraph' : i === 497 ? 'answer 497: needle, and another Needle' : i % 2 ? `answer ${i}: nothing special here, just filler text to make the line longer` : `question ${i}`
}))
fs.writeFileSync(path.join(data, 'profiles.json'), JSON.stringify([{ id: 'p1', name: 'Local', engine: 'claude', auth: 'endpoint', baseUrl: 'http://127.0.0.1:9', local: true, models: ['m'], color: '#d97757' }]))
fs.writeFileSync(path.join(data, 'sessions.json'), JSON.stringify([{ id: 's1', profileId: 'p1', engine: 'claude', cwd: data, title: 'Long chat', permissionMode: 'ask', createdAt: 1, updatedAt: 1 }]))
fs.writeFileSync(path.join(data, 'settings.json'), JSON.stringify({ language: 'ro', lastCwd: data }))
fs.mkdirSync(path.join(data, 'transcripts'))
fs.writeFileSync(path.join(data, 'transcripts', 's1.json'), JSON.stringify(items))

const env = { ...process.env, JOLTY_TEST: '1', JOLTY_DATA_DIR: data, HOME: data, USERPROFILE: data, APPDATA: path.join(data, 'appdata') }
delete env.ELECTRON_RUN_AS_NODE
const app = await electron.launch({ args: [path.resolve('out/main/index.js'), '--user-data-dir=' + path.join(data, 'electron')], env, timeout: 60000 })
const pause = (ms) => new Promise((r) => setTimeout(r, ms))
try {
  const win = await app.firstWindow()
  win.setDefaultTimeout(30000)
  await win.waitForSelector('.brand-name', { timeout: 60000 })
  await win.keyboard.press('Escape')
  await win.locator('.session-item').first().click()
  await win.waitForSelector('.messages-inner .msg-assistant')
  await pause(600)

  const inView = (id) =>
    win.evaluate((id) => {
      const el = document.querySelector(`[data-item="${id}"]`)
      const box = document.querySelector('.messages').getBoundingClientRect()
      if (!el) return false
      const r = el.getBoundingClientRect()
      return r.bottom > box.top && r.top < box.bottom
    }, id)
  const current = () => win.evaluate(() => [...(CSS.highlights.get('find-current') || [])].map((r) => r.toString()))
  const all = () => win.evaluate(() => [...(CSS.highlights.get('find-all') || [])].length)
  const count = () => win.locator('.find-count').innerText()

  assert.equal(await win.locator('[data-item="i4"]').count(), 0, 'item 4 starts outside the window')

  // 1. Ctrl+F opens the bar with the field focused; the first hit is a message that is not in the page yet
  await win.keyboard.press('Control+f')
  await win.waitForSelector('.find-bar')
  assert.ok(await win.evaluate(() => document.activeElement?.classList.contains('find-input')), 'the field has focus')
  await win.keyboard.type('NEEDLE')
  await pause(500)
  assert.equal(await count(), '1 / 4')
  assert.ok(await inView('i4'), 'the oldest hit was loaded and scrolled to')
  assert.deepEqual(await current(), ['needle'], 'the hit is highlighted inside the message')
  await win.screenshot({ path: path.join(shots, 'find-1-old.png') })

  // 2. Enter goes on, inside a markdown message; Shift+Enter goes back and wraps
  await win.keyboard.press('Enter')
  await pause(400)
  assert.equal(await count(), '2 / 4')
  assert.ok(await inView('i250'))
  assert.deepEqual(await current(), ['needle'])
  assert.ok((await all()) >= 2, 'the other hits on screen are lit too')
  await win.screenshot({ path: path.join(shots, 'find-2-bold.png') })
  await win.keyboard.press('Shift+Enter')
  await pause(300)
  await win.keyboard.press('Shift+Enter')
  await pause(500)
  assert.equal(await count(), '4 / 4', 'Shift+Enter wraps to the last hit')
  assert.ok(await inView('i497'))
  assert.deepEqual(await current(), ['Needle'], 'the second hit of the same message')
  await win.keyboard.press('Enter')
  await pause(400)
  assert.equal(await count(), '1 / 4', 'Enter wraps to the first')
  assert.ok(await inView('i4'))

  // 3. nothing found, then Esc closes and gives the focus back to the composer
  await win.keyboard.type('zzzz')
  await pause(300)
  assert.equal(await win.locator('.find-count.none').count(), 1)
  assert.equal(await all(), 0)
  await win.keyboard.press('Escape')
  await win.waitForSelector('.find-bar', { state: 'detached' })
  assert.equal(await all(), 0, 'closing clears the highlights')
  assert.ok(await win.evaluate(() => document.activeElement?.tagName === 'TEXTAREA'), 'focus is back in the composer')

  // 4. Ctrl+K still searches the conversations
  await win.keyboard.press('Control+k')
  await pause(300)
  assert.ok(await win.evaluate(() => document.activeElement?.closest('.search') !== null), 'Ctrl+K focuses the sidebar search')
  await win.keyboard.press('Escape')

  // 5. the shortcuts sheet
  await win.locator('.composer textarea').focus()
  await win.keyboard.press('Control+/')
  await win.waitForSelector('.keys')
  const rows = await win.locator('.keys-row').count()
  assert.ok(rows >= 15, `the sheet lists the shortcuts (${rows})`)
  assert.equal(await win.locator('.keys-group').count(), 3)
  const chips = await win.locator('.keys-row kbd').allInnerTexts()
  for (const k of ['Ctrl', 'N', 'K', 'B', 'L', 'F', '1-9', 'Shift', 'Tab', 'Enter']) assert.ok(chips.includes(k), k)
  await pause(400)
  await win.screenshot({ path: path.join(shots, 'shortcuts.png') })
  await win.keyboard.press('Escape')
  await win.waitForSelector('.keys', { state: 'detached' })
  await win.keyboard.press('Control+/')
  await win.waitForSelector('.keys')
  await win.keyboard.press('Control+/')
  await win.waitForSelector('.keys', { state: 'detached' })

  // 6. the same sheet from Settings
  await win.locator('.nav-item').last().click()
  await win.waitForSelector('[role=tab]')
  await win.locator('[role=tab]').last().click()
  const open = win.locator('.card.row', { has: win.locator('svg.lucide-keyboard') }).locator('button')
  await open.click()
  await win.waitForSelector('.keys')
  console.log('find + shortcuts ok, screenshots: ' + shots)
} finally {
  await app.close()
}
