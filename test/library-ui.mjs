// The Library page, the activity map in the Live panel and the liquid context sphere, on the built app with a seeded data folder.
// Run once and short: it opens one window.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'
import { _electron as electron } from 'playwright-core'

const shots = path.resolve(process.env.SHOTS || 'shots-library')
fs.mkdirSync(shots, { recursive: true })
const data = fs.mkdtempSync(path.join(os.tmpdir(), 'jolty-library-ui-'))
// a small real PNG (a 64 x 48 gradient is enough for a tile)
const png = (r, g, b) => {
  const w = 64
  const h = 48
  const raw = Buffer.alloc((w * 3 + 1) * h)
  for (let y = 0; y < h; y++) {
    raw[y * (w * 3 + 1)] = 0
    for (let x = 0; x < w; x++) {
      const o = y * (w * 3 + 1) + 1 + x * 3
      raw[o] = Math.min(255, r + x)
      raw[o + 1] = Math.min(255, g + y)
      raw[o + 2] = b
    }
  }
  const crc = (buf) => {
    let c
    const table = []
    for (let n = 0; n < 256; n++) {
      c = n
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
      table[n] = c >>> 0
    }
    let v = 0xffffffff
    for (const byte of buf) v = table[(v ^ byte) & 0xff] ^ (v >>> 8)
    return (v ^ 0xffffffff) >>> 0
  }
  const chunk = (type, body) => {
    const len = Buffer.alloc(4)
    len.writeUInt32BE(body.length)
    const td = Buffer.concat([Buffer.from(type), body])
    const c = Buffer.alloc(4)
    c.writeUInt32BE(crc(td))
    return Buffer.concat([len, td, c])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0)
  ihdr.writeUInt32BE(h, 4)
  ihdr[8] = 8
  ihdr[9] = 2
  return `data:image/png;base64,${Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]).toString('base64')}`
}
const items = [
  { kind: 'user', id: 'u1', text: 'look at https://example.com/design and the clip', images: [{ name: 'sketch-a.png', dataUrl: png(20, 60, 200) }, { name: 'sketch-b.png', dataUrl: png(200, 40, 40) }], files: [{ name: 'brief.pdf', mime: 'application/pdf' }, { name: 'take1.mp4', mime: 'video/mp4' }, { name: 'voice.m4a', mime: 'audio/mp4' }] },
  { kind: 'assistant', id: 'a1', text: 'Reading it. Docs: https://docs.example.org/page.' },
  { kind: 'tool', id: 't1', name: 'Read', title: 'Read brief.md', status: 'done' },
  { kind: 'tool', id: 't2', name: 'Read', title: 'Read notes.md', status: 'done' },
  { kind: 'tool', id: 't3', name: 'Bash', title: '$ npm test', status: 'error', command: 'npm test', exitCode: 1 },
  { kind: 'tool', id: 't4', name: 'WebFetch', title: 'Fetch docs', status: 'running' }
]
fs.writeFileSync(path.join(data, 'profiles.json'), JSON.stringify([{ id: 'p1', name: 'Tools', engine: 'claude', auth: 'subscription', color: '#d97757' }]))
fs.writeFileSync(path.join(data, 'sessions.json'), JSON.stringify([{ id: 's1', profileId: 'p1', engine: 'claude', cwd: data, title: 'Design review', model: 'opus 5.5', permissionMode: 'ask', createdAt: 1, updatedAt: 5 }]))
fs.writeFileSync(path.join(data, 'settings.json'), JSON.stringify({ language: 'en', lastCwd: data }))
fs.mkdirSync(path.join(data, 'transcripts'))
fs.writeFileSync(path.join(data, 'transcripts', 's1.json'), JSON.stringify(items))

