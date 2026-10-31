// A message written while the model works waits in the conversation as its own bubble with a status line and three
// actions (send now, edit, remove); it goes out by itself when the turn ends. Opens one window.
// Needs: python test/mocks/mock_anthropic.py <port>, MOCK_ANTHROPIC=http://127.0.0.1:<port>.
import { _electron as electron } from 'playwright-core'
import fs from 'fs'
import os from 'os'
import path from 'path'

const out = process.env.SHOTS || fs.mkdtempSync(path.join(os.tmpdir(), 'jolty-queue-shots-'))
const data = fs.mkdtempSync(path.join(os.tmpdir(), 'jolty-queue-'))
const project = fs.mkdtempSync(path.join(os.tmpdir(), 'jolty-queue-proj-'))
fs.mkdirSync(out, { recursive: true })
fs.writeFileSync(path.join(data, 'profiles.json'), JSON.stringify([{ id: 'mock', name: 'Mock', engine: 'claude', auth: 'endpoint', isDefaultDir: true, baseUrl: process.env.MOCK_ANTHROPIC || 'http://127.0.0.1:8850', models: ['mock-model'], vision: false, color: '#e0a23b' }]))
fs.writeFileSync(path.join(data, 'secrets.json'), JSON.stringify({ mock: { enc: false, value: 'sk-mock' } }))
fs.writeFileSync(path.join(data, 'settings.json'), JSON.stringify({ language: 'en', lastCwd: project, lastProfileId: 'mock' }))

const fails = []
const check = (ok, what) => {
  console.log(ok ? 'ok  ' : 'FAIL', what)
  if (!ok) fails.push(what)
}
const env = { ...process.env, JOLTY_DATA_DIR: data, JOLTY_TEST: '1' }
delete env.ELECTRON_RUN_AS_NODE
const app = await electron.launch({ args: [path.resolve('out/main/index.js'), '--user-data-dir=' + path.join(data, 'electron')], env, timeout: 60000 })
const shot = (win, name) => win.screenshot({ path: path.join(out, name) })
const type = async (win, text) => {
  await win.fill('.composer textarea', text)
  await win.keyboard.press('Enter')
}
try {
  const win = await app.firstWindow()
  win.setDefaultTimeout(60000)
  await win.setViewportSize({ width: 1300, height: 900 })
  await win.waitForSelector('.composer textarea')
  await type(win, 'First, a long answer RUN_STREAM=400')
  await win.waitForSelector('.work-clock')

  await type(win, 'second message')
  await win.waitForSelector('.pending-msg')
  check((await win.locator('.pending-msg .message-text').innerText()) === 'second message', 'the waiting message shows as a bubble in the conversation')
  check((await win.locator('.pending-msg .pending-label').textContent()) === 'Pending', 'it carries the Pending status')
  check((await win.locator('.queue').count()) === 0, 'the box no longer lists it')
  await shot(win, 'queue-1-waiting.png')

  // edit: back into the box
  await win.locator('.pending-msg').hover()
  await win.locator('.pending-msg button[aria-label="Edit message"]').click()
  check((await win.locator('.pending-msg').count()) === 0, 'edit takes it out of the conversation')
  check((await win.inputValue('.composer textarea')) === 'second message', 'edit puts the text back in the box')

  // remove
  await win.keyboard.press('Enter')
  await win.waitForSelector('.pending-msg')
  await win.locator('.pending-msg').hover()
  await win.locator('.pending-msg .pending-act').last().click()
  check((await win.locator('.pending-msg').count()) === 0, 'remove drops it')

  // it goes out by itself when the turn ends
  await type(win, 'third message')
  await win.waitForSelector('.pending-msg')
  await win.waitForFunction(() => !document.querySelector('.work-clock') && !document.querySelector('.pending-msg'), undefined, { timeout: 90000 })
  await win.waitForFunction(() => [...document.querySelectorAll('.msg-user')].some((m) => m.textContent.includes('third message')))
  check(true, 'at the end of the turn the waiting message was sent')
  await new Promise((r) => setTimeout(r, 4000))
  await shot(win, 'queue-2-sent.png')
} catch (e) {
  console.log('FAIL', e.message)
  fails.push(e.message)
} finally {
  await app.close()
}
console.log(fails.length ? `${fails.length} failed` : 'all passed', 'shots:', out)
process.exit(fails.length ? 1 : 0)
