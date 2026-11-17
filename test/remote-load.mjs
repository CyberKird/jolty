// Measures the phone app on bad lines and a slow phone, and prints the numbers. Run after `electron-vite build`:
//   node test/remote-load.mjs                  all profiles
//   PROFILES=slow3g node test/remote-load.mjs  one of: lan, slow3g, bad
//   JOLTY_OUT=<path to an out folder> LABEL=before node test/remote-load.mjs   another build (to compare)
// A throttling proxy (net-shaper.mjs) sits between a phone-sized window with no preload and a test Jolty with its own
// data folder and port, so it counts every byte both ways (page, socket, pictures) and can cut the line. The phone's CPU
// is slowed 4x (a low-end phone). It opens one window pair; nothing of the user's real Jolty is touched.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { _electron as electron } from 'playwright-core'
import { noisyPng, shaper } from './net-shaper.mjs'

const OUT = path.resolve(process.env.JOLTY_OUT || 'out')
const LABEL = process.env.LABEL || 'current'
const PORT = 47871
const PROXY = 47872
const PROFILES = {
  lan: { kbps: null, rttMs: 20, loss: 0 },
  slow3g: { kbps: 400, rttMs: 400, loss: 0 },
  bad: { kbps: 100, rttMs: 1500, loss: 0.05 }
}
const pick = (process.env.PROFILES || 'lan,slow3g,bad').split(',')
const CHAT_LIMIT = Number(process.env.CHAT_LIMIT || 150_000)

// a PC with 60 conversations, one of them big: 8 pasted screenshots and 1500 tool calls (a real one weighs 35 MB)
const data = fs.mkdtempSync(path.join(os.tmpdir(), 'jolty-load-'))
fs.writeFileSync(path.join(data, 'profiles.json'), JSON.stringify([{ id: 'p1', name: 'Tools', engine: 'claude', auth: 'subscription', color: '#d97757' }]))
const sessions = [{ id: 's1', profileId: 'p1', engine: 'claude', cwd: data, title: 'Big chat', permissionMode: 'ask', createdAt: 1, updatedAt: 1000 }]
for (let i = 0; i < 60; i++) sessions.push({ id: `o${i}`, profileId: 'p1', engine: 'claude', cwd: data, title: `Older ${i}`, permissionMode: 'ask', createdAt: 1, updatedAt: 500 - i })
fs.writeFileSync(path.join(data, 'sessions.json'), JSON.stringify(sessions))
fs.writeFileSync(path.join(data, 'settings.json'), JSON.stringify({ language: 'en', lastCwd: data }))
fs.writeFileSync(path.join(data, 'remote.json'), JSON.stringify({ enabled: true, port: PORT, devices: [] }))
fs.mkdirSync(path.join(data, 'transcripts'))
const items = []
for (let i = 0; i < 1500; i++) {
  if (i % 10 === 0) {
    const img = i % 180 === 0 && items.filter((x) => x.images).length < 8 ? [{ name: `shot${i}.png`, dataUrl: 'data:image/png;base64,' + noisyPng(1280, 800, i + 1).toString('base64') }] : undefined
    items.push({ kind: 'user', id: `u${i}`, text: `Step ${i}: fix the build and check the page again`, ...(img ? { images: img } : {}) })
  }
  items.push({ kind: 'tool', id: `t${i}`, name: 'Bash', title: `npm run build (${i})`, status: 'done', command: 'npm run build', input: { command: 'npm run build' }, output: `line of build output ${i} `.repeat(120) })
  if (i % 10 === 9) items.push({ kind: 'assistant', id: `a${i}`, text: `Done with step ${i}. The **build** passes and the page loads.\n\n- one\n- two\n\n\`\`\`ts\nconst x = ${i}\n\`\`\`` })
}
items.push({ kind: 'assistant', id: 'last', text: 'LAST MESSAGE of the big chat' })
fs.writeFileSync(path.join(data, 'transcripts', 's1.json'), JSON.stringify(items))
const transcriptMB = fs.statSync(path.join(data, 'transcripts', 's1.json')).size / 1e6

const kb = (n) => Math.round(n / 1024)
const results = { label: LABEL, transcriptMB: +transcriptMB.toFixed(1), assets: assetSizes(), runs: [] }
const net = shaper(PORT, PROFILES.lan)
await net.listen(PROXY)
const env = { ...process.env, JOLTY_TEST: '1', JOLTY_DATA_DIR: data }
delete env.ELECTRON_RUN_AS_NODE
const app = await electron.launch({ args: [path.join(OUT, 'main/index.js'), '--user-data-dir=' + path.join(data, 'electron')], env, timeout: 60000 })

