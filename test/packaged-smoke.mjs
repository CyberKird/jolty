// Starts the packaged app (dist/*-unpacked) and checks that it finds its bundled engines.
import { _electron as electron } from 'playwright-core'
import fs from 'fs'
import os from 'os'
import path from 'path'

const dir = fs.readdirSync('dist').find((d) => d.endsWith('-unpacked'))
if (!dir) throw new Error('no dist/*-unpacked folder: run electron-builder --dir first')
const exe = ['Jolty.exe', 'jolty', 'Jolty'].map((n) => path.resolve('dist', dir, n)).find((p) => fs.existsSync(p))
const data = fs.mkdtempSync(path.join(os.tmpdir(), 'jolty-smoke-'))
// with the Anthropic mock running (test/README.md), also hold a conversation through the packaged engine
const mock = process.env.MOCK_ANTHROPIC
if (mock) {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'jolty-smoke-project-'))
  fs.writeFileSync(path.join(data, 'profiles.json'), JSON.stringify([{ id: 'mock', name: 'Mock', engine: 'claude', auth: 'endpoint', isDefaultDir: true, baseUrl: mock, models: ['mock-model'], vision: false, color: '#e0a23b' }]))
  fs.writeFileSync(path.join(data, 'secrets.json'), JSON.stringify({ mock: { enc: false, value: 'sk-mock' } }))
  fs.writeFileSync(path.join(data, 'settings.json'), JSON.stringify({ lastCwd: project, lastProfileId: 'mock' }))
}
const app = await electron.launch({ executablePath: exe, args: ['--no-sandbox'], env: { ...process.env, JOLTY_DATA_DIR: data } })
const win = await app.firstWindow()
await win.waitForSelector('.brand-name', { timeout: 60000 })
let answer = ''
if (mock) {
  await win.fill('.composer textarea', 'Salut, răspunde scurt te rog')
  await win.keyboard.press('Enter')
  await win.waitForSelector('.msg-assistant', { timeout: 90000 })
  answer = (await win.textContent('.msg-assistant')) || ''
}
await win.click('.nav-item:has-text("Verificare sistem")')
await win.waitForSelector('.check-row', { timeout: 60000 })
const rows = await win.$$eval('.check-row', (els) => els.map((e) => e.textContent || ''))
await win.click('.nav-item:has-text("Setări")')
await win.waitForSelector('.lead')
const version = await win.textContent('.lead')
await app.close()
fs.rmSync(data, { recursive: true, force: true })

let failed = 0
const check = (ok, what) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${what}`)
  if (!ok) failed++
}
const row = (label) => rows.find((r) => r.startsWith(label)) || ''
check(row('Claude Code').includes('app.asar.unpacked'), `Claude Code found: ${row('Claude Code')}`)
check(row('Codex').includes('app.asar.unpacked'), `Codex found: ${row('Codex')}`)
check(/Jolty \d+\.\d+\.\d+/.test(version || ''), `version shown: ${version}`)
if (mock) check(answer.trim().length > 0, `the packaged Claude Code answered: ${answer.trim().slice(0, 60)}`)
process.exit(failed ? 1 : 0)
