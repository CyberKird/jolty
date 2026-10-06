import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { _electron as electron } from 'playwright-core'

const data = fs.mkdtempSync(path.join(os.tmpdir(), 'jolty-link-test-'))
const project = path.join(data, 'Project with spaces')
fs.mkdirSync(project)
fs.mkdirSync(path.join(data, 'transcripts'))
const image = path.join(project, 'design arabă #1.png')
const pdf = path.join(project, 'flyer.pdf')
const program = path.join(project, 'program.exe')
fs.writeFileSync(image, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j3ioAAAAASUVORK5CYII=', 'base64'))
fs.writeFileSync(pdf, '%PDF-1.4\n')
fs.writeFileSync(program, 'Test fixture, never execute')
const slash = (file) => file.replaceAll('\\', '/')
const imageHref = slash(image)
const encodedHref = imageHref.split('/').map(encodeURIComponent).join('/').replace(/%3A/i, ':')
const links = [
  ['JPG', imageHref, image],
  ['Windows backslashes', image, image],
  ['PDF', slash(pdf), pdf],
  ['Prefixed path', '/' + imageHref, image],
  ['File URL', pathToFileURL(image).href, image],
  ['Encoded path', encodedHref, image],
  ['Source line', slash(pdf) + ':12', pdf],
  ['Program', slash(program), program],
  ['Missing file', slash(path.join(project, 'missing.pdf')), undefined]
]
let text = links.map(([label, href]) => `[${label}](<${href}>)`).join('\n\n') + '\n\n' +
  '[Website](https://www.joltarise.com/en)\n\n' +
  '<a href="javascript:alert(1)">Unsafe JavaScript</a>\n\n' +
  '<a href="vbscript:msgbox(1)">Unsafe VBScript</a>\n\n' +
  '<a href="data:text/html,attack">Unsafe data</a>\n\n' +
  '<img src="x" onerror="window.linkTestXss=true">'
if (process.env.JOLTY_LINK_NATIVE_FILE) text += `\n\n[Pliant real](<${slash(path.resolve(process.env.JOLTY_LINK_NATIVE_FILE))}>)`
fs.writeFileSync(path.join(data, 'profiles.json'), JSON.stringify([
  { id: 'test', name: 'Local link tests', engine: 'claude', auth: 'endpoint', baseUrl: 'http://127.0.0.1:1', isDefaultDir: false, models: ['test-model'], color: '#d4ff00' }
]))
fs.writeFileSync(path.join(data, 'sessions.json'), JSON.stringify([
  { id: 'links', profileId: 'test', engine: 'claude', cwd: project, title: 'Local file links', model: 'test-model', permissionMode: 'ask', createdAt: Date.now(), updatedAt: Date.now() }
]))
fs.writeFileSync(path.join(data, 'transcripts/links.json'), JSON.stringify([
  { id: 'message', kind: 'assistant', text }
]))
fs.writeFileSync(path.join(data, 'settings.json'), JSON.stringify({ lastCwd: project, lastProfileId: 'test' }))

const env = { ...process.env, JOLTY_DATA_DIR: data, JOLTY_TEST: '1' }
delete env.ELECTRON_RUN_AS_NODE
const packaged = process.env.JOLTY_LINK_TEST_EXECUTABLE
const executablePath = path.resolve(packaged || 'node_modules/electron/dist/electron.exe')
assert.ok(fs.existsSync(executablePath), `Missing Electron executable: ${executablePath}`)
const app = await electron.launch({
  executablePath,
  timeout: 60000,
  args: ['--no-sandbox', ...(packaged ? [] : [path.resolve('out/main/index.js')]), '--user-data-dir=' + path.join(data, 'electron')],
  env
})
try {
  const win = await app.firstWindow()
  await win.waitForSelector('.session-item')
  await win.locator('.session-item').first().click()
  await win.waitForSelector('.msg-assistant .md')
  await app.evaluate(({ shell, clipboard }) => {
    globalThis.linkTestCalls = []
    globalThis.linkTestOriginalOpenPath = shell.openPath
    shell.openPath = async (file) => { globalThis.linkTestCalls.push(['open', file]); return globalThis.linkTestOpenError || '' }
    shell.showItemInFolder = (file) => { globalThis.linkTestCalls.push(['reveal', file]) }
    shell.openExternal = async (url) => { globalThis.linkTestCalls.push(['web', url]) }
    clipboard.writeText = (text) => { globalThis.linkTestCalls.push(['copy', text]) }
  })
  for (const [label, , expected] of links) {
    const link = win.getByRole('link', { name: label, exact: true })
    assert.equal(await link.count(), 1, `${label} must retain a clickable destination`)
    assert.ok(await link.getAttribute('href'), `${label} must retain href after sanitizing`)
    await app.evaluate(() => { globalThis.linkTestCalls = [] })
    await link.click()
    if (!expected) {
      await win.locator('.toast.error').waitFor()
      assert.deepEqual(await app.evaluate(() => globalThis.linkTestCalls), [], 'Missing file must not trigger shell')
    } else {
      await win.waitForTimeout(100)
      assert.deepEqual(await app.evaluate(() => globalThis.linkTestCalls), [[label === 'Program' ? 'reveal' : 'open', expected]], `${label} must route through the main process to the correct file`)
    }
    console.log('PASS', label)
  }
  await app.evaluate(() => { globalThis.linkTestCalls = [] })
  await win.getByRole('link', { name: 'Website', exact: true }).click()
  await win.waitForTimeout(100)
  assert.deepEqual(await app.evaluate(() => globalThis.linkTestCalls), [['web', 'https://www.joltarise.com/en']])
  console.log('PASS web links')
  for (const label of ['Unsafe JavaScript', 'Unsafe VBScript', 'Unsafe data']) {
    assert.equal(await win.getByRole('link', { name: label, exact: true }).count(), 0, `${label} must stay blocked`)
  }
  assert.equal(await win.locator('.md [onerror]').count(), 0)
  assert.equal(await win.evaluate(() => Boolean(window.linkTestXss)), false)
  console.log('PASS dangerous URLs and HTML remain sanitized')
  for (const href of ['javascript:alert(1)', 'C:relative.png', pathToFileURL(program).href + ':payload']) {
    await assert.rejects(win.evaluate((href) => window.jolty.app.openLocal(href), href), /Cale locală invalidă/)
  }
  console.log('PASS main process rejects schemes, relative drive paths and alternate streams')
  await win.getByRole('link', { name: 'JPG', exact: true }).click({ button: 'right' })
  await win.getByRole('menuitem', { name: 'Copiază calea', exact: true }).waitFor()
  await app.evaluate(() => { globalThis.linkTestCalls = [] })
  await win.getByRole('menuitem', { name: 'Copiază calea', exact: true }).click()
  await win.waitForTimeout(100)
  assert.deepEqual(await app.evaluate(() => globalThis.linkTestCalls), [['copy', imageHref]])
  console.log('PASS right-click copies a usable Windows path')
  await win.getByRole('link', { name: 'JPG', exact: true }).click({ button: 'right' })
  await win.getByRole('menuitem', { name: 'Arată în Explorer', exact: true }).waitFor()
  await app.evaluate(() => { globalThis.linkTestCalls = [] })
  await win.getByRole('menuitem', { name: 'Arată în Explorer', exact: true }).click()
  await win.waitForTimeout(100)
  assert.deepEqual(await app.evaluate(() => globalThis.linkTestCalls), [['reveal', image]])
  console.log('PASS right-click reveal')
  await app.evaluate(() => { globalThis.linkTestOpenError = 'Test file association error' })
  await win.getByRole('link', { name: 'PDF', exact: true }).click({ button: 'right' })
  await win.getByRole('menuitem', { name: 'Deschide', exact: true }).click()
  await win.locator('.toast.error').filter({ hasText: 'Test file association error' }).waitFor()
  await app.evaluate(() => { globalThis.linkTestOpenError = undefined })
  console.log('PASS right-click reports file association errors')
  const originalPage = win.url()
  assert.ok(originalPage.includes('/out/renderer/'), 'Chat remains in the app window')
  await win.screenshot({ path: path.join(data, 'links.png') })
  if (process.env.JOLTY_LINK_NATIVE_FILE) {
    const file = path.resolve(process.env.JOLTY_LINK_NATIVE_FILE)
    assert.ok(fs.existsSync(file))
    await app.evaluate(({ shell }) => {
      globalThis.linkTestCalls = []
      shell.openPath = async (file) => {
        const result = await globalThis.linkTestOriginalOpenPath(file)
        globalThis.linkTestCalls.push(['native', file, result])
        return result
      }
    })
    await win.getByRole('link', { name: 'Pliant real', exact: true }).click()
    await win.waitForTimeout(1500)
    assert.deepEqual(await app.evaluate(() => globalThis.linkTestCalls), [['native', file, '']])
    console.log('PASS native OS file association:', file)
  }
  console.log('ALL LINK TESTS PASSED')
  console.log('Isolated test data:', data)
} finally {
  await app.close()
}