const env = { ...process.env, JOLTY_TEST: '1', JOLTY_DATA_DIR: data }
delete env.ELECTRON_RUN_AS_NODE
const app = await electron.launch({ args: [path.resolve('out/main/index.js'), '--user-data-dir=' + path.join(data, 'electron')], env, timeout: 60000 })
const errors = []
try {
  const win = await app.firstWindow()
  win.setDefaultTimeout(30000)
  win.on('pageerror', (e) => errors.push(String(e)))
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1500, 920))
  await win.waitForSelector('.brand-name', { timeout: 60000 })

  // the Library: kinds as chips with counts, pictures as tiles that load small, rows for the rest
  win.on('console', (m) => m.type() === 'error' && errors.push(m.text()))
  await win.locator('.nav-item', { hasText: 'Library' }).click()
  await win.waitForSelector('.lib-chip', { timeout: 8000 }).catch(async (e) => {
    await win.screenshot({ path: path.join(shots, 'library-fail.png') })
    console.log('page errors:', errors)
    throw e
  })
  const chips = await win.locator('.lib-chip').allInnerTexts()
  assert.ok(chips.some((c) => /Images/.test(c) && /2/.test(c)), `images counted: ${chips}`)
  assert.ok(chips.some((c) => /Links/.test(c) && /2/.test(c)), 'links counted')
  await win.waitForFunction(() => document.querySelectorAll('.lib-thumb img').length === 2, null, { timeout: 15000 })
  await win.waitForTimeout(500)
  await win.screenshot({ path: path.join(shots, 'library-images.png') })
  await win.locator('.lib-thumb').first().click()
  await win.waitForSelector('.lib-lightbox img')
  await win.screenshot({ path: path.join(shots, 'library-lightbox.png') })
  await win.keyboard.press('Escape')
  assert.equal(await win.locator('.lib-lightbox').count(), 0, 'Escape closes the picture')
  await win.locator('.lib-chip', { hasText: 'Links' }).click()
  assert.equal(await win.locator('.lib-row').count(), 2)
  assert.match(await win.locator('.lib-row').first().innerText(), /example\.com/)
  await win.locator('.lib-chip', { hasText: 'Videos' }).click()
  assert.match(await win.locator('.lib-row').first().innerText(), /take1\.mp4/)
  await win.locator('.lib-search input').fill('zzz')
  assert.equal(await win.locator('.lib-row').count(), 0, 'the search narrows the list')
  await win.locator('.lib-search input').fill('')

  // the conversation: the activity map with the running tool lit and the failed command counted, and the liquid sphere at the context level
  await win.locator('.session-item').first().click()
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.send('jolty:event', { type: 'context', sessionId: 's1', used: 170000, window: 200000 }))
  await win.waitForSelector('.actgraph')
  assert.equal(await win.locator('.ag-node.on').count(), 1, 'the running tool lights one place')
  assert.match(await win.locator('.ag-node.on .ag-label').textContent(), /Network/i)
  assert.equal(await win.locator('.ag-fail').count(), 1, 'the failed command is counted')
  await win.waitForSelector('.context-meter .liquid')
  assert.equal(await win.locator('.liquid.high').count(), 1, 'over 80% the liquid turns')
  await win.waitForTimeout(1600)
  await win.screenshot({ path: path.join(shots, 'chat-map.png') })
  await win.screenshot({ path: path.join(shots, 'chat-map.png') })
  const level = await win.evaluate(() => getComputedStyle(document.querySelector('.liquid')).getPropertyValue('--lvl'))
  assert.equal(Number(level), 85)
  // a lower level, close up: the liquid sphere with its surface
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.send('jolty:event', { type: 'context', sessionId: 's1', used: 70000, window: 200000 }))
  await win.waitForTimeout(1800)
  await win.locator('.context-meter').screenshot({ path: path.join(shots, 'liquid.png') })
  assert.equal(await win.locator('.liquid.high').count(), 0, 'under 80% the liquid keeps its colour')
  assert.deepEqual(errors, [])
  console.log('library ui ok')
} finally {
  await app.close().catch(() => undefined)
  fs.rmSync(data, { recursive: true, force: true })
}
