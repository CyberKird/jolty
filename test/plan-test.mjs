// Drives the built Jolty app on the mock model: the task list shows in the strip above the composer and in the Plan
// tab while the model works, and is still there when the app is closed and the conversation opened again.
// Needs: python test/mocks/mock_anthropic.py 8766, JOLTY_DATA_DIR and HOME pointing at empty folders.
import { _electron as electron } from 'playwright-core'
import fs from 'fs'
import os from 'os'
import path from 'path'

const out = process.env.SHOTS || path.resolve('shots')
const data = process.env.JOLTY_DATA_DIR
fs.mkdirSync(out, { recursive: true })
fs.mkdirSync(data, { recursive: true })
const project = fs.mkdtempSync(path.join(os.tmpdir(), 'jolty-plan-'))
fs.writeFileSync(path.join(data, 'profiles.json'), JSON.stringify([{ id: 'mock', name: 'DeepSeek (test)', engine: 'claude', auth: 'endpoint', isDefaultDir: true, baseUrl: process.env.MOCK_ANTHROPIC || 'http://127.0.0.1:8766', models: ['mock-model'], vision: false, color: '#e0a23b' }]))
fs.writeFileSync(path.join(data, 'secrets.json'), JSON.stringify({ mock: { enc: false, value: 'sk-mock' } }))
fs.writeFileSync(path.join(data, 'settings.json'), JSON.stringify({ lastCwd: project, lastProfileId: 'mock' }))

const fails = []
const check = (ok, what) => {
  console.log(ok ? 'ok  ' : 'FAIL', what)
  if (!ok) fails.push(what)
}
const launch = async () => {
  const app = await electron.launch({
    executablePath: path.resolve('node_modules/.bin/electron'),
    args: ['--no-sandbox', path.resolve('out/main/index.js')],
    env: { ...process.env, JOLTY_DATA_DIR: data, HOME: process.env.HOME, JOLTY_TEST: '1' }
  })
  const win = await app.firstWindow()
  await win.setViewportSize({ width: 1500, height: 920 })
  return { app, win }
}

let { app, win } = await launch()
await win.waitForSelector('.composer textarea', { timeout: 60000 })
await win.fill('.composer textarea', 'Fă un plan pentru migrare RUN_TODO')
await win.keyboard.press('Enter')
await win.waitForSelector('.tasks-bar', { timeout: 60000 })
check((await win.locator('.tasks-bar').innerText()).includes('2/5'), 'the strip above the composer shows 2/5 done')
await win.click('.live-tab:has-text("Plan")')
await win.waitForSelector('.plan-step')
check((await win.locator('.live-panel .plan-step, .live .plan-step').count()) === 5, 'the Plan tab lists the 5 steps')
check((await win.locator('.plan-step.done').count()) >= 2, 'finished steps are ticked')
await win.screenshot({ path: path.join(out, 'plan-1-live.png') })
// wait for the turn to end: the clock goes away with it
await win.waitForSelector('.msg-assistant', { timeout: 60000 })
await app.close()

// the app is opened again: the conversation still has its list
;({ app, win } = await launch())
await win.waitForSelector('.session-item', { timeout: 60000 })
await win.locator('.session-item').first().click()
await win.waitForSelector('.tasks-bar', { timeout: 30000 }).catch(() => undefined)
check((await win.locator('.tasks-bar').count()) === 1, 'after a restart the strip is back')
check((await win.locator('.tasks-bar').innerText().catch(() => '')).includes('2/5'), 'with the same progress')
await win.click('.live-tab:has-text("Plan")')
check((await win.locator('.plan-step').count()) >= 5, 'and the Plan tab has the steps')
await win.screenshot({ path: path.join(out, 'plan-2-restored.png') })
await app.close()
if (fails.length) {
  console.log('FAILED:', fails.join('; '))
  process.exit(1)
}
console.log('plan ok')
