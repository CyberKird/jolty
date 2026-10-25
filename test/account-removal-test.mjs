import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { _electron as electron } from 'playwright-core'

const data = fs.mkdtempSync(path.join(os.tmpdir(), 'jolty-account-removal-'))
const shared = path.join(data, 'shared')
fs.mkdirSync(shared)
fs.writeFileSync(path.join(shared, 'keep.txt'), 'preserve shared files')
const profiles = ['claude', 'codex'].map((engine) => ({
  id: `remove-${engine}`, name: `Remove ${engine}`, engine, auth: 'subscription', color: '#d97757'
}))
// the main account (default dir, nothing of Jolty's on disk) can be removed too
profiles.push({ id: 'claude-main', name: 'Remove main', engine: 'claude', auth: 'subscription', isDefaultDir: true, color: '#10a37f' })
fs.writeFileSync(path.join(data, 'profiles.json'), JSON.stringify(profiles))
// a saved chat per account: removing the account must keep it
fs.writeFileSync(path.join(data, 'sessions.json'), JSON.stringify(profiles.map((p) => ({
  id: `chat-${p.id}`, profileId: p.id, engine: p.engine, cwd: data, title: `Chat ${p.id}`, permissionMode: 'ask', createdAt: 1, updatedAt: 1
}))))
fs.writeFileSync(path.join(data, 'settings.json'), JSON.stringify({ language: 'ro', lastCwd: data }))
for (const profile of profiles.filter((p) => !p.isDefaultDir)) {
  const dir = path.join(data, 'profiles', profile.id, profile.engine)
  fs.mkdirSync(dir, { recursive: true })
  fs.symlinkSync(shared, path.join(dir, 'skills'), process.platform === 'win32' ? 'junction' : 'dir')
}
const env = { ...process.env, JOLTY_TEST: '1', JOLTY_DATA_DIR: data }
delete env.ELECTRON_RUN_AS_NODE
const packaged = process.env.JOLTY_ACCOUNT_TEST_EXECUTABLE
const app = await electron.launch({
  executablePath: path.resolve(packaged || 'node_modules/electron/dist/electron.exe'),
  args: [...(packaged ? [] : [path.resolve('out/main/index.js')]), '--user-data-dir=' + path.join(data, 'electron')],
  env, timeout: 60000
})
try {
  const win = await app.firstWindow()
  win.setDefaultTimeout(30000)
  await win.waitForSelector('.brand-name', { timeout: 60000 })
  await win.getByText('Conturi și chei', { exact: true }).click()
  await win.evaluate(() => { window.confirm = () => true })
  await win.evaluate(() => {
    window.removalErrors = []
    new MutationObserver(() => {
      for (const toast of document.querySelectorAll('.toast')) window.removalErrors.push(toast.textContent)
    }).observe(document.body, { subtree: true, childList: true })
  })
  for (const profile of profiles) {
    const card = win.locator('.card').filter({ hasText: profile.name })
    await card.locator('.tag').filter({ hasText: /neconectat|conectat/ }).waitFor({ timeout: 60000 })
    await card.getByTitle('Șterge profilul').click()
    try {
      await card.waitFor({ state: 'detached', timeout: 15000 })
    } catch (error) {
      console.error(await win.evaluate(() => window.removalErrors))
      console.error('profiles after removal:', fs.readFileSync(path.join(data, 'profiles.json'), 'utf8'))
      throw error
    }
    assert.equal(fs.existsSync(path.join(data, 'profiles', profile.id, profile.engine)), false)
    assert.ok(JSON.parse(fs.readFileSync(path.join(data, 'sessions.json'), 'utf8')).some((x) => x.id === `chat-${profile.id}`), 'chat kept')
    assert.equal(fs.readFileSync(path.join(shared, 'keep.txt'), 'utf8'), 'preserve shared files')
    console.log('PASS account removal through UI:', profile.engine)
  }
  assert.ok(JSON.parse(fs.readFileSync(path.join(data, 'profiles.json'), 'utf8')).every((profile) => !profile.id.startsWith('remove-')))
  assert.equal(JSON.parse(fs.readFileSync(path.join(data, 'sessions.json'), 'utf8')).length, profiles.length, 'all chats kept')
} finally {
  await app.close()
  assert.ok(path.resolve(data).startsWith(path.resolve(os.tmpdir()) + path.sep))
  fs.rmSync(data, { recursive: true, force: true })
}
