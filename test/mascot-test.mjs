// Drives the built app on the mock model and checks that Jolty the mascot follows what happens:
// he stands on the composer, types while a turn runs, points at an approval card, cheers when the turn
// ends, can be thrown with the mouse and hides from his own menu. Needs test/mocks/mock_anthropic.py on 8766.
import { _electron as electron } from 'playwright-core'
import fs from 'fs'
import os from 'os'
import path from 'path'

const out = process.env.SHOTS || path.resolve('shots')
const data = process.env.JOLTY_DATA_DIR || fs.mkdtempSync(path.join(os.tmpdir(), 'jolty-mascot-'))
fs.mkdirSync(out, { recursive: true })
fs.mkdirSync(data, { recursive: true })
const project = fs.mkdtempSync(path.join(os.tmpdir(), 'jolty-mascot-project-'))
fs.writeFileSync(
  path.join(data, 'profiles.json'),
  JSON.stringify([{ id: 'mock', name: 'Mock', engine: 'claude', auth: 'endpoint', isDefaultDir: true, baseUrl: process.env.MOCK_ANTHROPIC || 'http://127.0.0.1:8766', models: ['mock-model'], vision: false, color: '#e0a23b' }])
)
fs.writeFileSync(path.join(data, 'secrets.json'), JSON.stringify({ mock: { enc: false, value: 'sk-mock' } }))
fs.writeFileSync(path.join(data, 'settings.json'), JSON.stringify({ lastCwd: project, lastProfileId: 'mock' }))

const app = await electron.launch({
  executablePath: path.resolve('node_modules/.bin/electron'),
  args: ['--no-sandbox', path.resolve('out/main/index.js')],
  env: { ...process.env, JOLTY_DATA_DIR: data, JOLTY_TEST: '1' }
})
const failures = []
const check = (ok, what) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`)
  if (!ok) failures.push(what)
}
try {
  const win = await app.firstWindow()
  await win.setViewportSize({ width: 1400, height: 860 })
  const errors = []
  win.on('pageerror', (e) => errors.push(String(e)))
  const shot = (name) => win.screenshot({ path: path.join(out, `mascot-${name}.png`) })

  // every pose he takes, in order
  await win.waitForSelector('.mascot')
  await win.evaluate(() => {
    const m = document.querySelector('.mascot')
    window.__poses = [m.dataset.pose]
    new MutationObserver(() => {
      if (window.__poses.at(-1) !== m.dataset.pose) window.__poses.push(m.dataset.pose)
    }).observe(m, { attributes: true, attributeFilter: ['data-pose'] })
  })
  const seen = (pose) => win.evaluate((p) => window.__poses.includes(p), pose)
  const waitPose = (pose, timeout = 15000) => win.waitForFunction((p) => window.__poses.includes(p), pose, { timeout }).then(() => true, () => false)
  /** feet on the top edge of the element (within a few px), horizontally inside it */
  const standsOn = (selector) =>
    win.evaluate((sel) => {
      const el = [...document.querySelectorAll(sel)].at(-1)
      const m = document.querySelector('.mascot').getBoundingClientRect()
      const r = el?.getBoundingClientRect()
      const feet = m.top + (m.height * 132) / 136
      const x = m.left + m.width / 2
      return Boolean(r) && Math.abs(feet - r.top) < 6 && x > r.left && x < r.right
    }, selector)
  const waitOn = (selector, timeout = 8000) =>
    win.waitForFunction((sel) => {
      const el = [...document.querySelectorAll(sel)].at(-1)
      const m = document.querySelector('.mascot').getBoundingClientRect()
      const r = el?.getBoundingClientRect()
      return Boolean(r) && Math.abs(m.top + (m.height * 132) / 136 - r.top) < 6
    }, selector, { timeout }).then(() => true, () => false)

  check(await waitPose('land', 5000), 'jumps in from the title bar')
  await win.waitForTimeout(700)
  // on the composer, or on the start cards when standing there would cover the cards' buttons (free.ts)
  const home = await win
    .waitForFunction(() => {
      const m = document.querySelector('.mascot').getBoundingClientRect()
      const feet = m.top + (m.height * 132) / 136
      const x = m.left + m.width / 2
      return [...document.querySelectorAll('.composer, .composer-wrap, .card, .start')].some((el) => {
        const r = el.getBoundingClientRect()
        return (Math.abs(feet - r.top) < 6 || Math.abs(feet - (r.bottom - 7)) < 6) && x > r.left && x < r.right + 80
      })
    }, null, { timeout: 8000 })
    .then(() => true, () => false)
  check(home, 'stands on the composer or a card')
  await shot('01-home')

  // Manual mode, so the write asks for approval
  await win.click('.composer .picker-btn[class*="mode-"]')
  await win.click('.picker-opt:has-text("Manual")')
  await win.fill('.composer textarea', 'Rescrie clasa jucătorului. RUN_WRITE')
  await win.keyboard.press('Enter')
  // before the first step he thinks (hand on chin), then the laptop comes out as the file streams in
  check(await waitPose('think', 20000), 'thinks before the model does anything')
  check(await waitPose('type', 60000), 'types on his laptop while the model writes a file')
  await shot('02-typing')

  await win.waitForSelector('.permission', { timeout: 60000 })
  check(await waitPose('point'), 'points at the approval card')
  // on the card when its top is in view, else wherever he is free: never over its buttons
  const overButtons = await win.evaluate(() => {
    const m = document.querySelector('.m-hit').getBoundingClientRect()
    return [...document.querySelectorAll('.permission button')].some((b) => {
      const r = b.getBoundingClientRect()
      return m.left < r.right && m.right > r.left && m.top < r.bottom && m.bottom > r.top
    })
  })
  check(!overButtons, 'keeps off the approval buttons')
  await shot('03-permission')

  await win.click('.permission .btn.primary')
  await win.waitForSelector('.msg-assistant', { timeout: 60000 })
  const cheered = await win
    .waitForFunction(() => ['cheer', 'like', 'dance'].some((p) => window.__poses.slice(-8).includes(p)), null, { timeout: 20000 })
    .then(() => true, () => false)
  check(cheered, 'cheers, likes or dances when the turn ends')
  await shot('04-cheer')
  check(await waitOn('.composer', 10000), 'goes back to the composer')

  // picked up by the hood and thrown
  const hit = await win.locator('.m-hit').boundingBox()
  await win.mouse.move(hit.x + hit.width / 2, hit.y + 20)
  await win.mouse.down()
  for (let i = 1; i <= 12; i++) await win.mouse.move(hit.x + hit.width / 2 - i * 30, hit.y + 20 - i * 25)
  check(await seen('held'), 'hangs from the cursor while dragged')
  await shot('05-held')
  await win.mouse.up()
  check(await waitPose('fall', 2000), 'falls when released')
  check(await waitPose('land', 4000), 'lands somewhere')
  await win.waitForTimeout(400)
  await shot('06-dropped')

  await win.locator('.m-hit').click({ button: 'right' })
  await win.click('.ctx .ctx-item:has-text("Ascunde mascota")')
  check((await win.locator('.mascot').count()) === 0, 'hides from his own menu')
  check(errors.length === 0, `no renderer errors${errors.length ? `: ${errors.join(' | ')}` : ''}`)
  console.log('poses:', (await win.evaluate(() => window.__poses?.join(' > ')).catch(() => '')) || '(gone)')
} finally {
  await app.close()
}
if (failures.length) {
  console.error(`${failures.length} failed`)
  process.exit(1)
}
