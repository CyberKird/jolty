// Motion check on the built app (npm run test:transitions): every state change must animate, exits must exist,
// and with the CPU throttled 4x no frame may take over 24 ms. Also saves mid-transition screenshots.
// SHOTS=dir (default shots-transitions/after), RATE=4 (CPU throttle), NO_SHOTS=1, JSON=file for the table.
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { _electron as electron } from 'playwright-core'

const out = path.resolve(process.env.SHOTS || 'shots-transitions/after')
const rate = Number(process.env.RATE || 4)
const budget = Number(process.env.BUDGET || 24)
const only = process.env.ONLY
fs.mkdirSync(out, { recursive: true })
const data = fs.mkdtempSync(path.join(os.tmpdir(), 'jolty-motion-'))
const project = fs.mkdtempSync(path.join(os.tmpdir(), 'jolty-motion-proj-'))
const PORT = 8799
const pids = []

const items = Array.from({ length: 60 }, (_, i) => ({ kind: i % 2 ? 'assistant' : 'user', id: `i${i}`, text: `Message ${i}\n\n` + 'Some longer text to make the message tall. '.repeat(12) }))
fs.mkdirSync(path.join(data, 'transcripts'))
const now = Date.now()
const sessions = ['Alpha chat', 'Beta chat', 'Gamma chat'].map((title, i) => ({ id: `s${i + 1}`, profileId: 'mock', engine: 'claude', cwd: project, title, permissionMode: 'ask', createdAt: now - i, updatedAt: now - i }))
fs.writeFileSync(path.join(data, 'profiles.json'), JSON.stringify([{ id: 'mock', name: 'Mock', engine: 'claude', auth: 'endpoint', isDefaultDir: true, baseUrl: `http://127.0.0.1:${PORT}`, models: ['mock-model'], vision: false, color: '#e0a23b' }]))
fs.writeFileSync(path.join(data, 'secrets.json'), JSON.stringify({ mock: { enc: false, value: 'sk-mock' } }))
fs.writeFileSync(path.join(data, 'sessions.json'), JSON.stringify(sessions))
fs.writeFileSync(path.join(data, 'settings.json'), JSON.stringify({ lastCwd: project, lastProfileId: 'mock', seenVersion: JSON.parse(fs.readFileSync('package.json', 'utf8')).version }))
for (const s of sessions) fs.writeFileSync(path.join(data, 'transcripts', `${s.id}.json`), JSON.stringify(items))

const mock = spawn('python', ['test/mocks/mock_anthropic.py', String(PORT)], { stdio: 'ignore' })
pids.push(mock.pid)
const env = { ...process.env, JOLTY_TEST: '1', JOLTY_DATA_DIR: data }
delete env.ELECTRON_RUN_AS_NODE
const app = await electron.launch({ args: [path.resolve('out/main/index.js'), '--user-data-dir=' + path.join(data, 'electron')], env, timeout: 60000 })
const pause = (ms) => new Promise((r) => setTimeout(r, ms))
const rows = []
const errors = []

