// Taking things out of the chat: the copy buttons put the exact text on the clipboard, nothing moves when the
// controls appear, and the keyboard reaches them. Run once and short: it opens one window.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { _electron as electron } from 'playwright-core'

const shots = path.resolve('shots-chat')
fs.mkdirSync(shots, { recursive: true })
const data = fs.mkdtempSync(path.join(os.tmpdir(), 'jolty-chattools-'))
const TS = 'export function add(a: number, b: number) {\n  return a + b\n}'
const LONG = Array.from({ length: 40 }, (_, i) => `const v${i} = ${i}`).join('\n')
const OUT = Array.from({ length: 40 }, (_, i) => `line ${i + 1}`).join('\n')
const REPLY = [
  'Open `package.json` and keep the word `config` as it is. Then run `npm run build` on port `:3000`.',
  '',
  '```bash',
  '$ npm install',
  'added 12 packages',
  '$ npm test',
  '```',
  '',
  '```ts',
  TS,
  '```',
  '',
  '| Name | Note |',
  '| --- | --- |',
  '| a | one, two |',
  '| b | **bold** |',
  '',
  '```ts',
  LONG,
  '```'
].join('\n')
const items = [
  { kind: 'user', id: 'u1', text: 'Please build it' },
  { kind: 'assistant', id: 'a1', text: REPLY },
  { kind: 'tool', id: 't1', name: 'Bash', title: '$ npm test', status: 'done', input: { command: 'npm test' }, output: OUT },
  { kind: 'tool', id: 't2', name: 'Bash', title: '$ npm run nope', status: 'error', input: { command: 'npm run nope' }, output: 'missing script: nope' },
  { kind: 'tool', id: 't3', name: 'Edit', title: 'Edit a.ts', status: 'done', input: { file_path: 'E:\\x\\a.ts', old_string: 'old', new_string: 'new' }, diffs: [{ path: 'E:\\x\\a.ts', kind: 'update', diff: '@@ -1 +1 @@\n-old\n+new' }] },
  { kind: 'assistant', id: 'a2', text: 'Done.\n\n```sh\nnpm run dist\n```' }
]
fs.writeFileSync(path.join(data, 'profiles.json'), JSON.stringify([{ id: 'p1', name: 'Tools', engine: 'claude', auth: 'subscription', color: '#d97757' }]))
fs.writeFileSync(path.join(data, 'sessions.json'), JSON.stringify([{ id: 's1', profileId: 'p1', engine: 'claude', cwd: data, title: 'Tools', permissionMode: 'ask', createdAt: 1, updatedAt: 1 }]))
fs.writeFileSync(path.join(data, 'settings.json'), JSON.stringify({ language: 'en', lastCwd: data }))
fs.mkdirSync(path.join(data, 'transcripts'))
fs.writeFileSync(path.join(data, 'transcripts', 's1.json'), JSON.stringify(items))

