// The message box's bar with a model that has a very long name (an abliterated community model): nothing is cut that should not be,
// nothing overlaps, and the switches and the send button stay in reach, at several window widths and in the three themes.
// Local data only. SHOTS=<folder> keeps screenshots there.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { _electron as electron } from 'playwright-core'

const data = fs.mkdtempSync(path.join(os.tmpdir(), 'jolty-composer-ui-'))
const shots = process.env.SHOTS || data
fs.mkdirSync(shots, { recursive: true })
const LONG = 'pqhaz/DeepSeek-V4.1-Flash-1017-abliterated-heretic-Q4_K_M'
fs.writeFileSync(
  path.join(data, 'profiles.json'),
  JSON.stringify([
    { id: 'long', name: 'NanoGPT', engine: 'claude', auth: 'endpoint', baseUrl: 'http://127.0.0.1:9', models: [LONG], color: '#38b2c2' },
    { id: 'short', name: 'Claude', engine: 'claude', auth: 'endpoint', baseUrl: 'http://127.0.0.1:9', models: ['sonnet'], color: '#d97757' }
  ])
)
fs.writeFileSync(path.join(data, 'sessions.json'), JSON.stringify([{ id: 's1', profileId: 'long', engine: 'claude', cwd: data, title: 'Uses the PC', permissionMode: 'ask', computer: true, browser: true, createdAt: 1, updatedAt: 1 }]))
fs.writeFileSync(path.join(data, 'settings.json'), JSON.stringify({ language: 'en', lastCwd: path.join(data, 'Cursor joltarise website'), lastProfileId: process.env.PROFILE || 'long', lastComposer: { computer: true, browser: true } }))
fs.mkdirSync(path.join(data, 'Cursor joltarise website'), { recursive: true })

const env = { ...process.env, JOLTY_TEST: '1', JOLTY_DATA_DIR: data, HOME: data, APPDATA: path.join(data, 'appdata') }
delete env.ELECTRON_RUN_AS_NODE
const pause = (ms) => new Promise((r) => setTimeout(r, ms))
const app = await electron.launch({ args: [path.resolve('out/main/index.js'), '--user-data-dir=' + path.join(data, 'electron')], env, timeout: 60000 })
let failed = 0
const check = (ok, what) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${what}`)
  if (!ok) failed++
}
try {
  const win = await app.firstWindow()
  win.setDefaultTimeout(30000)
  await win.waitForSelector('.composer-bar', { timeout: 60000 })
  await pause(1500)
  // the Computer switch of an existing chat is kept when Jolty starts (it used to be wiped at every start)
  const saved = JSON.parse(fs.readFileSync(path.join(data, 'sessions.json'), 'utf8'))
  check(saved.find((x) => x.id === 's1')?.computer === true, 'a chat with Computer on still has it on after the start')
  for (const theme of ['volt', 'glass', 'frost']) {
    await win.evaluate((t) => document.documentElement.setAttribute('data-theme', t), theme)
    for (const width of [1900, 1500, 1200, 900]) {
      await app.evaluate(({ BrowserWindow }, w) => BrowserWindow.getAllWindows()[0].setContentSize(w, 900), width)
      await pause(500)
      const r = await win.evaluate(() => {
        const bar = document.querySelector('.composer-bar')
        const barBox = bar.getBoundingClientRect()
        const kids = [...bar.children].filter((k) => k.getBoundingClientRect().width > 0 && getComputedStyle(k).display !== 'none')
        const boxes = kids.map((k) => ({ cls: k.className, text: (k.textContent || '').trim().slice(0, 30), r: k.getBoundingClientRect() }))
        const overlap = []
        for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) {
          const a = boxes[i].r, b = boxes[j].r
          if (a.left < b.right - 1 && b.left < a.right - 1 && a.top < b.bottom - 1 && b.top < a.bottom - 1) overlap.push(boxes[i].text + ' x ' + boxes[j].text)
        }
        const modeBtn = bar.querySelector('.picker-btn[class*="mode-"] .ellipsis')
        const clipped = [...bar.querySelectorAll('.picker-btn .ellipsis, .chrome-toggle span')].filter((e) => e.scrollWidth > e.clientWidth + 1).map((e) => (e.textContent || '').trim())
        const send = bar.querySelector('.send-btn:last-of-type, .send-btn.primary')
        return {
          overflowX: bar.scrollWidth > bar.clientWidth + 1,
          overlap,
          clipped,
          modeText: modeBtn?.textContent,
          modeClipped: modeBtn ? modeBtn.scrollWidth > modeBtn.clientWidth + 1 : null,
          rows: new Set(boxes.map((b) => Math.round(b.r.top / 10))).size,
          sendInside: send ? send.getBoundingClientRect().right <= barBox.right + 1 : null,
          browserOn: [...bar.querySelectorAll('.chrome-toggle')].map((c) => (c.textContent || '').trim() + ':' + c.classList.contains('on'))
        }
      })
      const tag = `${theme} ${width}px`
      await win.screenshot({ path: path.join(shots, `composer-${process.env.PROFILE || 'long'}-${theme}-${width}.png`) })
      check(!r.overflowX, `${tag}: the bar does not overflow sideways`)
      check(r.overlap.length === 0, `${tag}: nothing overlaps (${r.overlap.join('; ')})`)
      check(r.modeClipped === false, `${tag}: the permission label is whole ("${r.modeText}")`)
      check(r.sendInside !== false, `${tag}: the send button stays inside the bar`)
    }
  }
} finally {
  const proc = app.process()
  await Promise.race([app.close().catch(() => undefined), pause(10000)])
  if (proc.exitCode === null) proc.kill()
  fs.rmSync(path.join(data, 'electron'), { recursive: true, force: true })
}
console.log(failed ? `\n${failed} check(s) failed. Screenshots: ${shots}` : '\nall good')
process.exit(failed ? 1 : 0)
