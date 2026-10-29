// The side chat in the built app on the mock model: it opens beside a running conversation without stopping it,
// carries a short brief, refuses writes and commands, keeps its answer out of the main transcript, quotes the answer
// into the main composer and can be promoted to a normal chat. Opens one window.
// Needs: python test/mocks/mock_anthropic.py <port>, MOCK_ANTHROPIC=http://127.0.0.1:<port>, HOME/APPDATA on a temp folder.
import { _electron as electron } from 'playwright-core'
import fs from 'fs'
import os from 'os'
import path from 'path'

const out = process.env.SHOTS || fs.mkdtempSync(path.join(os.tmpdir(), 'jolty-side-shots-'))
const data = process.env.JOLTY_DATA_DIR || fs.mkdtempSync(path.join(os.tmpdir(), 'jolty-side-'))
fs.mkdirSync(out, { recursive: true })
fs.mkdirSync(data, { recursive: true })
const project = fs.mkdtempSync(path.join(os.tmpdir(), 'jolty-side-proj-'))
fs.writeFileSync(path.join(data, 'profiles.json'), JSON.stringify([{ id: 'mock', name: 'Mock', engine: 'claude', auth: 'endpoint', isDefaultDir: true, baseUrl: process.env.MOCK_ANTHROPIC || 'http://127.0.0.1:8850', models: ['mock-model', 'mock-mini'], vision: false, color: '#e0a23b' }]))
fs.writeFileSync(path.join(data, 'secrets.json'), JSON.stringify({ mock: { enc: false, value: 'sk-mock' } }))
fs.writeFileSync(path.join(data, 'settings.json'), JSON.stringify({ language: 'ro', lastCwd: project, lastProfileId: 'mock' }))