function assetSizes() {
  const dir = path.join(OUT, 'renderer/assets')
  const all = fs.readdirSync(dir).map((f) => ({ f, size: fs.statSync(path.join(dir, f)).size }))
  return { files: all.length, totalKB: kb(all.reduce((s, x) => s + x.size, 0)) }
}

try {
  const win = await app.firstWindow()
  win.setDefaultTimeout(60000)
  await win.waitForSelector('.brand-name', { timeout: 60000 })
  const { code } = await win.evaluate(() => window.jolty.remote.pair())
  const opened = app.waitForEvent('window')
  await app.evaluate(({ BrowserWindow }, url) => {
    const w = new BrowserWindow({ width: 390, height: 844, show: true, webPreferences: { sandbox: true } })
    void w.loadURL(url)
  }, `http://127.0.0.1:${PROXY}/#pair=${code}`)
  const phone = await opened
  phone.setDefaultTimeout(180000)
  phone.on('console', (m) => m.type() === 'error' && process.env.DEBUG && console.log('phone:', m.text()))
  await phone.waitForSelector('.titlebar-btn', { timeout: 60000 }).catch(async (e) => {
    await phone.screenshot({ path: path.join(os.tmpdir(), 'jolty-load-fail.png') })
    console.log('phone shows:', (await phone.evaluate(() => document.body.innerText)).slice(0, 300))
    throw e
  })
  await phone.evaluate(() => navigator.serviceWorker?.ready.then(() => undefined))
  const cdp = await phone.context().newCDPSession(phone)
  const origin = `http://127.0.0.1:${PROXY}`

  await phone.addInitScript(() => {
    window.__lt = []
    try {
      new PerformanceObserver((l) => window.__lt.push(...l.getEntries().map((e) => Math.round(e.duration)))).observe({ type: 'longtask', buffered: true })
    } catch {
      // no long task timing
    }
  })

  /** loads the page and times it: first paint, the app bar, the conversation list */
  async function load(kind) {
    if (kind === 'cold') {
      await cdp.send('Storage.clearDataForOrigin', { origin, storageTypes: 'cache_storage,service_workers' })
      await cdp.send('Network.clearBrowserCache')
      await phone.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith('jolty-snap:')).forEach((k) => localStorage.removeItem(k)))
    }
    net.reset()
    const t0 = Date.now()
    const LIMIT = 180000
    let tBar = `>${LIMIT}`
    let tData = `>${LIMIT}`
    try {
      await phone.goto(origin + '/', { waitUntil: 'commit', timeout: LIMIT })
      await phone.waitForSelector('.titlebar-btn', { timeout: LIMIT })
      tBar = Date.now() - t0
      await phone.waitForFunction(() => document.querySelectorAll('.session-item').length > 0 || window.jolty?.sessions.list().then((l) => l.length > 0), null, { polling: 100, timeout: LIMIT })
      // the list from the PC itself, not a kept copy: the line is up
      await phone.waitForFunction(() => !document.querySelector('.link-pill.on'), null, { polling: 100, timeout: LIMIT })
      await phone.waitForTimeout(200)
      tData = Date.now() - t0
    } catch {
      // too slow to finish: reported as more than the limit
    }
    const fcp = await phone.evaluate(() => Math.round(performance.getEntriesByName('first-contentful-paint')[0]?.startTime ?? -1))
    const lt = await phone.evaluate(() => window.__lt || [])
    await phone.waitForTimeout(1500)
    const s = net.reset()
    return { kind, fcpMs: fcp, barMs: tBar, dataMs: tData, downKB: kb(s.down), upKB: kb(s.up), requests: s.requests.length, js: s.requests.filter((r) => r.endsWith('.js')).length, conns: s.conns, longTasks: lt.length, longestTaskMs: Math.max(0, ...lt) }
  }

  /** opens the big conversation and waits for its last message */
  async function openChat() {
    net.reset()
    const t0 = Date.now()
    await phone.locator('.titlebar-btn').first().click()
    await phone.locator('.session-item', { hasText: 'Big chat' }).first().click({ position: { x: 10, y: 10 } })
    let done = true
    await phone.waitForFunction(() => document.body.innerText.includes('LAST MESSAGE of the big chat'), null, { timeout: CHAT_LIMIT, polling: 200 }).catch(() => (done = false))
    const ms = Date.now() - t0
    await phone.waitForTimeout(done ? 2500 : 0)
    const s = net.reset()
    const heap = await phone.evaluate(() => Math.round((performance.memory?.usedJSHeapSize ?? 0) / 1e6)).catch(() => -1)
    const imgs = s.requests.filter((r) => r.startsWith('/api/img/')).length
    return { kind: 'open big chat', ms: done ? ms : `>${CHAT_LIMIT}`, downKB: kb(s.down), images: imgs, heapMB: heap }
  }

  /** streams 600 tokens at 60 per second into a chat the phone shows, cutting the line for 2.5 s in the middle */
  async function stream() {
    await phone.locator('.titlebar-btn').first().click()
    await phone.locator('.session-item', { hasText: 'Older 0' }).first().click({ position: { x: 10, y: 10 } })
    await phone.waitForTimeout(1500)
    net.reset()
    const words = Array.from({ length: 600 }, (_, i) => `t${String(i).padStart(3, '0')} `)
    const t0 = Date.now()
    const running = app.evaluate(async (_e, ws) => {
      const ev = globalThis.joltyTestEvent
      ev({ type: 'status', sessionId: 'o0', status: 'running' })
      ev({ type: 'item', sessionId: 'o0', item: { kind: 'assistant', id: 'live1', text: '' } })
      for (let i = 0; i < ws.length; i++) {
        ev({ type: 'delta', sessionId: 'o0', itemId: 'live1', kind: 'assistant', delta: ws[i] })
        if (i % 6 === 5) await new Promise((r) => setTimeout(r, 100))
      }
      ev({ type: 'status', sessionId: 'o0', status: 'idle' })
    }, words)
    setTimeout(() => net.cut(2500), 4000)
    await running
    const want = words.join('').trim()
    let ok = true
    await phone.waitForFunction((w) => document.body.innerText.includes(w), want, { timeout: 60000, polling: 200 }).catch(() => (ok = false))
    const ms = Date.now() - t0
    const text = await phone.evaluate(() => document.body.innerText)
    const dup = words.filter((w) => text.split(w.trim()).length - 1 > 1).length
    const s = net.reset()
    return { kind: 'stream 600 tokens + 2.5 s cut', complete: ok, duplicated: dup, ms, wsDownKB: kb(s.wsDown), conns: s.conns }
  }

  for (const name of pick) {
    net.set(PROFILES[name])
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 })
    const cold = await load('cold')
    const warm = await load('warm')
    const chat = await openChat().catch((e) => ({ kind: 'open big chat', ms: 'failed', error: String(e).slice(0, 80) }))
    const live = name === 'slow3g' ? await stream().catch((e) => ({ kind: 'stream', complete: false, error: String(e).slice(0, 80) })) : undefined
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 })
    results.runs.push({ profile: name, ...PROFILES[name], cold, warm, chat, ...(live ? { live } : {}) })
    console.log(JSON.stringify(results.runs[results.runs.length - 1]))
  }
  fs.mkdirSync('out-test', { recursive: true })
  fs.writeFileSync(path.join('out-test', `remote-load-${LABEL}.json`), JSON.stringify(results, null, 2))
  console.log(`\n${LABEL}: transcript ${results.transcriptMB} MB on the PC, ${results.assets.files} built files ${results.assets.totalKB} KB`)
  for (const r of results.runs) {
    for (const x of [r.cold, r.warm]) console.log(`${r.profile.padEnd(7)} ${x.kind.padEnd(5)} fcp ${x.fcpMs} ms, app bar ${x.barMs} ms, list ${x.dataMs} ms, ${x.downKB} KB down, ${x.requests} requests (${x.js} js), long tasks ${x.longTasks} (max ${x.longestTaskMs} ms)`)
    console.log(`${r.profile.padEnd(7)} chat  ${r.chat.ms} ms, ${r.chat.downKB} KB down, ${r.chat.images} pictures, heap ${r.chat.heapMB} MB`)
    if (r.live) console.log(`${r.profile.padEnd(7)} live  complete ${r.live.complete}, duplicated ${r.live.duplicated}, ${r.live.ms} ms, ${r.live.wsDownKB} KB on the socket, ${r.live.conns} connections`)
  }
} finally {
  await app.close().catch(() => undefined)
  await net.close()
  fs.rmSync(data, { recursive: true, force: true })
}
