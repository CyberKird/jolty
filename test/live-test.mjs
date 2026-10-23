// Drives the built Jolty app on the mock model and checks the Live list in the sidebar: working, waiting and
// finished chats show up, one click or Alt+N switches, a finished one stays until opened or dismissed.
// Needs: python test/mocks/mock_anthropic.py 8766, JOLTY_DATA_DIR and HOME pointing at empty folders.
import { _electron as electron } from 'playwright-core'
import fs from 'fs'
import os from 'os'
import path from 'path'

const out = process.env.SHOTS || path.resolve('shots')
const data = process.env.JOLTY_DATA_DIR
fs.mkdirSync(out, { recursive: true })
fs.mkdirSync(data, { recursive: true })
const project = fs.mkdtempSync(path.join(os.tmpdir(), 'jolty-live-'))
fs.writeFileSync(path.join(project, 'README.md'), '# Live\n')
fs.writeFileSync(
  path.join(data, 'profiles.json'),
  JSON.stringify([{ id: 'mock', name: 'DeepSeek (test)', engine: 'claude', auth: 'endpoint', isDefaultDir: true, baseUrl: process.env.MOCK_ANTHROPIC || 'http://127.0.0.1:8766', models: ['mock-model'], vision: false, color: '#e0a23b' }])
)
fs.writeFileSync(path.join(data, 'secrets.json'), JSON.stringify({ mock: { enc: false, value: 'sk-mock' } }))
fs.writeFileSync(path.join(data, 'settings.json'), JSON.stringify({ lastCwd: project, lastProfileId: 'mock' }))

const app = await electron.launch({
  executablePath: path.resolve('node_modules/.bin/electron'),
  args: ['--no-sandbox', path.resolve('out/main/index.js')],
  env: { ...process.env, JOLTY_DATA_DIR: data, HOME: process.env.HOME, JOLTY_TEST: '1' }
})
const win = await app.firstWindow()
await win.setViewportSize({ width: 1500, height: 920 })
const errors = []
const fails = []
win.on('pageerror', (e) => errors.push(String(e)))
win.on('console', (m) => m.type() === 'error' && errors.push(m.text()))
const check = (ok, what) => {
  console.log(ok ? 'ok  ' : 'FAIL', what)
  if (!ok) fails.push(what)
}
const shot = async (name) => {
  await win.waitForTimeout(400)
  await win.screenshot({ path: path.join(out, `${name}.png`) })
}
const rows = () => win.locator('.live-item')

await win.waitForSelector('.brand-name')
await win.waitForSelector('.composer textarea', { timeout: 60000 })
check((await win.locator('.live-list').count()) === 0, 'no Live list while nothing is going on')

// Manual mode, so the write asks for approval and the chat waits for us
const manual = async () => {
  await win.click('.composer .picker-btn >> nth=-1')
  await win.waitForSelector('.picker-opt')
  await win.keyboard.press('2')
  await win.waitForSelector('.picker-opt', { state: 'detached' })
  const label = await win.locator('.composer .picker-btn >> nth=-1').textContent()
  check(/Manual/.test(label || ''), `Manual mode picked (${label})`)
}
const send = async (text) => {
  await win.fill('.composer textarea', text)
  await win.keyboard.press('Enter')
}

await manual()
await send('Prima sesiune RUN_WRITE WRITE_LINES=15000 WRITE_NAME=a.txt')
await win.waitForSelector('.live-item.running', { timeout: 30000 })
check((await rows().count()) === 1, 'one working chat shows in the Live list')
check(await rows().first().evaluate((el) => el.classList.contains('active')), 'the chat on screen is marked active')

await win.click('button:has-text("Conversație nouă")')
await win.waitForSelector('.composer textarea')
await manual()
await send('A doua sesiune RUN_WRITE WRITE_LINES=15000 WRITE_NAME=b.txt')
await win.waitForFunction(() => document.querySelectorAll('.live-item').length === 2, null, { timeout: 30000 })
check(true, 'two chats listed while the second is on screen')
await shot('live-1-two-running')

// click the other one
const activeTitle = () => win.locator('.live-item.active .live-title').first().innerText()
const other = win.locator('.live-item:not(.active)').first()
const otherTitle = await other.locator('.live-title').innerText()
await other.click()
await win.waitForSelector('.live-item.active')
check((await activeTitle()) === otherTitle, 'click on a row opens that chat')

// Alt+N: the Nth row (the order is waiting, working, finished)
const order = await win.locator('.live-item .live-title').allInnerTexts()
await win.keyboard.press('Alt+2')
await win.waitForTimeout(500)
check((await activeTitle()) === order[1], 'Alt+2 opens the second row')
await win.keyboard.press('Alt+1')
await win.waitForTimeout(500)
check((await activeTitle()) === order[0], 'Alt+1 opens the first row')

// both end up waiting for approval, with what they ask
await win.waitForFunction(() => document.querySelectorAll('.live-item.waiting').length === 2, null, { timeout: 120000 })
const sub = await win.locator('.live-item.waiting .live-sub').first().innerText()
check(/Așteaptă aprobarea ta/.test(sub), `waiting rows say so: "${sub}"`)
await shot('live-2-two-waiting')

// approve the one on screen and leave at once: it finishes in the background and stays as done
await win.waitForSelector('.permission .btn.primary')
await win.click('.permission .btn.primary')
const left = await activeTitle()
await win.locator('.live-item.waiting').first().click()
await win.waitForSelector('.live-item.done', { timeout: 30000 })
check((await win.locator('.live-item.done .live-title').first().innerText()) === left, 'a chat finished out of sight is listed as done')
check((await win.locator('.live-item.done .live-sub').first().innerText()).startsWith('Gata'), 'and says so')
await shot('live-3-one-done')

// the cross dismisses it (shown on hover)
await win.locator('.live-item.done').first().hover()
await win.locator('.live-item.done .live-x').first().click()
await win.waitForFunction(() => document.querySelectorAll('.live-item.done').length === 0)
check(true, 'the cross dismisses a finished chat')

// the other one finishes in the background too; opening it removes it from the list
await win.click('.permission .btn.primary')
await win.locator('.session-item').filter({ hasText: left.slice(0, 10) }).first().click()
await win.waitForSelector('.live-item.done', { timeout: 30000 })
await win.locator('.live-item.done').first().click()
await win.waitForFunction(() => document.querySelectorAll('.live-item').length === 0)
check(true, 'opening a finished chat takes it off the list')
// the window and the elapsed clock keep ticking without errors
check(errors.length === 0, errors.length ? `renderer errors: ${errors.join(' | ')}` : 'no renderer errors')
await app.close()
if (fails.length) {
  console.log('FAILED:', fails.join('; '))
  process.exit(1)
}
console.log('live list ok')
