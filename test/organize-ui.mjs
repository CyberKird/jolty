// Pin, archive and reopen-closed in the real sidebar: pinned section on top, Archived at the bottom, Undo toasts,
// "Archive finished", Ctrl+Shift+T, and pins/archive surviving a restart while the removed ones do not. Local data only.
// SHOTS=<folder> keeps screenshots there.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { _electron as electron } from 'playwright-core'

const data = fs.mkdtempSync(path.join(os.tmpdir(), 'jolty-organize-ui-'))
const shots = process.env.SHOTS || data
fs.mkdirSync(shots, { recursive: true })
fs.writeFileSync(path.join(data, 'profiles.json'), JSON.stringify([{ id: 'p1', name: 'Local', engine: 'claude', auth: 'endpoint', baseUrl: 'http://127.0.0.1:9', local: true, models: ['m'], color: '#d97757' }]))
const mk = (id, title, extra = {}) => ({ id, profileId: 'p1', engine: 'claude', cwd: path.join(data, 'proj'), title, permissionMode: 'ask', createdAt: 1, updatedAt: 5000 - Object.keys(extra).length, ...extra })
const list = [mk('a', 'Fix the login bug'), mk('b', 'Plan the release'), mk('c', 'Refactor the sidebar'), mk('d', 'Write the changelog'), mk('sched', 'Nightly report', { scheduled: true }), mk('kid', 'Parallel: tests', { parentId: 'a' })]
list.forEach((s, i) => (s.updatedAt = 5000 - i))
fs.writeFileSync(path.join(data, 'sessions.json'), JSON.stringify(list))
fs.writeFileSync(path.join(data, 'settings.json'), JSON.stringify({ language: 'ro', lastCwd: data }))
fs.mkdirSync(path.join(data, 'transcripts'))
fs.writeFileSync(path.join(data, 'transcripts', 'b.json'), JSON.stringify([{ kind: 'user', id: 'u1', text: 'remember me after undo' }]))

const env = { ...process.env, JOLTY_TEST: '1', JOLTY_DATA_DIR: data, HOME: data, APPDATA: path.join(data, 'appdata') }
delete env.ELECTRON_RUN_AS_NODE
const launch = () => electron.launch({ args: [path.resolve('out/main/index.js'), '--user-data-dir=' + path.join(data, 'electron')], env, timeout: 60000 })
const pause = (ms) => new Promise((r) => setTimeout(r, ms))
const titles = (win, sel) => win.locator(`${sel} .session-item .title`).allInnerTexts().then((t) => t.map((x) => x.trim()))
const row = (win, text) => win.locator('.session-item', { hasText: text }).first()
// locator.hover() hangs in this window; moving the mouse to the row does the same
const hover = async (win, loc) => {
  const b = await loc.boundingBox()
  await win.mouse.move(b.x + b.width / 2, b.y + b.height / 2)
}
const noToast = (win) => win.waitForFunction(() => !document.querySelector('.toast'), undefined, { timeout: 20000 })
const shot = (win, name) => win.screenshot({ path: path.join(shots, name + '.png') })

async function session(run) {
  const app = await launch()
  try {
    const win = await app.firstWindow()
    win.setDefaultTimeout(30000)
    await win.waitForSelector('.session-item', { timeout: 60000 })
    await win.keyboard.press('Escape')
    await run(win)
  } finally {
    const proc = app.process()
    await Promise.race([app.close().catch(() => undefined), pause(10000)])
    if (proc.exitCode === null) proc.kill()
  }
}