const fails = []
const check = (ok, what) => {
  console.log(ok ? 'ok  ' : 'FAIL', what)
  if (!ok) fails.push(what)
}
const pause = (ms) => new Promise((r) => setTimeout(r, ms))
const env = { ...process.env, JOLTY_DATA_DIR: data, JOLTY_TEST: '1' }
delete env.ELECTRON_RUN_AS_NODE
const app = await electron.launch({ args: [path.resolve('out/main/index.js'), '--user-data-dir=' + path.join(data, 'electron')], env, timeout: 60000 })
const shot = (win, name) => win.screenshot({ path: path.join(out, name) })
const sessions = () => JSON.parse(fs.readFileSync(path.join(data, 'sessions.json'), 'utf8'))
const side = '.side-chat'
try {
  const win = await app.firstWindow()
  win.setDefaultTimeout(60000)
  await win.setViewportSize({ width: 1500, height: 920 })
  await win.waitForSelector('.composer textarea')
  // a main chat with a plan and an answer
  await win.fill('.composer textarea', 'Planifică migrarea RUN_TODO')
  await win.keyboard.press('Enter')
  await win.waitForSelector('.tasks-bar')
  await win.waitForFunction(() => document.querySelectorAll('.msg-assistant').length > 0 && !document.querySelector('.work-clock'))
  await pause(800)
  const mainId = sessions()[0].id
  const before = sessions().length

  // opened with the shortcut: the brief is small and shows the plan; closed again, it stays
  await win.keyboard.press('Control+Shift+S')
  await win.waitForSelector(`${side} .side-brief`)
  const summary = await win.locator(`${side} .side-brief summary`).innerText()
  const tokens = Number(/~(\d+)/.exec(summary)?.[1])
  check(tokens > 0 && tokens < 1300, `the brief is small (${summary})`)
  await win.locator(`${side} .side-brief summary`).click()
  const brief = await win.locator(`${side} .side-brief pre`).innerText()
  check(brief.includes('Planifică migrarea') && brief.includes('[>] Adaug tipurile pentru inventar'), 'the brief has the last request and the plan')
  check(sessions().length === before, 'the side chat is not saved to sessions.json')
  check((await win.locator('.session-item').count()) === 1, 'the sidebar does not list the side chat')
  await shot(win, 'side-1-open.png')
  await win.locator(`${side} .side-head button[title^="Închide"]`).click()
  await pause(400)
  check((await win.locator(side).count()) === 0, 'the panel closes')

  // the main chat runs a long turn; the side chat answers meanwhile without stopping it
  await win.fill('.composer textarea', 'Scrie un raport lung RUN_STREAM=360')
  await win.keyboard.press('Enter')
  await win.waitForSelector('.work-clock')
  await win.locator('.chat-header button[aria-pressed]').click()
  await win.waitForSelector(`${side} textarea`)
  check((await win.locator(`${side} .side-brief summary`).innerText()) === summary, 'reopened, it is the same side chat')
  await win.fill(`${side} textarea`, 'Ce am făcut până acum?')
  await win.keyboard.press('Enter')
  await win.waitForSelector(`${side} .msg-assistant`)
  check((await win.locator('.work-clock').count()) === 1, 'the main turn is still running while the side chat answers')
  await shot(win, 'side-2-both-running.png')
  await win.waitForSelector(`${side} .side-actions`, { timeout: 90000 })

  // read-only: a write and a command are refused, nothing lands on disk, no permission card
  await win.fill(`${side} textarea`, 'Scrie fișierul RUN_WRITE WRITE_NAME=side-wrote.txt WRITE_LINES=3')
  await win.keyboard.press('Enter')
  await pause(1500)
  await win.waitForSelector(`${side} .side-actions`, { timeout: 60000 })
  await win.fill(`${side} textarea`, 'Rulează RUN_TOOL')
  await win.keyboard.press('Enter')
  await pause(1500)
  await win.waitForSelector(`${side} .side-actions`, { timeout: 60000 })
  check(!fs.existsSync(path.join(project, 'side-wrote.txt')), 'the side chat wrote no file')
  check((await win.locator('.permission').count()) === 0, 'no permission card was shown')
  const sideText = await win.locator(`${side} .side-list`).innerText()
  check(!fs.existsSync(path.join(project, 'jolty-proof.txt')) && !sideText.includes('Gata: am vazut rezultatul "jolty-tool-ok'), 'the command did not run')
  await shot(win, 'side-3-read-only.png')

  // the answer goes into the main composer as a quote
  await win.locator(`${side} .side-actions .btn:not(.ghost)`).click()
  await win.waitForSelector('.quote-bar')
  check((await win.locator('.quote-bar .quote-text').innerText()).length > 0, 'the last answer waits as a quote above the main composer')
  await shot(win, 'side-4-quoted.png')

  // the main transcript has only its own turns
  await win.waitForFunction(() => !document.querySelector('.work-clock'), undefined, { timeout: 90000 })
  await pause(2500)
  const main = JSON.parse(fs.readFileSync(path.join(data, 'transcripts', `${mainId}.json`), 'utf8'))
  const mainUsers = main.filter((i) => i.kind === 'user').map((i) => i.text)
  check(mainUsers.length === 2 && mainUsers[1].includes('RUN_STREAM'), `the main chat has only its two messages (${mainUsers.length})`)
  check(!JSON.stringify(main).includes('Ce am făcut până acum') && !JSON.stringify(main).includes('RUN_WRITE'), 'nothing from the side chat is in the main transcript')
  check(main.some((i) => i.kind === 'assistant' && i.text.includes('Part 0')), 'the main turn finished its answer')

  // promoted: it becomes a saved, listed chat and the panel empties
  await win.locator(`${side} .side-head button[title^="Fă"]`).click()
  await win.waitForFunction((n) => document.querySelectorAll('.session-item').length === n, before + 1)
  await pause(1500)
  const promoted = sessions().find((s) => s.id !== mainId)
  check(Boolean(promoted && !promoted.sideOf && !promoted.temporary), 'the promoted chat is in sessions.json, no longer temporary')
  check(fs.existsSync(path.join(data, 'transcripts', `${promoted?.id}.json`)), 'its transcript is saved')
  await shot(win, 'side-5-promoted.png')
} catch (e) {
  await app.windows()[0]?.screenshot({ path: path.join(out, 'side-error.png') }).catch(() => undefined)
  throw e
} finally {
  await app.close().catch(() => undefined)
}
console.log('screenshots in', out)
if (fails.length) {
  console.log('FAILED:', fails.join('; '))
  process.exit(1)
}
console.log('side chat ok')
