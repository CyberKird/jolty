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
    { id: 'mock', name: 'DeepSeek (test)', engine: 'claude', auth: 'endpoint', isDefaultDir: true, baseUrl: process.env.MOCK_ANTHROPIC || 'http://127.0.0.1:8766', models: ['mock-model'], vision: false, color: '#e0a23b' }
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
  env: { ...process.env, JOLTY_DATA_DIR: data, HOME: home, JOLTY_TEST: '1' }
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
// the model menu: every profile's models in one list, effort underneath, like the Claude app
const pickModel = async (profileName, nth = 0) => {
  await win.click('.composer .picker-btn >> nth=0')
  const opt = win.locator(`.picker-group:has(.picker-group-head:has-text("${profileName}")) .picker-opt`).nth(nth)
  await opt.waitFor({ timeout: 30000 })
  await opt.click()
}
// the menu itself; subscription accounts are logged out on CI, so nothing here depends on a login
await win.click('.composer .picker-btn >> nth=0')
await win.waitForSelector('.picker-opt', { timeout: 30000 })
await win.waitForTimeout(1500)
await shot('01a-model-menu')
await win.keyboard.press('Escape')
await win.fill('.composer textarea', 'Refactorizează tot proiectul să folosească TypeScript, optimizează netcode-ul pentru multiplayer și adaugă teste complete')
await win.waitForTimeout(9000)
await shot('01b-advice-complex')
await win.fill('.composer textarea', 'redenumește variabila x în playerSpeed')
await win.waitForTimeout(800)
await shot('01c-advice-simple')
await pickModel('DeepSeek (test)')
await win.waitForTimeout(500)
// a hard task on a third-party model: the only time the advice strip speaks up
await win.fill('.composer textarea', 'Refactorizează tot proiectul să folosească TypeScript, optimizează netcode-ul pentru multiplayer și adaugă teste complete')
await win.waitForTimeout(800)
await shot('01e-advice-weak')
// the mode menu, Claude style; 2 = Manual so the write below asks for approval
await win.click('.composer .picker-btn >> nth=1')
await shot('01d-mode-menu')
await win.keyboard.press('2')

// a conversation with the mock model: it streams a file, asks for approval, then answers
await win.fill('.composer textarea', 'Rescrie clasa jucătorului. RUN_WRITE SLOW')
await win.keyboard.press('Enter')
await win.waitForSelector('.code-live pre', { timeout: 60000 })
await win.waitForTimeout(6000)
await shot('02-chat-live-code')
await win.waitForSelector('.permission', { timeout: 60000 })
await shot('03-permission')
await win.fill('.composer textarea', 'Mesaj foarte lung pentru a verifica aspectul în așteptare. '.repeat(18))
await win.keyboard.press('Enter')
await win.waitForSelector('.queued')
const queuedFits = await win.locator('.queued').evaluate((element) => element.scrollWidth <= element.clientWidth + 1)
if (!queuedFits) errors.push('Mesajul în așteptare iese din panou')
await shot('03b-queued')
await win.click('.queued button')
await win.click('.permission .btn.primary')
await win.waitForSelector('.msg-assistant', { timeout: 60000 })
await win.waitForTimeout(1500)
await shot('04-chat-done')
await win.locator('input[type="file"]').setInputFiles(path.join(project, 'README.md'))
await win.waitForSelector('.attachment-file')
await shot('04a-file-attachment')
await win.click('.attachment-file button')
await win.locator('.composer').evaluate((element) => {
  const binary = atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lL8AAAAASUVORK5CYII=')
  const file = new File([Uint8Array.from(binary, (char) => char.charCodeAt(0))], 'lipita.png', { type: 'image/png' })
  const clipboard = new DataTransfer()
  clipboard.items.add(file)
  element.dispatchEvent(new ClipboardEvent('paste', { clipboardData: clipboard, bubbles: true, cancelable: true }))
})
await win.waitForSelector('.attachment-image img')
await shot('04a-pasted-image')
await win.click('.attachment-image button')
const sticks = await win.locator('.messages').evaluate(async (element) => {
  const content = element.firstElementChild
  const tall = document.createElement('div')
  tall.style.height = '1500px'
  content.append(tall)
  await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
  const atBottom = element.scrollHeight - element.scrollTop - element.clientHeight < 2
  element.dispatchEvent(new WheelEvent('wheel', { deltaY: -500, bubbles: true }))
  element.scrollTop = 0
  element.dispatchEvent(new Event('scroll'))
  tall.style.height = '1800px'
  await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
  const stayedUp = element.scrollTop < 20
  tall.remove()
  return atBottom && stayedUp
})
if (!sticks) errors.push('Derularea automată sau pauza la derularea manuală a eșuat')
// the agent's task list above the composer, collapsed then open
await win.fill('.composer textarea', 'Fă un plan pentru migrare RUN_TODO')
await win.keyboard.press('Enter')
await win.waitForSelector('.tasks-bar', { timeout: 60000 })
await win.waitForTimeout(1500)
await shot('04c-tasks')
await win.click('.tasks-bar')
await shot('04d-tasks-open')
await win.click('.tasks-bar')
await win.click('.live-tab:has-text("Modificări")')
await win.click('.change-row >> nth=0')
await shot('04b-changes')

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

// scaling: a small window, the live panel floating over the chat, the sidebar folded away
await win.click('.modal .btn.ghost')
await win.click('.session-item >> nth=0')
await win.setViewportSize({ width: 1024, height: 700 })
await shot('12-narrow')
// the panel opened at full width now floats over the chat; its own close button hides it
await win.click('.live-close')
await shot('12b-narrow-closed')
await win.click('.titlebar-btn')
await win.waitForTimeout(400)
await shot('12c-no-sidebar')
await win.setViewportSize({ width: 1920, height: 1080 })
await win.click('.titlebar-btn')
await shot('13-wide')

console.log(errors.length ? `renderer errors:\n${errors.join('\n')}` : 'no renderer errors')
await app.close()
