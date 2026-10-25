// Performance numbers of the built app: startup, memory, long tasks and frame times, with a small and a 60 MB conversation.
// Needs a build (npx electron-vite build). Env: BENCH_LABEL, BENCH_BIG=1 (60 MB transcript), BENCH_THROTTLE=4 (renderer CPU slowdown),
// BENCH_IDLE=30 (seconds of idle before the memory sample), BENCH_OUT=file.json
import { _electron as electron } from 'playwright-core'
import { spawn, execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const label = process.env.BENCH_LABEL || 'run'
const big = process.env.BENCH_BIG === '1'
const throttle = Number(process.env.BENCH_THROTTLE || 1)
const idleSec = Number(process.env.BENCH_IDLE || 30)
const port = 18766
const data = fs.mkdtempSync(path.join(os.tmpdir(), 'jolty-bench-'))
const project = fs.mkdtempSync(path.join(os.tmpdir(), 'jolty-bench-proj-'))
const pause = (ms) => new Promise((r) => setTimeout(r, ms))
const round = (n, d = 0) => Math.round(n * 10 ** d) / 10 ** d

fs.writeFileSync(path.join(data, 'profiles.json'), JSON.stringify([{ id: 'mock', name: 'Mock', engine: 'claude', auth: 'endpoint', baseUrl: `http://127.0.0.1:${port}`, models: ['mock-model'], vision: false, color: '#e0a23b' }]))
fs.writeFileSync(path.join(data, 'secrets.json'), JSON.stringify({ mock: { enc: false, value: 'sk-mock' } }))
fs.writeFileSync(path.join(data, 'settings.json'), JSON.stringify({ language: 'en', lastCwd: project, lastProfileId: 'mock', mascot: process.env.BENCH_MASCOT !== '0', ...(process.env.BENCH_SETTINGS ? JSON.parse(process.env.BENCH_SETTINGS) : {}) }))
const meta = (id, title, t) => ({ id, profileId: 'mock', engine: 'claude', cwd: project, title, permissionMode: 'ask', createdAt: t, updatedAt: t })
fs.writeFileSync(path.join(data, 'sessions.json'), JSON.stringify([meta('small', 'Small chat', 2), meta('big', 'Big chat', 1)]))
fs.mkdirSync(path.join(data, 'transcripts'))
// the skill hash cache of a used install, so start-up is measured as a user sees it (a cold cache hashes every skill folder)
const realCache = path.join(process.env.APPDATA || '', 'Jolty', 'skill-hash-cache.json')
if (process.env.BENCH_COLD !== '1' && fs.existsSync(realCache)) fs.copyFileSync(realCache, path.join(data, 'skill-hash-cache.json'))

const code = '```ts\n' + Array.from({ length: 30 }, (_, i) => `export function item${i}(a: number, b: string): string { return b.repeat(a) + '${i}' }`).join('\n') + '\n```'
const prose = 'A paragraph with `inline code`, **bold** words and a [link](https://example.com). '.repeat(8)
function transcript(n) {
  const items = []
  for (let i = 0; i < n; i++) {
    items.push({ kind: 'user', id: `u${i}`, text: `Question ${i}: how do I change the thing in module ${i}?` })
    items.push({ kind: 'assistant', id: `a${i}`, text: `## Answer ${i}\n\n${prose}\n\n${code}\n\n- one\n- two\n- three\n\n${prose}` })
    if (i % 2 === 0) items.push({ kind: 'tool', id: `t${i}`, name: 'Bash', title: `ls ${i}`, status: 'done', exitCode: 0, command: `ls -la ${i}`, output: `file ${i} line of output\n`.repeat(700) })
  }
  return items
}
fs.writeFileSync(path.join(data, 'transcripts', 'small.json'), JSON.stringify(transcript(20)))
if (big) {
  // about 60 MB on disk: 1700 rounds of ~35 KB (the tool output stays under the 20000 characters the store clips to)
  const rounds = 1700
  const ws = fs.createWriteStream(path.join(data, 'transcripts', 'big.json'))
  ws.write('[')
  let first = true
  for (let i = 0; i < rounds; i++) {
    for (const it of transcript(1).map((x) => ({ ...x, id: `${x.id}-${i}` }))) {
      ws.write((first ? '' : ',') + JSON.stringify(it))
      first = false
    }
    if (i % 2 === 1) ws.write(',' + JSON.stringify({ kind: 'tool', id: `t-${i}`, name: 'Bash', title: `ls ${i}`, status: 'done', exitCode: 0, command: `ls -la ${i}`, output: `file ${i} line of output\n`.repeat(700) }))
  }
  ws.write(']')
  await new Promise((r) => ws.end(r))
}
const bigBytes = big ? fs.statSync(path.join(data, 'transcripts', 'big.json')).size : 0

const mock = spawn('python', [path.resolve('test/mocks/mock_anthropic.py'), String(port)], { stdio: 'ignore', windowsHide: true })
const out = { label, big, throttle, bigMB: round(bigBytes / 1e6, 1) }
let app
try {
  await pause(800)
  const env = { ...process.env, JOLTY_TEST: '1', JOLTY_DATA_DIR: data }
  delete env.ELECTRON_RUN_AS_NODE
  const t0 = Date.now()
  app = await electron.launch({ args: [path.resolve('out/main/index.js'), '--user-data-dir=' + path.join(data, 'electron')], env, timeout: 90000 })
  const win = await app.firstWindow()
  out.tFirstWindowMs = Date.now() - t0
  win.setDefaultTimeout(120000)
  await win.setViewportSize({ width: 1500, height: 920 })
  await win.waitForSelector('.brand-name')
  out.tBrandMs = Date.now() - t0
  await win.waitForSelector('.session-item')
  out.tSessionsMs = Date.now() - t0
  const cdp = await win.context().newCDPSession(win)

  // main-process event loop delay since the app started (a long synchronous job shows as its max)
  await app.evaluate(() => {
    const { monitorEventLoopDelay } = process.getBuiltinModule('node:perf_hooks')
    globalThis.__eld = monitorEventLoopDelay({ resolution: 5 })
    globalThis.__eld.enable()
  })
  const mainDelay = async () => {
    const r = await app.evaluate(() => {
      const h = globalThis.__eld
      const o = { max: h.max / 1e6, p99: h.percentile(99) / 1e6 }
      h.reset()
      return o
    })
    return { maxMs: round(r.max), p99Ms: round(r.p99) }
  }
  const observe = () => win.evaluate(() => {
    window.__lt = []
    window.__frames = []
    new PerformanceObserver((l) => window.__lt.push(...l.getEntries().map((e) => e.duration))).observe({ type: 'longtask', buffered: true })
    let last = performance.now()
    const tick = (t) => { window.__frames.push(t - last); last = t; requestAnimationFrame(tick) }
    requestAnimationFrame(tick)
  })
  const takeLT = () => win.evaluate(() => {
    const lt = window.__lt.splice(0)
    const fr = window.__frames.splice(0)
    const sum = (a) => a.reduce((x, y) => x + y, 0)
    return { longTasks: lt.length, blockedMs: Math.round(sum(lt.map((d) => Math.max(0, d - 50)))), maxTaskMs: Math.round(Math.max(0, ...lt)), frames: fr.length, maxFrameMs: Math.round(Math.max(0, ...fr)), over50Frames: fr.filter((d) => d > 50).length }
  })
  const mem = async () => {
    const m = await app.evaluate(({ app: a }) => a.getAppMetrics().map((p) => ({ type: p.type === 'Utility' ? `Utility:${p.name || p.serviceName}` : p.type, ws: p.memory.workingSetSize, priv: p.memory.privateBytes ?? 0 })))
    const heap = await cdp.send('Runtime.getHeapUsage')
    return { rssMB: round(m.reduce((s, p) => s + p.ws, 0) / 1024), privateMB: round(m.reduce((s, p) => s + p.priv, 0) / 1024), processes: m.length, byType: Object.fromEntries([...new Set(m.map((p) => p.type))].map((t) => [t, round(m.filter((p) => p.type === t).reduce((s, p) => s + p.ws, 0) / 1024)])), jsHeapMB: round(heap.usedSize / 1048576, 1) }
  }

  await pause(2000)
  await observe()
  await takeLT()
  out.startupMain = await mainDelay()

  if (throttle > 1) await cdp.send('Emulation.setCPUThrottlingRate', { rate: throttle })
  // renderer start-up again, under the throttle when there is one
  const tr0 = Date.now()
  await win.reload()
  await win.waitForSelector('.brand-name')
  out.reloadBrandMs = Date.now() - tr0
  await win.waitForSelector('.session-item')
  out.reloadSessionsMs = Date.now() - tr0
  await observe()
  await pause(3000)
  out.reloadTasks = await takeLT()

  await pause(idleSec * 1000)
  out.idle = await takeLT()
  out.idleMain = await mainDelay()
  out.idleMem = await mem()

  // open the conversation
  const title = big ? 'Big chat' : 'Small chat'
  await mainDelay()
  const to = Date.now()
  await win.locator('.session-item', { hasText: title }).first().click()
  await win.waitForSelector('.messages-inner')
  await win.waitForFunction(() => { const m = document.querySelector('.messages'); return m && m.scrollHeight - m.scrollTop - m.clientHeight < 3 && m.querySelectorAll('.messages-inner > *').length > 0 })
  out.openMs = Date.now() - to
  await pause(2500)
  out.open = await takeLT()
  out.openMain = await mainDelay()
  out.messageNodes = await win.evaluate(() => document.querySelectorAll('.messages-inner > *').length)
  out.domNodes = await win.evaluate(() => document.getElementsByTagName('*').length)
  out.openMem = await mem()

  // stream a long answer
  await mainDelay()
  await takeLT()
  await win.fill('.composer textarea', 'RUN_STREAM=240')
  await win.keyboard.press('Enter')
  await win.waitForFunction(() => document.querySelector('.messages-inner')?.textContent?.includes('Part 0'), null, { timeout: 60000 })
  const ts = Date.now()
  await win.waitForFunction(() => document.querySelector('.messages-inner')?.textContent?.includes('Part 228'), null, { timeout: 120000 })
  out.streamMs = Date.now() - ts
  out.stream = await takeLT()
  out.streamMain = await mainDelay()
  await pause(2000)
  out.endMem = await mem()
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 })
} finally {
  const pid = app?.process().pid
  await app?.close().catch(() => undefined)
  if (mock.pid) try { execFileSync('taskkill', ['/PID', String(mock.pid), '/T', '/F'], { stdio: 'ignore' }) } catch { /* gone */ }
  fs.rmSync(data, { recursive: true, force: true })
  fs.rmSync(project, { recursive: true, force: true })
  out.pid = pid
}
console.log(JSON.stringify(out, null, 1))
if (process.env.BENCH_OUT) fs.writeFileSync(process.env.BENCH_OUT, JSON.stringify(out, null, 1))
