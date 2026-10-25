// Dragging the sidebar edge, the line above live usage and the Live panel's edge: each must follow the mouse,
// start from what is on screen (a saved Live width above the CSS cap used to leave a dead zone), and leave
// no inline overrides or drag layer behind.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { _electron as electron } from 'playwright-core'

const data = fs.mkdtempSync(path.join(os.tmpdir(), 'jolty-resize-'))
fs.writeFileSync(path.join(data, 'profiles.json'), JSON.stringify([{ id: 'p1', name: 'Drag', engine: 'claude', auth: 'subscription', color: '#d97757' }]))
fs.writeFileSync(path.join(data, 'sessions.json'), JSON.stringify([{ id: 's1', profileId: 'p1', engine: 'claude', cwd: data, title: 'Chat', permissionMode: 'ask', createdAt: 1, updatedAt: 1 }]))
fs.writeFileSync(path.join(data, 'settings.json'), JSON.stringify({ language: 'en', lastCwd: data, mascot: false }))
const env = { ...process.env, JOLTY_TEST: '1', JOLTY_DATA_DIR: data }
delete env.ELECTRON_RUN_AS_NODE
const app = await electron.launch({ args: [path.resolve('out/main/index.js'), '--user-data-dir=' + path.join(data, 'electron')], env, timeout: 60000 })
try {
  const win = await app.firstWindow()
  win.setDefaultTimeout(30000)
  await win.waitForSelector('.brand-name')
  await win.keyboard.press('Escape')
  await win.locator('.session-item').first().click()
  await win.waitForSelector('.live-resize')
  await win.waitForTimeout(800)
  const box = (sel) => win.evaluate((s) => { const b = document.querySelector(s).getBoundingClientRect(); return { x: b.x, y: b.y, w: b.width, h: b.height } }, sel)
  const drag = async (x, y, dx, dy) => {
    await win.mouse.move(x, y)
    await win.mouse.down()
    for (let i = 1; i <= 10; i++) await win.mouse.move(x + (dx * i) / 10, y + (dy * i) / 10)
    assert.equal(await win.locator('body > div[style*="2147483647"]').count(), 1, 'a drag layer covers the window while dragging')
    await win.mouse.up()
    assert.equal(await win.locator('body > div[style*="2147483647"]').count(), 0, 'the drag layer is removed on release')
  }

  let side = await box('.sidebar')
  await drag(side.w - 3, 400, 80, 0)
  assert.equal(Math.round((await box('.sidebar')).w - side.w), 80, 'sidebar follows the mouse')
  const inline = await win.evaluate(() => [document.querySelector('.app').style.gridTemplateColumns, document.querySelector('.sidebar').style.width, document.querySelector('.live').style.maxWidth])
  assert.deepEqual(inline, ['', '', ''], 'no inline overrides after a sidebar drag')

  const meter = await box('.meter')
  await drag(meter.x + 50, meter.y + 2, 0, -50)
  assert.equal(Math.round(meter.h - (await box('.meter')).h), -50, 'usage list grows when its line is dragged up')

  // a saved width above the cap: the panel shows the capped width and the first pixels of the drag must count
  await win.evaluate(() => localStorage.setItem('jolty.liveWidth', '900'))
  await win.reload()
  await win.waitForSelector('.live-resize')
  await win.waitForTimeout(800)
  const live = await box('.live')
  assert.ok(live.w < 900, `the cap holds the panel below its saved width (${live.w})`)
  const edge = await box('.live-resize')
  await drag(edge.x + 3, 400, 40, 0)
  assert.equal(Math.round(live.w - (await box('.live')).w), 40, 'Live panel shrinks at once from the width on screen')
  console.log('ok')
} finally {
  await app.close()
  fs.rmSync(data, { recursive: true, force: true })
}