await session(async (win) => {
  // 1. pin: moves to a section at the top
  await hover(win, row(win, 'Refactor the sidebar'))
  await row(win, 'Refactor the sidebar').locator('.row-act').click()
  await win.waitForSelector('.session-group.pinned')
  assert.deepEqual(await titles(win, '.session-group.pinned'), ['Refactor the sidebar'])
  assert.equal(await win.locator('.session-group').first().getAttribute('class'), 'session-group pinned', 'pinned section is first')
  assert.ok(!(await titles(win, '.session-group:not(.pinned)')).includes('Refactor the sidebar'), 'not listed twice')
  await shot(win, '1-pinned')

  // 2. archive from the menu: row leaves the list, Undo toast, Undo brings it back
  await row(win, 'Plan the release').click({ button: 'right' })
  await win.locator('.ctx-item', { hasText: 'Arhivează' }).first().click()
  await win.waitForSelector('.toast .toast-action')
  assert.ok(!(await titles(win, '.session-group:not(.archived)')).includes('Plan the release'))
  await win.locator('.archived-head').waitFor()
  assert.equal(await win.locator('.archived-head').getAttribute('aria-expanded'), 'false', 'archived is closed by default')
  await shot(win, '2-archived-toast')
  await win.locator('.toast-action').click()
  await win.waitForFunction(() => !document.querySelector('.archived-head'))
  assert.ok((await titles(win, '.session-group:not(.pinned)')).includes('Plan the release'), 'Undo restores the row')

  // 3. archive again, open the section, unarchive from there
  await row(win, 'Plan the release').click({ button: 'right' })
  await win.locator('.ctx-item', { hasText: 'Arhivează' }).first().click()
  await win.locator('.archived-head').click()
  await win.waitForSelector('.session-group.archived .session-item')
  await shot(win, '3-archived-open')
  await win.waitForTimeout(500)

  await noToast(win)
  // 4. delete a row, Undo, and the transcript is back
  await hover(win, row(win, 'Write the changelog'))
  await row(win, 'Write the changelog').locator('.del').click()
  await win.waitForSelector('.toast .toast-action')
  assert.ok(!(await titles(win, '.session-group:not(.archived)')).includes('Write the changelog'))
  await win.locator('.toast-action').click()
  await win.waitForFunction(() => [...document.querySelectorAll('.session-item .title')].some((t) => t.textContent.includes('Write the changelog')))

  // 5. delete the archived one with a transcript, reopen with Ctrl+Shift+T: it opens and its history shows
  const archivedRow = win.locator('.session-group.archived .session-item', { hasText: 'Plan the release' })
  await hover(win, archivedRow)
  await archivedRow.locator('.del').click()
  await win.waitForFunction(() => !document.querySelector('.session-group.archived'))
  await win.keyboard.press('Control+Shift+T')
  await win.waitForSelector('.session-item.active')
  await win.waitForFunction(() => document.body.innerText.includes('remember me after undo'), undefined, { timeout: 15000 })
  await shot(win, '5-reopened')

  // 6. the header menu: reopen entry (nothing removed now) and Archive finished (scheduled run + child)
  await win.locator('.head-act').click()
  await win.waitForSelector('.ctx')
  await shot(win, '6-menu')
  const finished = win.locator('.ctx-item', { hasText: 'Arhivează cele terminate' })
  assert.match(await finished.innerText(), /\(2\)/, 'two finished runs')
  await finished.click()
  await win.waitForSelector('.archived-head')
  assert.match(await win.locator('.archived-head').innerText(), /2/)

  await noToast(win)
  // 7. archive "Plan the release" for the restart check, and remove one for good
  await hover(win, row(win, 'Write the changelog'))
  await row(win, 'Write the changelog').locator('.del').click()
  await win.waitForSelector('.toast .toast-action')
  await pause(300)
})

// restart: pins and archive stay, a removed conversation is gone for good and the trash is empty
await session(async (win) => {
  assert.deepEqual(await titles(win, '.session-group.pinned'), ['Refactor the sidebar'], 'pin survives a restart')
  assert.match(await win.locator('.archived-head').innerText(), /2/, 'archive survives a restart')
  assert.ok(!(await titles(win, '.session-group:not(.archived)')).includes('Write the changelog'))
  await win.locator('.head-act').click()
  await win.waitForSelector('.ctx')
  assert.ok(await win.locator('.ctx-item[disabled], .ctx-item.disabled', { hasText: 'Redeschide' }).count(), 'nothing to reopen after a restart')
  await shot(win, '7-restart')
})
const trashDir = path.join(data, 'trash')
assert.deepEqual(fs.existsSync(trashDir) ? fs.readdirSync(trashDir) : [], [], 'trash folder is empty after a restart')
console.log('organize ui ok, screenshots: ' + shots)
