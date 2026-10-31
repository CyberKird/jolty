// A message sent while Claude Code works goes into the running turn at once (steer), like any other message. The waiting
// bubble (send now, edit, remove) is for the engines that refuse a message mid-turn. Opens one window.
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

  // Claude Code reads a message sent in the middle of a turn at once: no waiting bubble, it is a message like any other
  await type(win, 'second message')
  await win.waitForFunction(() => [...document.querySelectorAll('.msg-user')].some((m) => m.textContent.includes('second message')))
  check((await win.locator('.pending-msg').count()) === 0, 'sent while it works, the message does not wait in a bubble')
  check((await win.inputValue('.composer textarea')) === '', 'the box is empty again')
  await shot(win, 'steer-1-sent.png')

  // the turn goes on and ends with both messages in the conversation
  await win.waitForFunction(() => !document.querySelector('.work-clock'), undefined, { timeout: 90000 })
  await new Promise((r) => setTimeout(r, 2500))
  // the list is windowed, so the saved transcript is the place to count messages
  const id = JSON.parse(fs.readFileSync(path.join(data, 'sessions.json'), 'utf8'))[0].id
  const users = JSON.parse(fs.readFileSync(path.join(data, 'transcripts', `${id}.json`), 'utf8')).filter((i) => i.kind === 'user').map((i) => i.text)
  check(users.length === 2 && users[1].includes('second message'), `both messages are in the conversation, in order (${JSON.stringify(users)})`)
  await shot(win, 'steer-2-done.png')
} catch (e) {
  console.log('FAIL', e.message)
  fails.push(e.message)
} finally {
  await app.close()
}
console.log(fails.length ? `${fails.length} failed` : 'all passed', 'shots:', out)
process.exit(fails.length ? 1 : 0)
