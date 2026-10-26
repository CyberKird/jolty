// In the real app: the text typed in the chat box stays when the chat changes, on a new chat and after a restart; the
// Account tab connects a (mock) Google account, backs up and offers the restore; the account shows under live usage.
// Home and data folders are temporary; Google is a local server. Interface language: Romanian (the keys).
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { _electron as electron } from 'playwright-core'
import { startGoogleMock } from './mocks/google-mock.mjs'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jolty-account-'))
const data = path.join(root, 'data')
const home = path.join(root, 'home')
fs.mkdirSync(path.join(data, 'transcripts'), { recursive: true })
fs.mkdirSync(path.join(home, '.claude', 'skills', 'mine'), { recursive: true })
fs.writeFileSync(path.join(home, '.claude', 'skills', 'mine', 'SKILL.md'), '---\nname: mine\ndescription: test\n---\nbody\n')
fs.mkdirSync(path.join(home, '.claude', 'skills', 'huge'), { recursive: true })
fs.writeFileSync(path.join(home, '.claude', 'skills', 'huge', 'SKILL.md'), '---\nname: huge\ndescription: too big on purpose\n---\n' + 'x'.repeat(120 * 1024))
fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({ mcpServers: { docs: { command: 'npx', args: ['docs'] } } }))
fs.writeFileSync(path.join(data, 'profiles.json'), JSON.stringify([{ id: 'p1', name: 'Test', engine: 'claude', auth: 'subscription', color: '#d97757' }]))
fs.writeFileSync(
  path.join(data, 'sessions.json'),
  JSON.stringify([
    { id: 's1', profileId: 'p1', engine: 'claude', cwd: data, title: 'Alpha', permissionMode: 'ask', createdAt: 2, updatedAt: 2 },
    { id: 's2', profileId: 'p1', engine: 'claude', cwd: data, title: 'Beta', permissionMode: 'ask', createdAt: 1, updatedAt: 1 }
  ])
)
fs.writeFileSync(path.join(data, 'settings.json'), JSON.stringify({ language: 'ro', lastCwd: data }))
fs.writeFileSync(path.join(data, 'backup-config.json'), JSON.stringify({ google: { clientId: 'cid' } }))
fs.writeFileSync(path.join(data, 'secrets.json'), JSON.stringify({ 'backup:google:field:clientSecret': { enc: false, value: 'sec' } }))
for (const id of ['s1', 's2']) fs.writeFileSync(path.join(data, 'transcripts', `${id}.json`), JSON.stringify([{ kind: 'user', id: 'u', text: 'hi' }, { kind: 'assistant', id: 'a', text: 'hello' }]))

const google = await startGoogleMock()
const env = { ...process.env, JOLTY_TEST: '1', JOLTY_DATA_DIR: data, HOME: home, USERPROFILE: home, JOLTY_BACKUP_MOCK: google.url }
delete env.ELECTRON_RUN_AS_NODE
const launch = () => electron.launch({ args: [path.resolve('out/main/index.js'), '--user-data-dir=' + path.join(root, 'electron')], env, timeout: 60000 })
const pause = (ms) => new Promise((r) => setTimeout(r, ms))
const box = (win) => win.locator('.composer textarea').first()
const open = async (win, title) => {
  await win.locator('.session-item', { hasText: title }).click()
  await win.locator('.session-item.active', { hasText: title }).waitFor()
  await win.waitForSelector('.messages-inner')
  await pause(300)
}
const ready = async (app) => {
  const win = await app.firstWindow()
  win.setDefaultTimeout(30000)
  await win.waitForSelector('.brand-name', { timeout: 60000 })
  await win.keyboard.press('Escape')
  return win
}

