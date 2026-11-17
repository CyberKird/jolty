// The PC window's home screen beside the Live panel: at every window size Jolty can open in (its minimum, common laptop sizes, its
// default), opened at that size (a reload, as a launch), with the sidebar and the Live panel on, every theme and long languages. The
// headline and the starter buttons must stay inside the chat column and never under the Live panel. Fails on any overlap.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { _electron as electron } from 'playwright-core'

const out = path.resolve(process.env.SHOTS || 'shots-remote', 'layout')
fs.mkdirSync(out, { recursive: true })
const SIZES = (process.env.SIZES || '960x600,1000x700,1100x700,1180x720,1280x720,1320x860,1366x768,1600x900').split(',').map((s) => s.split('x').map(Number))
const THEMES = (process.env.THEMES || 'volt,glass,frost').split(',')
const LANGS = (process.env.LANGS || 'en,ro,de').split(',')
const long = 'A conversation title that is far too long to fit in the column next to the Live panel of a laptop window'
const report = []

for (const lang of LANGS) {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'jolty-layout-'))
  fs.writeFileSync(path.join(data, 'profiles.json'), JSON.stringify([{ id: 'p1', name: 'Tools', engine: 'claude', auth: 'subscription', color: '#d97757' }]))
  fs.writeFileSync(path.join(data, 'sessions.json'), JSON.stringify([{ id: 's1', profileId: 'p1', engine: 'claude', cwd: data, title: long, permissionMode: 'ask', createdAt: 1, updatedAt: 100 }, ...Array.from({ length: 5 }, (_, i) => ({ id: `o${i}`, profileId: 'p1', engine: 'claude', cwd: data, title: `${long} ${i}`, permissionMode: 'ask', createdAt: 1, updatedAt: 50 - i }))]))
  fs.writeFileSync(path.join(data, 'settings.json'), JSON.stringify({ language: lang, lastCwd: data }))
  const env = { ...process.env, JOLTY_TEST: '1', JOLTY_DATA_DIR: data }
  delete env.ELECTRON_RUN_AS_NODE
  const app = await electron.launch({ args: [path.resolve('out/main/index.js'), '--user-data-dir=' + path.join(data, 'electron'), '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding'], env, timeout: 60000 })
  try {
    const win = await app.firstWindow()
    win.setDefaultTimeout(30000)
    await win.waitForSelector('.brand-name', { timeout: 60000 })
    for (const theme of THEMES) {
      await win.evaluate((t) => window.jolty.app.saveSettings({ theme: t }), theme)
      for (const [w, h] of SIZES) {
        await app.evaluate(({ BrowserWindow }, [w, h]) => {
          const b = BrowserWindow.getAllWindows()[0]
          b.unmaximize()
          b.setContentSize(w, h)
        }, [w, h])
        // opened at this size (a reload mounts the app as a launch does); the Live panel opens from 1180 px up, as at a launch
        await win.evaluate(() => {
          location.reload()
        }).catch(() => undefined)
        await win.waitForSelector('.brand-name', { timeout: 60000 })
        await win.waitForTimeout(1200)
        const m = await win.evaluate(() => {
          const R = (e) => e.getBoundingClientRect()
          const live = document.querySelector('.live:not(.closed)')
          const lr = live && getComputedStyle(live).visibility !== 'hidden' ? R(live) : null
          const main = R(document.querySelector('.main'))
          const bad = []
          for (const e of document.querySelectorAll('.welcome .headline, .welcome .start, .welcome .starts, .welcome .lead, .welcome > *')) {
            const r = R(e)
            if (!r.width) continue
            const tag = `${e.className || e.tagName}`.split(' ')[0]
            if (lr && r.right > lr.left + 1 && r.left < lr.right - 1 && r.bottom > lr.top && r.top < lr.bottom) bad.push(`${tag} under the Live panel (${Math.round(r.right)} > ${Math.round(lr.left)})`)
            if (r.right > main.right + 1) bad.push(`${tag} past the chat column (${Math.round(r.right)} > ${Math.round(main.right)})`)
          }
          return { bad: [...new Set(bad)], live: lr ? Math.round(lr.width) : 0, chat: Math.round(main.width) }
        })
        const tag = `${lang}-${theme}-${w}x${h}`
        if (m.bad.length) {
          report.push({ tag, ...m })
          await win.screenshot({ path: path.join(out, `${tag}.png`) })
        }
      }
    }
  } finally {
    await app.close().catch(() => undefined)
    fs.rmSync(data, { recursive: true, force: true })
  }
}
for (const r of report) console.log(JSON.stringify(r))
console.log(`layout: ${report.length} window states with the home screen under the Live panel or past the chat column`)
if (process.env.FAILS !== '0') assert.deepEqual(report, [], 'the home screen stays clear of the Live panel at every window size')