const env = { ...process.env, JOLTY_TEST: '1', JOLTY_DATA_DIR: data }
delete env.ELECTRON_RUN_AS_NODE
const app = await electron.launch({ args: [path.resolve('out/main/index.js'), '--user-data-dir=' + path.join(data, 'electron')], env, timeout: 60000 })
const pause = (ms) => new Promise((r) => setTimeout(r, ms))
try {
  const win = await app.firstWindow()
  win.setDefaultTimeout(30000)
  await win.waitForSelector('.brand-name', { timeout: 60000 })
  await win.keyboard.press('Escape')
  await win.locator('.session-item').first().click()
  await win.waitForSelector('.msg-assistant .md')
  await pause(800)
  const clip = () => app.evaluate(({ clipboard }) => clipboard.readText())
  const clear = () => app.evaluate(({ clipboard }) => clipboard.writeText(''))
  const box = (sel) => win.locator(sel).first().boundingBox()
  const reply = win.locator('.msg-assistant').first()
  // the chat follows its bottom on every resize, so a target is centred right before it is used
  const reveal = async (loc) => {
    const m = await win.locator('.messages').boundingBox()
    await win.mouse.move(m.x + m.width / 2, m.y + m.height / 2)
    await win.mouse.wheel(0, -60) // a reader's wheel lets the chat stop following its bottom
    await pause(300)
    await loc.evaluate((el) => el.scrollIntoView({ block: 'center' }))
    await pause(150)
  }

  // code blocks: header, language, copy of exactly the code, commands without the prompt
  assert.equal(await reply.locator('.cb').count(), 3, 'three code blocks')
  assert.equal(await reply.locator('.cb-lang').first().getAttribute('data-t'), 'bash')
  await clear()
  await reply.locator('.cb').nth(0).locator('[data-act="cmd"]').click()
  assert.equal(await clip(), 'npm install\nnpm test', 'shell block copies the commands only')
  await reply.locator('.cb').nth(0).locator('[data-act="code"]').click()
  assert.equal(await clip(), '$ npm install\nadded 12 packages\n$ npm test', 'the second button copies the whole block')
  const tsCopy = reply.locator('.cb').nth(1).locator('[data-act="code"]')
  const before = await tsCopy.boundingBox()
  await tsCopy.click()
  assert.equal(await clip(), TS, 'code copied exactly')
  assert.equal(await tsCopy.getAttribute('data-copied'), '', 'tick shown')
  await reply.locator('.cb').nth(1).screenshot({ path: path.join(shots, 'code-block.png') })
  const during = await tsCopy.boundingBox()
  assert.deepEqual([during.width, during.height], [before.width, before.height], 'the tick does not resize the button')
  await pause(1500)
  assert.equal(await tsCopy.getAttribute('data-copied'), null, 'tick gone after 1.2 s')
  assert.match(await win.locator('#copy-live').innerText(), /\S/, 'copy announced in the live region')

  // wrap toggle and long block fold
  const wrap = reply.locator('.cb').nth(1).locator('[data-act="wrap"]')
  await wrap.click()
  assert.equal(await wrap.getAttribute('aria-pressed'), 'true')
  const long = reply.locator('.cb').nth(2)
  assert.equal(await long.getAttribute('data-long'), '', 'long block is folded')
  assert.ok((await long.locator('pre').boundingBox()).height <= 521, 'folded height')
  await long.locator('[data-act="more"]').click()
  assert.ok((await long.locator('pre').boundingBox()).height > 700, 'opened shows everything')
  await long.locator('[data-act="code"]').click()
  assert.equal(await clip(), LONG, 'a folded block still copies in full')

  // keyboard: the copy button is reachable and works with Enter
  await reply.locator('.cb').nth(1).locator('[data-act="code"]').focus()
  await clear()
  await win.keyboard.press('Enter')
  assert.equal(await clip(), TS, 'Enter on a focused copy button copies')

  // chips: values yes, plain words no
  const chips = await reply.locator('code.cv').allInnerTexts()
  assert.deepEqual(chips, ['package.json', 'npm run build', ':3000'])
  const chip = reply.locator('code.cv').first()
  await reveal(chip)
  // a real click at the chip: Playwright's own scroll-into-view fights the chat's follow-the-bottom
  const at = await chip.boundingBox()
  await win.mouse.click(at.x + at.width / 2, at.y + at.height / 2)
  assert.equal(await clip(), 'package.json')
  await clear()
  await reply.locator('code.cv').nth(1).focus()
  await win.keyboard.press('Enter')
  assert.equal(await clip(), 'npm run build', 'a chip copies from the keyboard')
  await pause(1300) // the hint stays hidden while the tick of the last copy shows
  const at2 = await chip.boundingBox()
  await win.mouse.move(at2.x + at2.width / 2, at2.y + at2.height / 2)
  await pause(250)
  assert.equal(await chip.evaluate((el) => getComputedStyle(el, '::before').opacity), '1', 'hover hint')
  await win.screenshot({ path: path.join(shots, 'chip.png') })
  await win.mouse.click(at2.x + at2.width / 2, at2.y + at2.height / 2, { button: 'right' })
  const labels = await win.locator('.ctx-label').allInnerTexts()
  assert.ok(labels.length >= 4, `chip menu: ${labels.join(' | ')}`)
  await win.keyboard.press('Escape')

  // table: Markdown, TSV, CSV
  const tbl = reply.locator('.tbl')
  await reveal(tbl)
  await tbl.hover()
  await tbl.locator('[data-act="tsv"]').click()
  assert.equal(await clip(), 'Name\tNote\na\tone, two\nb\tbold')
  await tbl.locator('[data-act="csv"]').click()
  assert.equal(await clip(), 'Name,Note\na,"one, two"\nb,bold')
  await tbl.locator('[data-act="md"]').click()
  assert.equal(await clip(), '| Name | Note |\n| --- | --- |\n| a | one, two |\n| b | bold |')

  // message toolbar: appears on hover without moving anything
  const lastRow = win.locator('.msg-assistant').last()
  await reveal(lastRow)
  await win.mouse.move(2, 2)
  const rowBefore = await lastRow.boundingBox()
  const innerBefore = await box('.messages-inner')
  await win.mouse.move(rowBefore.x + 40, rowBefore.y + 10)
  await pause(250)
  const bar = lastRow.locator('.msgbar')
  assert.equal(await bar.evaluate((el) => getComputedStyle(el).opacity), '1', 'toolbar visible on hover')
  assert.deepEqual(await lastRow.boundingBox(), rowBefore, 'row did not move')
  assert.equal((await box('.messages-inner')).height, innerBefore.height, 'list did not change height')
  await win.screenshot({ path: path.join(shots, 'toolbar.png') })
  await bar.locator('.cp').nth(0).click()
  assert.ok((await clip()).startsWith('Done.'), 'plain copy of the message')
  await bar.locator('.cp').nth(1).click()
  assert.equal(await clip(), 'Done.\n\n```sh\nnpm run dist\n```', 'Copy as Markdown')
  await bar.locator('.cp').nth(2).click()
  assert.equal(await clip(), 'npm run dist', 'Copy last code block')

  // keyboard shortcuts
  await win.locator('.messages').click({ position: { x: 4, y: 4 } })
  await clear()
  await win.keyboard.press('Control+Shift+C')
  await pause(200)
  assert.equal(await clip(), 'Done.\n\n```sh\nnpm run dist\n```', 'Ctrl+Shift+C copies the last reply')
  await clear()
  await win.keyboard.press('Control+Alt+C')
  await pause(200)
  assert.equal(await clip(), 'npm run dist', 'Ctrl+Alt+C copies the last code block')

  // tool rows
  const tools = win.locator('.tool')
  const t1 = tools.nth(0)
  await reveal(t1)
  const toolBefore = await t1.boundingBox()
  await t1.hover()
  await pause(250)
  assert.deepEqual(await t1.boundingBox(), toolBefore, 'tool row did not move on hover')
  await t1.locator('.tool-acts .cp').nth(0).click()
  assert.equal(await clip(), 'npm test', 'Copy command')
  await t1.locator('.tool-acts .cp').nth(1).click()
  assert.equal(await clip(), OUT, 'Copy output in full')
  await t1.locator('.tool-head').click()
  assert.equal(await t1.locator('.fold-btn').count(), 1, 'long output folds')
  assert.equal((await t1.locator('.pre').innerText()).split('\n').length, 14)
  await win.screenshot({ path: path.join(shots, 'tool-row.png') })
  await t1.locator('.fold-btn').click()
  assert.equal((await t1.locator('.pre').innerText()).split('\n').length, 40, 'Show all')
  const t2 = tools.nth(1)
  await t2.locator('.tool-head').click()
  await t2.locator('.tool-bar .cp').click()
  assert.equal(await clip(), 'missing script: nope', 'Copy error')
  const t3 = tools.nth(2)
  await t3.locator('.tool-head').click()
  await t3.locator('.tool-bar .cp').nth(0).click()
  assert.equal(await clip(), 'E:\\x\\a.ts\n@@ -1 +1 @@\n-old\n+new', 'Copy diff')
  await t3.locator('.tool-bar .cp').nth(1).click()
  assert.equal(await clip(), 'new', 'Copy new content')

  // the selection popup offers Markdown when the selection spans formatting
  await reveal(reply.locator('code.cv').first())
  await win.evaluate(() => {
    const md = document.querySelectorAll('.msg-assistant .md')[0]
    const r = document.createRange()
    r.setStartBefore(md.querySelector('code.cv'))
    r.setEndAfter(md.querySelectorAll('code.cv')[1])
    const s = getSelection()
    s.removeAllRanges()
    s.addRange(r)
    md.closest('.messages').dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
  })
  await pause(200)
  const popup = win.locator('.sel-popup button')
  assert.equal(await popup.count(), 3, 'Cite, Copy, Copy as Markdown')
  await popup.nth(2).click()
  assert.match(await clip(), /^`package\.json`.*`npm run build`$/s)

  console.log('PASS chat tools: code, chips, tables, toolbar, tool rows, selection and shortcuts copy exactly, nothing moves')
} finally {
  await app.close()
  fs.rmSync(data, { recursive: true, force: true })
}
