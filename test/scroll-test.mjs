// Chat scroll: a reader who moves up from the bottom, even by a few pixels, must not be pulled back by the next resize.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { _electron as electron } from 'playwright-core'

const data = fs.mkdtempSync(path.join(os.tmpdir(), 'jolty-scroll-'))
fs.writeFileSync(path.join(data, 'profiles.json'), JSON.stringify([{ id: 'p1', name: 'Scroll', engine: 'claude', auth: 'subscription', color: '#d97757' }]))
fs.writeFileSync(path.join(data, 'sessions.json'), JSON.stringify([
  { id: 's1', profileId: 'p1', engine: 'claude', cwd: data, title: 'Scroll', permissionMode: 'ask', createdAt: 2, updatedAt: 2 },
  { id: 's2', profileId: 'p1', engine: 'claude', cwd: data, title: 'Long', permissionMode: 'ask', createdAt: 1, updatedAt: 1 }
]))
fs.writeFileSync(path.join(data, 'settings.json'), JSON.stringify({ language: 'en', lastCwd: data }))
fs.mkdirSync(path.join(data, 'transcripts'))
const items = Array.from({ length: 60 }, (_, i) => ({ kind: i % 2 ? 'assistant' : 'user', id: `i${i}`, text: `Message ${i}\n\n` + 'Some longer text to make the message tall. '.repeat(12) }))
fs.writeFileSync(path.join(data, 'transcripts', 's1.json'), JSON.stringify(items))
const long = Array.from({ length: 400 }, (_, i) => ({ kind: i % 2 ? 'assistant' : 'user', id: `l${i}`, text: `Long ${i}\n\n` + 'Text. '.repeat(30) }))
fs.writeFileSync(path.join(data, 'transcripts', 's2.json'), JSON.stringify(long))
const env = { ...process.env, JOLTY_TEST: '1', JOLTY_DATA_DIR: data }
delete env.ELECTRON_RUN_AS_NODE
const app = await electron.launch({ args: [path.resolve('out/main/index.js'), '--user-data-dir=' + path.join(data, 'electron')], env, timeout: 60000 })
const pause = (ms) => new Promise((r) => setTimeout(r, ms))
try {
  const win = await app.firstWindow()
  win.setDefaultTimeout(30000)
  await win.waitForSelector('.brand-name', { timeout: 60000 })
  await win.keyboard.press('Escape')
  await win.locator('.session-item').first().click()
  await win.waitForSelector('.messages-inner')
  await pause(1200)
  const gap = () => win.evaluate(() => { const m = document.querySelector('.messages'); return Math.round(m.scrollHeight - m.scrollTop - m.clientHeight) })
  assert.ok((await gap()) < 3, 'opens on the last message')
  const box = await win.locator('.messages').boundingBox()
  await win.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await win.mouse.wheel(0, -60)
  await pause(700)
  const up = await gap()
  assert.ok(up > 30, `moved up by the wheel (gap ${up})`)
  // the next resize (a streamed line, an image, content-visibility settling) must leave the reader where they are
  await win.evaluate(() => { const d = document.createElement('div'); d.style.height = '40px'; document.querySelector('.messages-inner').appendChild(d) })
  await pause(500)
  const after = await gap()
  assert.ok(after > 30, `still where the reader left it (gap ${after})`)
  // back to the very bottom: following resumes
  await win.mouse.wheel(0, 2000)
  await pause(700)
  await win.evaluate(() => { const d = document.createElement('div'); d.style.height = '40px'; document.querySelector('.messages-inner').appendChild(d) })
  await pause(500)
  assert.ok((await gap()) < 3, 'follows new content again at the bottom')
  console.log('PASS chat scroll: leaving the bottom is respected, following resumes at the bottom')

  // a long conversation: only the last messages are in the page, older ones come in as the reader scrolls up, without a jump
  await win.locator('.session-item', { hasText: 'Long' }).first().click()
  await win.waitForSelector('.older-marker')
  await pause(800)
  assert.ok((await gap()) < 3, 'the long conversation opens on the last message')
  const firstShown = () => win.evaluate(() => Number(document.querySelector('.messages-inner').textContent.match(/Long (\d+)/)[1]))
  const first = await firstShown()
  assert.ok(first > 0, `starts after the first message (first shown: Long ${first})`)
  await win.evaluate(() => { document.querySelector('.messages').scrollTop = 0 })
  await win.waitForFunction((f) => Number(document.querySelector('.messages-inner').textContent.match(/Long (\d+)/)[1]) < f, first)
  await pause(500)
  // the older chunk went in above: the scroll position moved down by its height, so the reader still sees the same messages
  assert.ok((await win.evaluate(() => document.querySelector('.messages').scrollTop)) > 200, 'no jump to the new top')
  console.log('PASS long chat: windowed, older messages load on scroll up without a jump')
} finally {
  await app.close()
  fs.rmSync(data, { recursive: true, force: true })
}