let app = await launch()
try {
  let win = await ready(app)

  // ---- the chat box keeps what is typed
  await box(win).fill('draft for the new chat')
  await open(win, 'Alpha')
  assert.equal(await box(win).inputValue(), '', 'another chat starts with an empty box')
  await box(win).fill('draft for Alpha')
  await open(win, 'Beta')
  assert.equal(await box(win).inputValue(), '')
  await open(win, 'Alpha')
  assert.equal(await box(win).inputValue(), 'draft for Alpha', 'the text is back when returning to the chat')
  await win.locator('button.new-chat').click()
  await win.waitForSelector('.welcome')
  assert.equal(await box(win).inputValue(), 'draft for the new chat', 'a new chat shows what was typed there')
  console.log('PASS chat box: text stays across chats and the new-chat page')

  await app.close()
  app = await launch()
  win = await ready(app)
  assert.equal(await box(win).inputValue(), 'draft for the new chat', 'after a restart')
  await open(win, 'Alpha')
  assert.equal(await box(win).inputValue(), 'draft for Alpha')
  console.log('PASS chat box: text survives a restart')

  // ---- account under live usage, the Account tab, connect, back up, restore
  await app.evaluate(({ shell }, base) => {
    // the sign-in page opens in the browser: here the "browser" is a plain request that follows the redirect back
    shell.openExternal = async (url) => void (await fetch(url))
    return base
  }, google.url)
  const chip = win.locator('.account-chip')
  await chip.waitFor()
  assert.match(await chip.innerText(), /Conectează un cont pentru backup/)
  await chip.click()
  await win.locator('.backup-head', { hasText: 'Google Drive' }).click()
  await win.getByRole('button', { name: 'Conectează', exact: true }).click()
  await win.getByText('ana@gmail.example').first().waitFor()
  assert.match(await chip.innerText(), /Ana[\s\S]*Google Drive/, 'the account shows under live usage')

  await win.getByPlaceholder('Parola de backup').fill('correct horse battery')
  await win.getByRole('button', { name: 'Salvează parola' }).click()
  await win.getByRole('button', { name: /Fă backup acum/ }).click()
  await win.getByText(/Backup făcut/).first().waitFor()
  assert.equal(google.drive.size, 1, 'one encrypted file in the Drive app folder')
  await win.getByText(/Ultimul backup de pe acest PC/).waitFor()
  console.log('PASS account: connect, password, backup')

  const metrics = await win.locator('.use-metric').allInnerTexts()
  assert.ok(metrics.length >= 6, 'two clocks and four counts')
  assert.match(metrics[0], /Timp de prompting cu AI[\s\S]*\(.* h\)/i)
  assert.match(metrics[1], /Timp petrecut în aplicație[\s\S]*\(.* h\)/i)
  console.log('PASS account: use time shows both clocks as years/months/days (hours)')

  await win.getByRole('button', { name: /Restaurează din Google Drive/ }).click()
  await win.getByText('Încă nu ai făcut').waitFor({ state: 'detached' }).catch(() => undefined)
  await win.locator('table.table tbody tr').first().waitFor()
  const rows = await win.locator('table.table tbody tr').allInnerTexts()
  assert.ok(rows.some((r) => /docs/.test(r)), 'the MCP server is listed for review')
  assert.ok(rows.some((r) => /mine/.test(r)), 'the skill is listed for review')
  await win.getByRole('button', { name: 'Renunță' }).click()
  await win.getByRole('button', { name: /Restaurează din Google Drive/ }).waitFor()
  console.log('PASS account: restore opens the review, cancelling leaves everything as it was')

  // a too-big skill: its alert can be hidden, the badge goes, the alert waits in a small list, and comes back on request
  await win.locator('.nav-item', { hasText: 'Skilluri' }).click()
  await win.waitForSelector('.skills-body')
  await win.locator('.nav-alert').waitFor()
  assert.equal((await win.locator('.nav-alert').innerText()).trim(), '1')
  await win.getByRole('tab', { name: /Atenție/ }).click()
  await win.getByRole('button', { name: 'Ascunde', exact: true }).click()
  await win.locator('.nav-alert').waitFor({ state: 'detached' })
  await win.getByText('Alerte ascunse (1)').click()
  await win.getByRole('button', { name: 'Arată din nou' }).click()
  await win.locator('.nav-alert').waitFor()
  await win.getByRole('button', { name: 'Ascunde', exact: true }).click()
  console.log('PASS skills: a too-big alert can be hidden and shown again, the badge follows')
  await app.close()
  app = await launch()
  win = await ready(app)
  await win.locator('.nav-item', { hasText: 'Skilluri' }).waitFor()
  await pause(1500)
  assert.equal(await win.locator('.nav-alert').count(), 0, 'the hidden alert stays hidden after a restart')
  console.log('PASS skills: hidden alert survives a restart')
} finally {
  await app.close().catch(() => undefined)
  google.server.close()
  fs.rmSync(root, { recursive: true, force: true })
}
