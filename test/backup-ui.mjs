// Backup in the real app, two "PCs" with data folders of their own and a local folder as the storage (no cloud account):
// PC A connects, chooses a password, the automatic first backup runs, a change goes up by hand (only the change);
// PC B starts empty, takes "I have Jolty on another PC" from the welcome, connects the same folder, waits instead of
// backing up its empty state, restores, starts again and opens with A's chats and settings. Screenshots in
// out-test/backup-ui/. Needs `npx electron-vite build` first. Never touches the user's own Jolty or home folder.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { _electron as electron } from 'playwright-core'

const shots = path.resolve('out-test/backup-ui')
fs.mkdirSync(shots, { recursive: true })
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jolty-backup-ui-'))
const vault = path.join(root, 'storage')
fs.mkdirSync(vault)
const PASS = 'parola-de-test-lunga'
const pause = (ms) => new Promise((r) => setTimeout(r, ms))
const pids = []

function pcDirs(name) {
  const data = path.join(root, name, 'data')
  const home = path.join(root, name, 'home')
  fs.mkdirSync(data, { recursive: true })
  fs.mkdirSync(home, { recursive: true })
  return { data, home }
}

const A = pcDirs('pc-a')
const project = path.join(A.home, 'proiecte', 'site')
fs.mkdirSync(project, { recursive: true })
fs.writeFileSync(path.join(A.data, 'profiles.json'), JSON.stringify([{ id: 'p1', name: 'Local', engine: 'claude', auth: 'endpoint', baseUrl: 'http://127.0.0.1:9', local: true, models: ['m'], color: '#d97757' }]))
const chats = [
  ['s1', 'Plan pentru site-ul nou'],
  ['s2', 'Factura din noiembrie'],
  ['s3', 'Idei pentru video']
]
fs.writeFileSync(path.join(A.data, 'sessions.json'), JSON.stringify(chats.map(([id, title], i) => ({ id, profileId: 'p1', engine: 'claude', cwd: project, title, permissionMode: 'ask', createdAt: 1000 + i, updatedAt: Date.now() - i * 60000 }))))
fs.writeFileSync(path.join(A.data, 'settings.json'), JSON.stringify({ language: 'ro', lastCwd: project, lastProfileId: 'p1', theme: 'frost' }))
fs.mkdirSync(path.join(A.data, 'transcripts'))
for (const [id, title] of chats) fs.writeFileSync(path.join(A.data, 'transcripts', `${id}.json`), JSON.stringify([{ kind: 'user', id: 'u1', text: title }, { kind: 'assistant', id: 'a1', text: `Răspuns despre ${title.toLowerCase()}.`.repeat(40) }]))
fs.mkdirSync(path.join(A.data, 'ledgers'))
fs.writeFileSync(path.join(A.data, 'ledgers', 'site.md'), '# Notițe\n')
fs.writeFileSync(path.join(A.data, 'secrets.json'), JSON.stringify({ p1: { enc: false, value: 'sk-test-secret' } }))

const launch = (pc, extra = {}) => {
  const env = { ...process.env, JOLTY_TEST: '1', JOLTY_DATA_DIR: pc.data, JOLTY_BACKUP_HOME: pc.home, JOLTY_BACKUP_AUTO: '1', JOLTY_CLAUDE_JSON: path.join(pc.home, '.claude.json'), ...extra }
  delete env.ELECTRON_RUN_AS_NODE
  return electron.launch({ args: [path.resolve('out/main/index.js'), '--user-data-dir=' + path.join(pc.data, '..', 'electron')], env, timeout: 60000 }).then((app) => {
    pids.push(app.process().pid)
    return app
  })
}

async function close(app) {
  let proc
  try {
    proc = app.process()
  } catch {
    // already gone (the restore quit it)
  }
  await Promise.race([app.close().catch(() => undefined), pause(15000)])
  if (proc && proc.exitCode === null) proc.kill()
}

async function window(app) {
  const win = await app.firstWindow()
  win.setDefaultTimeout(30000)
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setSize(1440, 900))
  await win.waitForSelector('.brand-name', { timeout: 60000 })
  await win.keyboard.press('Escape')
  // the Live panel would cover part of the page at this width
  const live = win.locator('aside.live:not(.closed) .live-close')
  if (await live.isVisible().catch(() => false)) await live.click()
  await pause(800)
  return win
}

async function openAccount(win) {
  await win.evaluate(() => localStorage.setItem('jolty.settingsTab', 'account'))
  await win.locator('.account-chip').click()
  await win.locator('.backup-head', { hasText: 'Folder' }).waitFor()
}

/** Folder storage: open its card, fill the path, connect. */
async function connectFolder(win) {
  const head = win.locator('.backup-head', { hasText: 'Folder' })
  if ((await head.getAttribute('aria-expanded')) !== 'true') await head.click()
  const card = win.locator('.card', { has: head })
  await card.locator('input[type=text]').fill(vault)
  await card.locator('button', { hasText: 'Conectează' }).click()
  await card.locator('.account-text').waitFor()
  return card
}

