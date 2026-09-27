// Drives the built Jolty app with Playwright and saves screenshots of every screen.
// Needs the mock servers from test/mocks and a display (xvfb-run on Linux).
import { _electron as electron } from 'playwright-core'
import fs from 'fs'
import os from 'os'
import path from 'path'

const out = process.env.SHOTS || path.resolve('shots')
const data = process.env.JOLTY_DATA_DIR
const home = process.env.HOME
fs.mkdirSync(out, { recursive: true })

// --- fixtures: a project, one Anthropic-compatible profile on the mock, sample usage and limits ---
const project = fs.mkdtempSync(path.join(os.tmpdir(), 'jolty-game-'))
fs.mkdirSync(path.join(project, 'src', 'game'), { recursive: true })
fs.writeFileSync(path.join(project, 'README.md'), '# Chad vs Chuds\n')
fs.mkdirSync(data, { recursive: true })
fs.writeFileSync(
  path.join(data, 'profiles.json'),
  JSON.stringify([
    { id: 'claude-main', name: 'Claude (contul principal)', engine: 'claude', auth: 'subscription', isDefaultDir: true, color: '#d97757' },
    { id: 'codex-main', name: 'Codex (contul principal)', engine: 'codex', auth: 'subscription', isDefaultDir: true, color: '#10a37f' },
    { id: 'claude-2', name: 'Claude (al doilea cont)', engine: 'claude', auth: 'subscription', isDefaultDir: false, color: '#6c8cff' },
    { id: 'mock', name: 'DeepSeek (test)', engine: 'claude', auth: 'endpoint', isDefaultDir: true, baseUrl: 'http://127.0.0.1:8766', models: ['mock-model'], vision: false, color: '#e0a23b' }
  ])
)
fs.writeFileSync(path.join(data, 'secrets.json'), JSON.stringify({ mock: { enc: false, value: 'sk-mock' } }))
fs.writeFileSync(path.join(data, 'settings.json'), JSON.stringify({ lastCwd: project, lastProfileId: 'mock' }))
const now = Date.now()
const hour = 3600e3
fs.writeFileSync(
  path.join(data, 'limits.json'),
  JSON.stringify({
    'claude-main': { profileId: 'claude-main', windows: [{ label: '5 ore', usedPercent: 42, resetsAt: now + 2.4 * hour }, { label: '7 zile', usedPercent: 78, resetsAt: now + 61 * hour }], note: 'Plan: max', updatedAt: now },
    'codex-main': { profileId: 'codex-main', windows: [{ label: '5 ore', usedPercent: 12, resetsAt: now + 4 * hour }, { label: '7 zile', usedPercent: 33, resetsAt: now + 100 * hour }], note: 'Plan: plus', updatedAt: now }
  })
)
const usage = []
for (let d = 13; d >= 0; d--) {
  const turns = 3 + ((d * 7) % 9)
  for (let t = 0; t < turns; t++) {
    usage.push({ profileId: 'claude-main', engine: 'claude', model: t % 3 ? 'model-echilibrat' : 'model-mare', inputTokens: 18000 + ((d * 997 + t * 131) % 40000), outputTokens: 2500 + ((d * 311 + t * 17) % 6000), cacheReadTokens: 30000, cacheWriteTokens: 4000, costUsd: 0.08 + ((d + t) % 5) * 0.03, ts: now - d * 24 * hour - t * 600e3 })
    if (t % 2 === 0) usage.push({ profileId: 'codex-main', engine: 'codex', model: 'gpt-6-sol', inputTokens: 9000 + ((d * 503 + t * 71) % 20000), outputTokens: 1500 + ((d * 97 + t) % 3000), cacheReadTokens: 5000, cacheWriteTokens: 0, ts: now - d * 24 * hour - t * 900e3 })
  }
}
fs.writeFileSync(path.join(data, 'usage.jsonl'), usage.map((u) => JSON.stringify(u)).join('\n') + '\n')

const app = await electron.launch({
  executablePath: path.resolve('node_modules/.bin/electron'),
  args: ['--no-sandbox', path.resolve('out/main/index.js')],
  env: { ...process.env, JOLTY_DATA_DIR: data, HOME: home }
})
const win = await app.firstWindow()
await win.setViewportSize({ width: 1500, height: 920 })
const errors = []
win.on('pageerror', (e) => errors.push(String(e)))
win.on('console', (m) => m.type() === 'error' && errors.push(m.text()))
const shot = async (name) => {
  await win.waitForTimeout(500)
  await win.screenshot({ path: path.join(out, `${name}.png`) })
  console.log('shot', name)
}

await win.waitForSelector('.brand-name')
await shot('01-welcome')

// the complexity advice while typing, on a Claude profile (real model list with effort levels)
await win.selectOption('.composer select[aria-label="Profil"]', 'claude-main')
await win.fill('.composer textarea', 'Refactorizează tot proiectul să folosească TypeScript, optimizează netcode-ul pentru multiplayer și adaugă teste complete')
await win.waitForTimeout(9000)
await shot('01b-advice-complex')
await win.fill('.composer textarea', 'redenumește variabila x în playerSpeed')
await win.waitForTimeout(800)
await shot('01c-advice-simple')
await win.selectOption('.composer select[aria-label="Profil"]', 'mock')
await win.waitForTimeout(500)

// a conversation with the mock model: it streams a file, asks for approval, then answers
await win.fill('.composer textarea', 'Rescrie clasa jucătorului. RUN_WRITE SLOW')
await win.keyboard.press('Enter')
await win.waitForSelector('.code-live pre', { timeout: 60000 })
await win.waitForTimeout(6000)
await shot('02-chat-live-code')
await win.waitForSelector('.permission', { timeout: 60000 })
await shot('03-permission')
await win.click('.permission .btn.primary')
await win.waitForSelector('.msg-assistant', { timeout: 60000 })
await win.waitForTimeout(1500)
await shot('04-chat-done')

for (const [label, name] of [
  ['Conturi și chei', '05-accounts'],
  ['Modele locale', '06-local'],
  ['Consum', '07-usage'],
  ['Verificare sistem', '08-system'],
  ['Importă sesiuni', '09-import'],
  ['Setări', '10-settings']
]) {
  await win.click(`.nav-item:has-text("${label}")`)
  await win.waitForTimeout(2500)
  await shot(name)
}

// add-profile dialog
await win.click('.nav-item:has-text("Conturi și chei")')
await win.click('button:has-text("Adaugă profil")')
await win.click('.segmented button:has-text("Endpoint compatibil")')
await shot('11-add-profile')

console.log(errors.length ? `renderer errors:\n${errors.join('\n')}` : 'no renderer errors')
await app.close()
