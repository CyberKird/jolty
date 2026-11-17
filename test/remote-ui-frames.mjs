// Frame times on the phone while it animates: every interaction that moves something (drawer, pages, a conversation, the model menu,
// the theme) is recorded frame by frame with requestAnimationFrame, with the CPU slowed down to a phone's (CPU=4 by default).
// A long frame is one that took more than 1.5 idle frames. Writes SHOTS/frames-<LABEL>.json, so a run before a change and one
// after it can be compared. FAIL_LONG=<n> fails when an interaction has more than n long frames.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { openPhone } from './remote-ui-phone.mjs'

const out = path.resolve(process.env.SHOTS || 'shots-remote')
fs.mkdirSync(out, { recursive: true })
const label = process.env.LABEL || 'run'
const THEMES = (process.env.THEMES || 'volt,glass,frost').split(',')
const p = await openPhone({ port: 47826, prefix: 'jolty-remote-frames-' })
const results = []
try {
  await p.cdp.send('Emulation.setCPUThrottlingRate', { rate: Number(process.env.CPU || 4) })
  const record = async (action, ms = 900) => {
    await p.phone.evaluate(() => {
      const w = window
      w.__f = []
      w.__on = true
      let last = performance.now()
      const tick = (t) => {
        w.__f.push(t - last)
        last = t
        if (w.__on) requestAnimationFrame(tick)
      }
      requestAnimationFrame(tick)
    })
    await action()
    await p.phone.waitForTimeout(ms)
    return p.phone.evaluate(() => {
      window.__on = false
      return window.__f.slice(1)
    })
  }
  // one frame of this screen: the median over a quiet second taken after the page has settled (the first second after opening is busy)
  await p.phone.waitForTimeout(1500)
  const idle = await record(async () => undefined, 1000)
  const base = Math.min(1000 / 60, [...idle].sort((a, b) => a - b)[Math.floor(idle.length / 2)])
  const stats = (f) => {
    const s = [...f].sort((a, b) => a - b)
    return { frames: f.length, median: +s[Math.floor(s.length / 2)].toFixed(1), p95: +s[Math.floor(s.length * 0.95)].toFixed(1), worst: +s[s.length - 1].toFixed(1), long: f.filter((x) => x > base * 1.5).length }
  }
  const actions = {
    'drawer open': () => p.drawer(true),
    'drawer close': () => p.drawer(false),
    'open conversation': async () => {
      await p.drawer(true)
      await p.phone.locator('.session-item').first().click({ position: { x: 12, y: 12 } })
    },
    'open settings': () => p.nav('Settings'),
    'open usage': () => p.nav('Usage'),
    'model menu': async () => {
      await p.openChat()
      await p.phone.locator('.composer-bar .picker > .picker-btn').first().click()
    }
  }
  for (const t of THEMES) {
    await p.theme(t)
    for (const [name, go] of Object.entries(actions)) {
      await p.closeAll()
      await p.phone.waitForTimeout(300)
      results.push({ theme: t, action: name, ...stats(await record(go)) })
    }
    const next = THEMES[(THEMES.indexOf(t) + 1) % THEMES.length]
    results.push({ theme: t, action: `theme to ${next}`, ...stats(await record(() => p.theme(next))) })
    await p.theme(t)
  }
  const file = path.join(out, `frames-${label}.json`)
  fs.writeFileSync(file, JSON.stringify({ base: +base.toFixed(1), results }, null, 1))
  console.log(`idle frame ${base.toFixed(1)} ms`)
  for (const r of results) console.log(`${r.theme.padEnd(6)} ${r.action.padEnd(20)} frames ${String(r.frames).padStart(3)}  median ${r.median}  p95 ${r.p95}  worst ${r.worst}  long ${r.long}`)
  console.log(`frames written to ${file}`)
  if (process.env.FAIL_LONG) for (const r of results) assert.ok(r.long <= Number(process.env.FAIL_LONG), `${r.theme} ${r.action}: ${r.long} long frames`)
} finally {
  await p.close()
}
