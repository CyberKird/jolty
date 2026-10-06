import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { _electron as electron } from 'playwright-core'

const data = fs.mkdtempSync(path.join(os.tmpdir(), 'jolty-codex-ui-'))
const project = path.join(data, 'project')
const config = path.join(data, 'profiles', 'mock', 'codex')
fs.mkdirSync(project, { recursive: true })
fs.mkdirSync(config, { recursive: true })
const write = (file, value) => fs.writeFileSync(path.join(data, file), JSON.stringify(value))
write('profiles.json', [{ id: 'mock', name: 'Local Codex test', engine: 'codex', auth: 'apiKey', isDefaultDir: false, color: '#123456' }])
write('secrets.json', { mock: { enc: false, value: 'sk-mock' } })
write('sessions.json', [{ id: 'chat', profileId: 'mock', engine: 'codex', cwd: project, title: 'Compaction regression', model: 'mock-model', permissionMode: 'ask', createdAt: 1, updatedAt: 1 }])
write('settings.json', { lastCwd: project, lastProfileId: 'mock' })
fs.writeFileSync(path.join(config, 'config.toml'), [
  'model = "mock-model"', 'model_provider = "mock"', '[model_providers.mock]',
  'name = "Local Responses"', `base_url = "${process.env.MOCK_RESPONSES || 'http://127.0.0.1:8767'}/v1"`,
  'wire_api = "responses"', 'supports_websockets = false', 'requires_openai_auth = false'
].join('\n'))
const env = { ...process.env, JOLTY_DATA_DIR: data, JOLTY_TEST: '1' }
delete env.ELECTRON_RUN_AS_NODE
const app = await electron.launch({
  executablePath: path.resolve(process.platform === 'win32' ? 'node_modules/electron/dist/electron.exe' : 'node_modules/.bin/electron'),
  args: ['--no-sandbox', path.resolve('out/main/index.js'), '--user-data-dir=' + path.join(data, 'electron')], env
})
try {
  const win = await app.firstWindow()
  const errors = []
  win.on('pageerror', (err) => errors.push(String(err)))
  await win.locator('.session-item').first().click()
  const input = win.locator('textarea')
  const stop = win.getByRole('button', { name: 'Oprește (Esc)', exact: true })
  await input.fill('First message')
  await win.getByRole('button', { name: 'Trimite (Enter)', exact: true }).click()
  await stop.waitFor({ state: 'visible' })
  await input.fill('Queued during startup')
  await win.getByRole('button', { name: 'Pune în așteptare (Enter)', exact: true }).click()
  await win.waitForFunction(() => document.querySelectorAll('.msg-assistant').length >= 2, null, { timeout: 45000 })
  await stop.waitFor({ state: 'hidden', timeout: 45000 })
  assert.equal(await input.inputValue(), '')
  console.log('PASS startup queue reaches two completed answers')

  await win.locator('.context-meter').click()
  await stop.waitFor({ state: 'visible' })
  await input.fill('Queued during compaction')
  await win.getByRole('button', { name: 'Pune în așteptare (Enter)', exact: true }).click()
  await win.getByText('Conversația a fost compactată ca să încapă în context.', { exact: true }).waitFor({ timeout: 45000 })
  await win.waitForFunction(() => document.querySelectorAll('.msg-assistant').length >= 3, null, { timeout: 45000 })
  await stop.waitFor({ state: 'hidden', timeout: 45000 })
  assert.equal(await input.inputValue(), '')
  assert.deepEqual(errors, [])
  console.log('PASS compaction completes, queued message resumes, running indicator clears')
} finally {
  await app.close()
}
