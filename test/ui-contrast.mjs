// Contrast on the PC window, every theme: each page is photographed with its text hidden (the true background, translucent panes and
// the aurora included) and every line of text and every icon is checked against the pixels behind it (test/remote-ui-contrast.mjs).
// Prints the lowest ratios per theme and page, writes SHOTS/contrast-desktop-<LABEL>.json, and fails on any text under its minimum
// (FAILS=0 only reports). A seeded data dir of its own: the user's real Jolty is never touched.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { _electron as electron } from 'playwright-core'
import { realContrast } from './remote-ui-contrast.mjs'

const out = path.resolve(process.env.SHOTS || 'shots-remote')
fs.mkdirSync(path.join(out, 'desktop'), { recursive: true })
const label = process.env.LABEL || 'run'
const THEMES = (process.env.THEMES || 'volt,glass,frost').split(',')
const data = fs.mkdtempSync(path.join(os.tmpdir(), 'jolty-contrast-'))
const items = [
  { kind: 'user', id: 'u1', text: 'Make the bridge deck longer' },
  { kind: 'assistant', id: 'a1', text: 'Done. The deck is now **12 m** long. See [the notes](https://example.com).\n\n```py\nbpy.data.objects["Deck"].scale.x = 1.5\n```\n\n> A quoted line\n\n| Part | Length |\n|---|---|\n| Deck | 12 m |' }
]
fs.writeFileSync(path.join(data, 'profiles.json'), JSON.stringify([{ id: 'p1', name: 'Tools', engine: 'claude', auth: 'subscription', color: '#d97757' }]))
fs.writeFileSync(path.join(data, 'sessions.json'), JSON.stringify([{ id: 's1', profileId: 'p1', engine: 'claude', cwd: data, title: 'Blender bridge', permissionMode: 'ask', createdAt: 1, updatedAt: 100 }, ...Array.from({ length: 6 }, (_, i) => ({ id: `o${i}`, profileId: 'p1', engine: 'claude', cwd: data, title: `Older ${i}`, permissionMode: 'ask', createdAt: 1, updatedAt: 50 - i }))]))
fs.writeFileSync(path.join(data, 'settings.json'), JSON.stringify({ language: 'en', lastCwd: data }))
fs.mkdirSync(path.join(data, 'transcripts'))
fs.writeFileSync(path.join(data, 'transcripts', 's1.json'), JSON.stringify(items))
const env = { ...process.env, JOLTY_TEST: '1', JOLTY_DATA_DIR: data }
delete env.ELECTRON_RUN_AS_NODE
const app = await electron.launch({ args: [path.resolve('out/main/index.js'), '--user-data-dir=' + path.join(data, 'electron'), '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding'], env, timeout: 60000 })
const report = []
try {
  const win = await app.firstWindow()
  win.setDefaultTimeout(30000)
  await win.waitForSelector('.brand-name', { timeout: 60000 })
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1440, 900))
  await win.waitForTimeout(500)
  const settle = () =>
    win.evaluate(() => Promise.race([Promise.all(document.getAnimations().filter((a) => a.effect?.getComputedTiming().iterations !== Infinity).map((a) => a.finished.catch(() => undefined))), new Promise((r) => setTimeout(r, 2000))]))
  const nav = (label) => async () => {
    await win.locator('.nav-item', { hasText: label }).first().click()
    await win.waitForSelector('.page')
    await win.waitForTimeout(1000)
  }
  const screens = {
    chat: async () => {
      await win.locator('.session-item').first().click({ position: { x: 12, y: 12 } })
      await win.waitForSelector('.msg-assistant .md')
      await win.waitForTimeout(600)
    },
    'sidebar-hover': async () => {
      await win.locator('.session-item:not(.active)').first().hover()
      await win.waitForTimeout(300)
    },
    welcome: async () => {
      await win.locator('.new-chat').first().click()
      await win.waitForTimeout(800)
    },
    settings: nav('Settings'),
    accounts: nav('Accounts'),
    usage: nav('Usage'),
    library: nav('Library'),
    schedules: nav('Scheduled'),
    skills: nav('Skills'),
    system: nav('System')
  }
  for (const t of THEMES) {
    await win.evaluate((t) => window.jolty.app.saveSettings({ theme: t }).then(() => window.dispatchEvent(new Event('jolty:settings'))), t)
    await win.waitForFunction((t) => document.documentElement.dataset.theme === t, t)
    await win.waitForTimeout(500)
    for (const [id, go] of Object.entries(screens)) {
      await win.keyboard.press('Escape').catch(() => undefined)
      await go()
      await settle()
      await win.mouse.move(2, 300)
      if (id === 'sidebar-hover') await win.locator('.session-item:not(.active)').first().hover()
      // a hover cross-fades the time and the row buttons: measured once it has settled
      await win.waitForTimeout(400)
      const bad = await realContrast(win)
      await win.screenshot({ path: path.join(out, 'desktop', `${t}-${id}.png`) })
      const low = bad.map((b) => Number(b.match(/ ([\d.]+) < /)?.[1])).filter(Number.isFinite)
      report.push({ theme: t, screen: id, lowest: low.length ? Math.min(...low) : null, bad })
    }
  }
  fs.writeFileSync(path.join(out, `contrast-desktop-${label}.json`), JSON.stringify(report, null, 1))
  for (const r of report) console.log(`${r.theme.padEnd(6)} ${r.screen.padEnd(14)} ${r.bad.length ? `lowest ${r.lowest}  ${r.bad.length} below:  ${r.bad.slice(0, 4).join(' | ')}` : 'ok'}`)
  if (process.env.FAILS !== '0') assert.deepEqual(report.filter((r) => r.bad.length), [], 'all text on the PC reads on every theme')
} finally {
  await app.close().catch(() => undefined)
  fs.rmSync(data, { recursive: true, force: true })
}
