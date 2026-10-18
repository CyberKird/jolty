// Manual end-to-end check (needs a logged-in Claude on this PC): the real Jolty app and a real model use
// Jolty's own tools: search an earlier conversation, schedule a task, list it and cancel it.
// Usage: npm run build && node test/agent-e2e.mjs [claude|codex]
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { _electron as electron } from 'playwright-core'

const engine = process.argv[2] || 'claude'
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jolty-agent-e2e-'))
const data = path.join(root, 'data')
const cwd = path.join(root, 'proj')
fs.mkdirSync(path.join(data, 'transcripts'), { recursive: true })
fs.mkdirSync(cwd)
fs.writeFileSync(path.join(data, 'settings.json'), JSON.stringify({ language: 'ro', lastCwd: cwd, lastProfileId: engine === 'codex' ? 'codex-main' : 'claude-main', lastModels: { 'codex-main': { model: 'gpt-6.1-sol', effort: 'low' } } }))
// an earlier conversation the model has to find: the answer is only in there
const old = { id: 'old-chat', profileId: 'claude-main', engine: 'claude', cwd, title: 'Discuție veche', permissionMode: 'autoEdit', createdAt: Date.now() - 86400e3, updatedAt: Date.now() - 86400e3 }
fs.writeFileSync(path.join(data, 'sessions.json'), JSON.stringify([old]))
fs.writeFileSync(path.join(data, 'transcripts', 'old-chat.json'), JSON.stringify([
  { kind: 'user', id: 'u1', text: 'Ce culoare alegem pentru logo-ul proiectului Quokka-7731?' },
  { kind: 'assistant', id: 'a1', text: 'Am stabilit: logo-ul Quokka-7731 rămâne turcoaz închis, fără gradient.' }
]))

const env = { ...process.env, JOLTY_TEST: '1', JOLTY_DATA_DIR: data }
delete env.ELECTRON_RUN_AS_NODE
const app = await electron.launch({ executablePath: path.resolve('node_modules/electron/dist/electron.exe'), args: ['out/main/index.js', '--user-data-dir=' + path.join(data, 'electron')], env })
let failed = false
const check = (ok, what) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${what}`)
  if (!ok) failed = true
}
try {
  const win = await app.firstWindow()
  win.setDefaultTimeout(60000)
  await win.waitForSelector('.composer textarea')
  const prompt =
    'Folosește uneltele Jolty: caută în conversațiile mele vechi „Quokka-7731” și spune-mi ce culoare am ales pentru logo. Apoi programează o sarcină numită „E2E ping”, o singură dată, pe 2027-01-01T09:00, cu mesajul „spune pong”. Apoi listează sarcinile programate și anulează „E2E ping”. Răspunde într-un rând: culoarea și dacă sarcina a fost creată și ștearsă.'
  // started through the app's own API with an explicit model; every approval is answered "allow", like a click
  const start = engine === 'codex' ? { profileId: 'codex-main', effort: 'low' } : { profileId: 'claude-main' }
  const t0 = Date.now()
  win.on('console', (m) => m.text().startsWith('codex models') && console.log(m.text()))
  await win.evaluate(async ({ start, cwd, prompt }) => {
    window.__idle = false
    window.jolty.sessions.onEvent((e) => {
      if (e.type === 'permission') void window.jolty.sessions.respond(e.sessionId, e.request.id, 'allow')
      if (e.type === 'status' && e.status !== 'running') window.__idle = true
    })
    if (start.profileId === 'codex-main') {
      const models = await window.jolty.profiles.models('codex-main')
      console.log('codex models: ' + models.map((x) => x.id + (x.isDefault ? '*' : '')).join(', '))
      start.model = (models.find((x) => x.isDefault) || models[0]).id
    }
    const m = await window.jolty.sessions.start({ ...start, cwd, permissionMode: 'autoEdit' })
    await window.jolty.sessions.send(m.id, prompt, [])
  }, { start, cwd, prompt })
  let sawTask = false
  const deadline = Date.now() + 300000
  while (Date.now() < deadline) {
    sawTask ||= await win.evaluate(async () => (await window.jolty.schedules.list()).some((t) => t.name === 'E2E ping')).catch(() => false)
    if (await win.evaluate(() => window.__idle)) break
    await new Promise((r) => setTimeout(r, 1000))
  }
  // the transcript is written 0.8 s after the last event
  await new Promise((r) => setTimeout(r, 2000))
  console.log(`done in ${Math.round((Date.now() - t0) / 1000)}s`)
  const sessions = JSON.parse(fs.readFileSync(path.join(data, 'sessions.json'), 'utf8'))
  const chat = sessions.find((s) => s.id !== 'old-chat')
  const items = chat ? JSON.parse(fs.readFileSync(path.join(data, 'transcripts', `${chat.id}.json`), 'utf8')) : []
  const tools = items.filter((i) => i.kind === 'tool').map((i) => i.name)
  console.log('tools:', tools.join(', '))
  for (const i of items.filter((x) => x.kind === 'tool' && /schedule/.test(x.name))) console.log('tool', i.name, i.status, JSON.stringify(i.input).slice(0, 300), '->', String(i.output).slice(0, 400))
  console.log('notices:', items.filter((i) => i.kind === 'notice').map((i) => i.text).join(' / ').slice(0, 600))
  const answer = items.filter((i) => i.kind === 'assistant').map((i) => i.text).join('\n')
  console.log('answer:', answer.slice(-400))
  check(tools.some((t) => /search_conversations/.test(t)), 'the model searched the earlier conversations')
  check(/turcoaz/i.test(answer), 'it found the color that is only in the earlier conversation')
  check(sawTask, 'the scheduled task was created')
  const left = JSON.parse(fs.existsSync(path.join(data, 'schedules.json')) ? fs.readFileSync(path.join(data, 'schedules.json'), 'utf8') : '[]')
  check(!left.some((t) => t.name === 'E2E ping'), 'and cancelled again')
  await win.screenshot({ path: path.join(os.tmpdir(), 'jolty-agent-e2e.png') })
} finally {
  await app.close().catch(() => undefined)
  fs.rmSync(root, { recursive: true, force: true })
}
process.exit(failed ? 1 : 0)
