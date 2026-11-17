// Every phone screen x every theme x every phone size, measured (test/remote-ui-measure.mjs): nothing past the edges, no sideways
// scroll, no label cut short, tap targets of 44 px, none on top of another, text readable on the real pixels behind it
// (test/remote-ui-contrast.mjs), and no frame of an animation wider than the screen. One Electron, one phone window that is
// resized and re-themed in place; screenshots go to SHOTS/matrix. FAILS=0 only reports (to look at), the default fails on any finding.
// THEMES, SIZES (WxH,...) and SCREENS narrow the run.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { realContrast } from './remote-ui-contrast.mjs'
import { measurePhone } from './remote-ui-measure.mjs'
import { openPhone } from './remote-ui-phone.mjs'

const shots = path.resolve(process.env.SHOTS || 'shots-remote', 'matrix')
fs.mkdirSync(shots, { recursive: true })
const THEMES = (process.env.THEMES || 'volt,glass,frost').split(',')
// small Android, common Android, iPhone, iPhone Pro Max, a short screen, two phones on their side
// a folded phone's cover screen, small Android, Pixel/Galaxy (20:9), iPhone, Pixel XL, iPhone Pro Max, an unfolded foldable, a short
// screen, and two phones on their side
const SIZES = (process.env.SIZES || '280x653,320x568,360x800,390x844,412x915,430x932,600x900,375x560,844x390,932x430').split(',').map((s) => s.split('x').map(Number))
// the notch or Dynamic Island and the home bar (portrait), the cutout on the side (landscape), Android's gesture bar
const INSETS = (w, h) => (process.env.INSETS === '0' ? null : w > h ? { left: 47, right: 47, bottom: 21 } : w >= 390 ? { top: 47, bottom: 34 } : { top: 24, bottom: 24 })
const ONLY = process.env.SCREENS ? process.env.SCREENS.split(',') : null

const p = await openPhone({ port: 47825, prefix: 'jolty-remote-matrix-', lang: process.env.LANG_UI || 'en' })
// MOTION=reduced or off runs the matrix with the phone's own Animations setting
if (process.env.MOTION) await p.phone.evaluate((m) => window.dispatchEvent(new StorageEvent('storage', { key: 'jolty-motion', newValue: (localStorage.setItem('jolty-motion', m), m) })), process.env.MOTION)
const report = []
try {
  for (const t of THEMES) {
    await p.theme(t)
    for (const [w, h] of SIZES) {
      await p.resize(w, h)
      if (!(await p.insets(INSETS(w, h)))) console.log('safe-area insets cannot be emulated in this Chromium; checked without them')
      for (const [id, go] of Object.entries(p.screens)) {
        if (ONLY && !ONLY.includes(id)) continue
        const tag = `${t}-${w}x${h}-${id}`
        await p.closeAll()
        // every frame while the screen arrives: an animation that pushes something past the edge makes a pane wider than the screen
        await p.phone.evaluate(() => {
          window.__wide = []
          window.__sample = true
          const tick = () => {
            for (const e of document.querySelectorAll('body, #root, .app, .main, .messages, .page, .sidebar, .welcome, .sheet, .pcs')) {
              if (e.scrollWidth > e.clientWidth + 1 && e.clientWidth > 0) window.__wide.push(`${e.tagName.toLowerCase()}.${String(e.className).split(' ')[0]} ${e.scrollWidth} > ${e.clientWidth}`)
            }
            if (window.__sample) requestAnimationFrame(tick)
          }
          requestAnimationFrame(tick)
        })
        try {
          await go()
        } catch (e) {
          report.push({ tag, failed: [String(e.message).split(/\r?\n/)[0]] })
          continue
        }
        // what is still arriving (a page, a fade) is measured where it ends, not halfway
        await p.phone.evaluate(() => Promise.race([Promise.all(document.getAnimations().filter((a) => a.effect?.getComputedTiming().iterations !== Infinity).map((a) => a.finished.catch(() => undefined))), new Promise((r) => setTimeout(r, 2000))]))
        const m = await p.phone.evaluate(measurePhone)
        // readable on the pixels really behind it (glass panes, aurora, blur): the open drawer is what lies on top when it is open
        m.contrast = await realContrast(p.phone, id.startsWith('drawer') ? '.sidebar' : 'body')
        m.motion = await p.phone.evaluate(() => {
          window.__sample = false
          return [...new Set(window.__wide)].slice(0, 6)
        })
        const bad = Object.entries(m).filter(([, v]) => v.length)
        await p.phone.screenshot({ path: path.join(shots, `${tag}.png`) })
        if (bad.length) report.push({ tag, ...Object.fromEntries(bad) })
      }
      await p.closeAll()
    }
  }
  fs.writeFileSync(path.join(shots, 'report.json'), JSON.stringify(report, null, 1))
  for (const r of report) console.log(JSON.stringify(r))
  console.log(`remote ui matrix: ${report.length} screens with findings, report in ${path.join(shots, 'report.json')}`)
  if (process.env.FAILS !== '0') assert.deepEqual(report, [], 'every phone screen is clean on every theme and size')
} finally {
  await p.close()
}