try {
  const win = await app.firstWindow()
  win.setDefaultTimeout(20000)
  win.on('pageerror', (e) => errors.push(String(e)))
  await win.setViewportSize({ width: 1500, height: 920 })
  await win.waitForSelector('.brand-name', { timeout: 60000 })
  await win.locator('.session-item').first().click()
  await win.waitForSelector('.messages-inner')
  await pause(1500)
  const cdp = await win.context().newCDPSession(win)

  await win.evaluate(() => {
    const w = window
    w.__frames = []
    w.__run = false
    let last = 0
    const tick = (t) => {
      if (w.__run && last) w.__frames.push(t - last)
      last = t
      requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
  })
  const boxes = () =>
    win.evaluate(() =>
      Object.fromEntries(
        ['.sidebar', '.main', '.messages-inner', '.composer-wrap', '.live', '.chat-header'].map((q) => {
          const r = document.querySelector(q)?.getBoundingClientRect()
          return [q, r ? [r.x, r.y, r.width, r.height].map(Math.round) : null]
        })
      )
    )
  // freezes every running animation/transition half way (also the view-transition pseudo elements), shoots, resumes
  const freeze = async (name) => {
    if (process.env.NO_SHOTS) return
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 })
    const n = await win.evaluate(() => {
      const a = document.getAnimations().filter((x) => x.playState === 'running')
      a.forEach((x) => x.pause())
      return a.length
    })
    await win.screenshot({ path: path.join(out, `${name}.png`) })
    await win.evaluate(() => document.getAnimations().forEach((x) => x.play()))
    await cdp.send('Emulation.setCPUThrottlingRate', { rate })
    return n
  }

  // act() starts the change; half = ms into the motion where the screenshot is taken; settle = total wait
  const measure = async (name, act, { half = 90, settle = 700, check, skip = only && !name.includes(only) } = {}) => {
    if (skip) return void (await act(), await pause(settle + 300))
    await cdp.send('Emulation.setCPUThrottlingRate', { rate })
    await pause(250)
    const before = await boxes()
    await win.evaluate(() => { window.__frames = []; window.__run = true })
    await act()
    await pause(half)
    const mid = await win.evaluate(() => ({ anims: document.getAnimations().length, running: document.getAnimations().filter((a) => a.playState === 'running').length }))
    if (check) await check('mid')
    await pause(Math.max(0, settle - half))
    const frames = await win.evaluate(() => { window.__run = false; return window.__frames.slice() })
    const end = await boxes()
    await pause(400)
    const later = await boxes()
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 })
    const jump = Object.keys(end).filter((k) => JSON.stringify(end[k]) !== JSON.stringify(later[k]))
    const sorted = frames.slice().sort((a, b) => a - b)
    const row = { name, frames: frames.length, max: +Math.max(0, ...frames).toFixed(1), p95: +(sorted[Math.floor(sorted.length * 0.95)] || 0).toFixed(1), over: frames.filter((f) => f > budget).length, animsMid: mid.anims, runningMid: mid.running, jump: jump.join(',') }
    rows.push(row)
    console.log(JSON.stringify(row))
    return { before, end, mid }
  }
  // the screenshots are a second run of the same step, frozen half way
  const shoot = async (name, act, half = 90) => {
    if (process.env.NO_SHOTS) return
    await cdp.send('Emulation.setCPUThrottlingRate', { rate })
    await act()
    await pause(half)
    await freeze(name)
    await pause(500)
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 })
  }
  const step = async (name, open, close, opts = {}, labels = ['open', 'close']) => {
    const run = !only || name.includes(only)
    await measure(`${name} ${labels[0]}`, open, { ...opts, skip: !run })
    await measure(`${name} ${labels[1]}`, close, { ...opts, skip: !run })
    if (run) await shoot(`${name}-${labels[0]}`, open, opts.half)
    if (run) await shoot(`${name}-${labels[1]}`, close, opts.half)
  }

  const nav = (i) => win.locator('.nav-item').nth(i)
  // page switch: chat -> a page -> chat
  await step('page', () => nav(7).click(), () => win.locator('.session-item').first().click(), { half: 100 })
  await step('page-between', () => nav(3).click(), () => nav(4).click(), { half: 100 })
  await win.locator('.session-item').first().click()
  await pause(500)
  // conversation switch
  await step('conversation', () => win.locator('.session-item').nth(1).click(), () => win.locator('.session-item').nth(0).click(), { half: 100 })
  // popovers
  const model = win.locator('.composer .picker-btn').first()
  await step('model-picker', () => model.click(), () => win.keyboard.press('Escape'), { half: 80, settle: 500 })
  const mode = win.locator('.composer .picker-btn').last()
  await step('mode-picker', () => mode.click(), () => win.keyboard.press('Escape'), { half: 80, settle: 500 })
  const tools = win.locator('.composer .chrome-toggle[aria-haspopup="menu"]').first()
  await step('tools-menu', () => tools.click(), () => win.keyboard.press('Escape'), { half: 80, settle: 500 })
  // context menu
  await step('context-menu', () => win.locator('.session-item').nth(2).click({ button: 'right' }), () => win.keyboard.press('Escape'), { half: 80, settle: 500 })
  // sidebar and Live panel
  await step('sidebar', () => win.keyboard.press('Control+b'), () => win.keyboard.press('Control+b'), { half: 130, settle: 700 }, ['collapse', 'expand'])
  await step('live-panel', () => win.keyboard.press('Control+l'), () => win.keyboard.press('Control+l'), { half: 130, settle: 700 }, ['close', 'open'])
  // modal
  await win.locator('.nav-item').last().click()
  await pause(600)
  await step('modal', () => win.evaluate(() => window.dispatchEvent(new Event('jolty:whatsnew'))), () => win.locator('.wn-close').click(), { half: 120, settle: 700 })
  await win.locator('.session-item').first().click()
  await pause(500)
  // a new message: user bubble then the streamed answer
  await win.fill('.composer textarea', 'hello there')
  await measure('new-message', () => win.keyboard.press('Enter'), { half: 120, settle: 1500 })
  await shoot('new-message', async () => { await win.fill('.composer textarea', 'again'); await win.keyboard.press('Enter') }, 110)
  await pause(1500)
  // toast: removing a conversation
  await measure('toast-in', () => win.locator('.session-item').last().hover().then(() => win.locator('.session-item').last().locator('.del').click()), { half: 120, settle: 800 })
  await measure('toast-out', () => pause(3200), { half: 100, settle: 1400 })
  if (errors.length) console.log('page errors:', errors)

  if (process.env.JSON) fs.writeFileSync(process.env.JSON, JSON.stringify(rows, null, 2))
  const bad = rows.filter((r) => r.over > 0 || r.jump)
  console.table(rows)
  if (process.env.STRICT) assert.equal(bad.length, 0, `frames over ${budget} ms or a jump at the end: ${bad.map((r) => r.name).join(', ')}`)
} finally {
  await app.close().catch(() => undefined)
  for (const pid of pids) spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' })
  fs.rmSync(data, { recursive: true, force: true })
  fs.rmSync(project, { recursive: true, force: true })
}