let app = await launch(A)
try {
  const win = await window(app)
  await openAccount(win)
  const card = await connectFolder(win)
  assert.equal(await card.locator('.backup-auto input').isChecked(), true, 'automatic update is on right after connecting')
  await card.locator('input[type=password]').fill(PASS)
  await card.locator('button', { hasText: 'Salvează parola' }).click()
  // the first backup starts by itself; the page follows it
  await card.locator('.backup-status', { hasText: 'Ultima actualizare' }).waitFor({ timeout: 60000 })
  const first = fs.readdirSync(vault)
  assert.ok(first.includes('jolty2-head') && first.some((f) => f.startsWith('jolty2-p-')))
  await win.mouse.move(5, 5)
  await card.screenshot({ path: path.join(shots, '1-pc-a-auto-on-status.png') })
  await win.screenshot({ path: path.join(shots, '1b-pc-a-settings.png') })

  // one chat grows: a backup by hand sends only that
  fs.appendFileSync(path.join(A.data, 'ledgers', 'site.md'), '- o notiță nouă\n')
  await card.locator('button', { hasText: 'Fă backup acum' }).click()
  const toast = win.locator('.toast', { hasText: 'Backup actualizat' })
  await toast.waitFor({ timeout: 30000 })
  console.log(`[measure] app, after one small change: ${await toast.innerText()}`)

  await card.locator('.backup-auto input').uncheck()
  await card.locator('.backup-auto input:not(:checked)').waitFor()
  await card.locator('.backup-auto input').check()
} finally {
  await close(app)
}

// ---------------------------------------------------------------- PC B
const B = pcDirs('pc-b')
// a brand new PC: no Hermes or OpenCode either (this PC has both, and they would get a profile of their own)
fs.writeFileSync(path.join(B.data, 'settings.json'), JSON.stringify({ language: 'ro', hermesPath: path.join(root, 'none.exe'), opencodePath: path.join(root, 'none.exe') }))
app = await launch(B)
try {
  const win = await window(app)
  const choice = win.locator('.start', { hasText: 'Am Jolty pe alt PC' })
  await choice.waitFor()
  await pause(1200)
  await win.screenshot({ path: path.join(shots, '2-pc-b-welcome.png') })
  await choice.click()
  await win.locator('.backup-head', { hasText: 'Folder' }).waitFor()
  const card = await connectFolder(win)
  await card.locator('input[type=password]').fill(PASS)
  await card.locator('button', { hasText: 'Salvează parola' }).click()
  // its automatic run sees A's versions and waits instead of putting this empty PC over them
  await card.locator('.backup-note').waitFor({ timeout: 30000 })
  await card.screenshot({ path: path.join(shots, '3-pc-b-waiting.png') })
  await card.locator('button', { hasText: 'Restaurează pe acest PC' }).click()
  await card.locator('.restore-version').first().waitFor()
  await card.screenshot({ path: path.join(shots, '4-pc-b-restore-what.png') })
  await card.locator('button', { hasText: 'Restaurează și repornește' }).click()
  await card.locator('.restore-panel', { hasText: 'Gata' }).waitFor({ timeout: 60000 })
  await card.screenshot({ path: path.join(shots, '5-pc-b-restore-done.png') })
  // the page asks main to restart; in a test main only quits
  await app.waitForEvent('close', { timeout: 30000 }).catch(() => undefined)
} finally {
  await close(app)
}

// started again: the restore is applied before anything loads
app = await launch(B)
try {
  const win = await window(app)
  for (const [, title] of chats) await win.locator('.session-item', { hasText: title }).waitFor()
  assert.equal(JSON.parse(fs.readFileSync(path.join(B.data, 'settings.json'), 'utf8')).theme, 'frost', 'same theme')
  assert.ok(!fs.existsSync(path.join(B.data, 'secrets.json')) || !fs.readFileSync(path.join(B.data, 'secrets.json'), 'utf8').includes('sk-test-secret'), 'keys stay on PC A')
  const cwd = JSON.parse(fs.readFileSync(path.join(B.data, 'sessions.json'), 'utf8'))[0].cwd
  assert.equal(cwd, path.join(B.home, 'proiecte', 'site'), 'project paths mapped onto this PC')
  await win.screenshot({ path: path.join(shots, '6-pc-b-after-restart.png') })
  await openAccount(win)
  await win.locator('.restore-report').waitFor()
  await win.locator('.restore-report').screenshot({ path: path.join(shots, '7-pc-b-report.png') })
  for (const f of ['transcripts/s1.json', 'transcripts/s2.json', 'ledgers/site.md', 'profiles.json']) assert.deepEqual(fs.readFileSync(path.join(B.data, f)), fs.readFileSync(path.join(A.data, f)), f)
  console.log('backup-ui: OK')
} finally {
  await close(app)
  for (const pid of pids) {
    try {
      process.kill(pid)
    } catch {
      // already gone
    }
  }
  fs.rmSync(root, { recursive: true, force: true })
}
