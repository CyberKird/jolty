// End to end: a real Chromium with the Jolty extension, driven through the same MCP endpoint a model uses.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { startHarness, type Harness } from './harness'

let h: Harness
test.before(async () => {
  h = await startHarness()
})
test.after(async () => {
  await h?.stop()
})

/** The ref of the first snapshot line matching the pattern. */
function ref(text: string, line: RegExp): string {
  const row = text.split('\n').find((l) => line.test(l))
  assert.ok(row, `no snapshot line matches ${line}\n${text.slice(0, 1500)}`)
  return /\[ref=(e\d+)\]/.exec(row!)![1]
}
const ok = (r: { isError: boolean; text: string }): string => {
  assert.equal(r.isError, false, r.text.slice(0, 800))
  return r.text
}
const evalIn = async (js: string, sid = 'chat1'): Promise<string> => ok(await h.call('browser_evaluate', { function: js }, sid)).split('### Result\n')[1].split('\n')[0]

test('MCP: initialize, tool list, notifications, auth', async () => {
  const init = (await (await h.rpc('p1', { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } })).json()) as { result: { protocolVersion: string; serverInfo: { name: string } } }
  assert.equal(init.result.serverInfo.name, 'jolty-browser')
  assert.equal(init.result.protocolVersion, '2025-06-18')
  const list = (await (await h.rpc('p1', { jsonrpc: '2.0', id: 2, method: 'tools/list' })).json()) as { result: { tools: { name: string; inputSchema: unknown }[] } }
  const names = list.result.tools.map((t) => t.name)
  for (const n of ['browser_navigate', 'browser_snapshot', 'browser_click', 'browser_type', 'browser_take_screenshot', 'browser_tabs', 'browser_use_current_tab']) assert.ok(names.includes(n), n)
  assert.equal((await h.rpc('p1', { jsonrpc: '2.0', method: 'notifications/initialized' })).status, 202)
  assert.equal((await h.rpc('p1', { jsonrpc: '2.0', id: 3, method: 'tools/list' }, 'wrong-token')).status, 401)
  const unknown = (await (await h.rpc('p1', { jsonrpc: '2.0', id: 4, method: 'nope' })).json()) as { error: { code: number } }
  assert.equal(unknown.error.code, -32601)
})

test('navigate gives a snapshot with roles, names and refs; unsafe URLs are refused', async () => {
  const t = ok(await h.call('browser_navigate', { url: h.site + '/' }))
  assert.match(t, /Page URL: http:\/\/127\.0\.0\.1:\d+\//)
  assert.match(t, /Page Title: Jolty test home/)
  assert.doesNotMatch(t, /⚡/)
  assert.match(t, /heading "Welcome" \[level=1\]/)
  assert.match(t, /link "Open the form"/)
  for (const bad of ['file:///C:/Windows/win.ini', 'javascript:alert(1)', 'chrome://settings', 'view-source:http://x']) {
    const r = await h.call('browser_navigate', { url: bad })
    assert.equal(r.isError, true, bad)
    assert.match(r.text, /Only http, https/)
  }
})

test('click works through real input events and the snapshot updates', async () => {
  const snap = ok(await h.call('browser_snapshot'))
  const r = ok(await h.call('browser_click', { ref: ref(snap, /button "Clicked 0"/) }))
  assert.match(r, /Clicked button "Clicked 0"/)
  assert.match(r, /button "Clicked 1"/)
})

test('clicking something far down scrolls it into view first', async () => {
  const snap = ok(await h.call('browser_snapshot'))
  ok(await h.call('browser_click', { ref: ref(snap, /button "Far button"/) }))
  assert.equal(await evalIn('() => document.title.replace("⚡ ","")'), '"far clicked"')
})

test('forms: type, fill_form, select, checkbox, password stays hidden, contenteditable', async () => {
  ok(await h.call('browser_navigate', { url: h.site + '/form' }))
  let snap = ok(await h.call('browser_snapshot'))
  const name = ref(snap, /textbox "Your name"/)
  const typed = ok(await h.call('browser_type', { ref: name, text: 'Ada Lovelace' }))
  assert.match(typed, /Typed "Ada Lovelace" into textbox "Your name"/)
  assert.match(typed, /textbox "Your name".*: "Ada Lovelace"/)
  // typing again replaces
  ok(await h.call('browser_type', { ref: name, text: 'Grace' }))
  assert.equal(await evalIn('() => document.getElementById("name").value'), '"Grace"')

  snap = ok(await h.call('browser_snapshot'))
  const filled = ok(
    await h.call('browser_fill_form', {
      fields: [
        { name: 'Email', type: 'textbox', ref: ref(snap, /textbox "Email/), value: 'ada@example.com' },
        { name: 'Password', type: 'textbox', ref: ref(snap, /textbox "Password"/), value: 's3cret!' },
        { name: 'Color', type: 'combobox', ref: ref(snap, /combobox "Color"/), value: 'Green' },
        { name: 'Agree', type: 'checkbox', ref: ref(snap, /checkbox "I agree"/), value: 'true' },
        { name: 'Large', type: 'radio', ref: ref(snap, /radio "Large"/), value: 'true' }
      ]
    })
  )
  assert.doesNotMatch(filled, /s3cret/)
  assert.match(filled, /Typed \[hidden\]/)
  assert.match(filled, /checkbox "I agree" \[checked\]/)
  assert.match(filled, /radio "Large" \[checked\]/)

  snap = ok(await h.call('browser_snapshot'))
  const notes = ref(snap, /textbox "Notes"/)
  ok(await h.call('browser_type', { ref: notes, text: 'line one\nline two' }))
  const rich = ref(snap, /textbox "Rich editor"/)
  ok(await h.call('browser_type', { ref: rich, text: 'rich text here' }))
  assert.equal(await evalIn('() => document.getElementById("rich").textContent'), '"rich text here"')

  const send = ref(snap, /button "Send"/)
  ok(await h.call('browser_click', { ref: send }))
  const out = JSON.parse(JSON.parse(await evalIn('() => document.getElementById("out").textContent')))
  assert.deepEqual(out, { name: 'Grace', email: 'ada@example.com', pw: 's3cret!', color: 'g', agree: 'on', size: 'l', notes: 'line one\nline two' })
})

test('select_option reports the options when nothing matches', async () => {
  const snap = ok(await h.call('browser_snapshot'))
  const r = await h.call('browser_select_option', { ref: ref(snap, /combobox "Color"/), values: ['Purple'] })
  assert.equal(r.isError, true)
  assert.match(r.text, /no option matches "Purple"/)
  assert.match(r.text, /"Red"/)
  const good = ok(await h.call('browser_select_option', { ref: ref(snap, /combobox "Color"/), values: ['Blue'] }))
  assert.match(good, /Selected "Blue"/)
})

test('press_key: chords and navigation keys', async () => {
  const snap = ok(await h.call('browser_snapshot'))
  const name = ref(snap, /textbox "Your name"/)
  ok(await h.call('browser_type', { ref: name, text: 'abc' }))
  ok(await h.call('browser_press_key', { key: 'Control+A' }))
  ok(await h.call('browser_press_key', { key: 'Backspace' }))
  assert.equal(await evalIn('() => document.getElementById("name").value'), '""')
  ok(await h.call('browser_press_key', { key: 'x' }))
  assert.equal(await evalIn('() => document.getElementById("name").value'), '"x"')
  const bad = await h.call('browser_press_key', { key: 'NoSuchKey' })
  assert.equal(bad.isError, true)
})

test('file upload: straight into an input and through a file chooser', async () => {
  const f = path.join(os.tmpdir(), 'jbrowser-upload.txt')
  fs.writeFileSync(f, 'hello')
  let snap = ok(await h.call('browser_snapshot'))
  const up = ref(snap, /filebutton "Upload"/)
  const r = ok(await h.call('browser_file_upload', { ref: up, paths: [f] }))
  assert.match(r, /Uploaded 1 file: jbrowser-upload\.txt/)
  assert.equal(await evalIn('() => document.getElementById("fileout").textContent'), '"jbrowser-upload.txt:5"')
  // chooser flow
  // a chooser with the same file as before would not fire change: reset the input
  ok(await h.call('browser_evaluate', { function: '() => { document.getElementById("fileout").textContent = ""; document.getElementById("file").value = ""; return 1 }' }))
  snap = ok(await h.call('browser_snapshot'))
  const click = ok(await h.call('browser_click', { ref: ref(snap, /filebutton "Upload"/) }))
  assert.match(click, /file chooser is open/)
  ok(await h.call('browser_file_upload', { paths: [f] }))
  assert.equal(await evalIn('() => document.getElementById("fileout").textContent'), '"jbrowser-upload.txt:5"')
  assert.equal((await h.call('browser_file_upload', { paths: [path.join(os.tmpdir(), 'nope-missing.txt')] })).isError, true)
  fs.rmSync(f)
})

test('a link that opens a new tab: the new tab is adopted, tabs can be listed, switched and closed', async () => {
  ok(await h.call('browser_navigate', { url: h.site + '/' }))
  const snap = ok(await h.call('browser_snapshot'))
  const r = ok(await h.call('browser_click', { ref: ref(snap, /link "New tab link"/) }))
  assert.match(r, /### New tab/)
  assert.match(r, /Page Title: Popup target/)
  assert.match(r, /### Open tabs/)
  const list = ok(await h.call('browser_tabs', { action: 'list' }))
  assert.match(list, /0: .*Jolty test home/)
  assert.match(list, /1: \(current\).*Popup target/)
  const back = ok(await h.call('browser_tabs', { action: 'select', index: 0 }))
  assert.match(back, /Page Title: Jolty test home/)
  ok(await h.call('browser_tabs', { action: 'select', index: 1 }))
  const closed = ok(await h.call('browser_tabs', { action: 'close' }))
  assert.match(closed, /Closed the tab/)
  assert.match(closed, /Jolty test home|Popup/)
})

test('dialogs block the page until answered', async () => {
  ok(await h.call('browser_navigate', { url: h.site + '/dialog' }))
  let snap = ok(await h.call('browser_snapshot'))
  const alertBtn = ref(snap, /button "Alert"/)
  const r = ok(await h.call('browser_click', { ref: alertBtn }))
  assert.match(r, /### Modal state/)
  assert.match(r, /alert dialog is open: "Hello from alert"/)
  const blocked = await h.call('browser_snapshot')
  assert.equal(blocked.isError, true)
  assert.match(blocked.text, /Answer it with browser_handle_dialog/)
  const handled = ok(await h.call('browser_handle_dialog', { accept: true }))
  assert.match(handled, /Accepted the alert dialog/)
  assert.match(handled, /after alert/)
  snap = ok(await h.call('browser_snapshot'))
  ok(await h.call('browser_click', { ref: ref(snap, /button "Prompt"/) }))
  const p = ok(await h.call('browser_handle_dialog', { accept: true, promptText: 'Jolty' }))
  assert.match(p, /prompt:Jolty/)
  ok(await h.call('browser_click', { ref: ref(snap, /button "Confirm"/) }))
  const c = ok(await h.call('browser_handle_dialog', { accept: false }))
  assert.match(c, /Page Title: no/)
})

test('shadow DOM and same-origin iframes are readable and clickable', async () => {
  const snap = ok(await h.call('browser_navigate', { url: h.site + '/shadow' }))
  assert.match(snap, /button "Shadow button"/)
  assert.match(snap, /textbox "Shadow input"/)
  assert.match(snap, /iframe/)
  assert.match(snap, /button "Inside frame"/)
  ok(await h.call('browser_click', { ref: ref(snap, /button "Shadow button"/) }))
  assert.equal(await evalIn('() => document.title.replace("⚡ ","")'), '"shadow click"')
  ok(await h.call('browser_click', { ref: ref(snap, /button "Inside frame"/) }))
  assert.equal(await evalIn('() => document.title.replace("⚡ ","")'), '"iframe click"')
})

test('drag and drop (HTML5)', async () => {
  const snap = ok(await h.call('browser_navigate', { url: h.site + '/dnd' }))
  ok(await h.call('browser_drag', { startRef: ref(snap, /button "Drag me"/), endRef: ref(snap, /region "Drop zone"/) }))
  assert.equal(await evalIn('() => document.title.replace("⚡ ","")'), '"dropped payload"')
})

test('an element covered by something else is reported, then works once uncovered', async () => {
  const snap = ok(await h.call('browser_navigate', { url: h.site + '/covered' }))
  const r = await h.call('browser_click', { ref: ref(snap, /button "Under cover"/) })
  assert.equal(r.isError, true)
  assert.match(r.text, /Another element covers it/)
  ok(await h.call('browser_click', { ref: ref(snap, /button "Close cover"/) }))
  ok(await h.call('browser_click', { ref: ref(snap, /button "Under cover"/) }))
  assert.equal(await evalIn('() => document.title.replace("⚡ ","")'), '"clicked"')
})

test('screenshots: viewport, full page and element come back as images', async () => {
  const snap = ok(await h.call('browser_navigate', { url: h.site + '/' }))
  const a = await h.call('browser_take_screenshot')
  assert.equal(a.images, 1)
  const b = await h.call('browser_take_screenshot', { fullPage: true, type: 'png' })
  assert.equal(b.images, 1)
  const c = await h.call('browser_take_screenshot', { ref: ref(snap, /heading "Welcome"/) })
  assert.equal(c.images, 1)
})

test('console, network, wait_for, find, evaluate, back, scroll', async () => {
  ok(await h.call('browser_navigate', { url: h.site + '/' }))
  const con = ok(await h.call('browser_console_messages', { level: 'error' }))
  assert.match(con, /\[ERROR\] a test error/)
  const all = ok(await h.call('browser_console_messages', { level: 'info' }))
  assert.match(all, /home loaded/)
  const net = ok(await h.call('browser_network_requests'))
  assert.match(net, /\[GET\] http:\/\/127\.0\.0\.1:\d+\/ => 200/)
  const detail = ok(await h.call('browser_network_request', { index: 0 }))
  assert.match(detail, /Jolty test home/)

  const found = ok(await h.call('browser_find', { query: 'new tab' }))
  assert.match(found, /link "New tab link"/)
  assert.equal(await evalIn('() => 6 * 7'), '42')
  const bad = await h.call('browser_evaluate', { function: '() => { throw new Error("boom") }' })
  assert.equal(bad.isError, true)
  assert.match(bad.text, /boom/)

  const slow = ok(await h.call('browser_navigate', { url: h.site + '/slow' }))
  assert.match(slow, /Loading|Slow content ready/)
  const waited = ok(await h.call('browser_wait_for', { text: 'Slow content ready' }))
  assert.match(waited, /Found "Slow content ready"/)
  ok(await h.call('browser_navigate', { url: h.site + '/' }))
  const back = ok(await h.call('browser_navigate_back'))
  assert.match(back, /Page Title: Slow/)
  ok(await h.call('browser_navigate', { url: h.site + '/' }))
  const down = ok(await h.call('browser_scroll', { direction: 'down' }))
  assert.match(down, /Scroll: [1-9]\d*px/)
  const bottom = ok(await h.call('browser_scroll', { direction: 'bottom' }))
  assert.match(bottom, /Scroll: 1\d{3}px/)
})

test('two chats work side by side, each with its own tab', async () => {
  ok(await h.call('browser_navigate', { url: h.site + '/form' }, 'chatA'))
  ok(await h.call('browser_navigate', { url: h.site + '/slow' }, 'chatB'))
  const a = ok(await h.call('browser_snapshot', {}, 'chatA'))
  const b = ok(await h.call('browser_snapshot', {}, 'chatB'))
  assert.match(a, /Form page/)
  assert.match(b, /Slow/)
  assert.doesNotMatch(a, /Open tabs/)
  const none = await h.call('browser_snapshot', {}, 'chatC')
  assert.equal(none.isError, true)
  assert.match(none.text, /No tab is open/)
  await h.svc.release('chatA')
  await h.svc.release('chatB')
})

test('the model cannot see the user tabs, only take the current one on request', async () => {
  const list = ok(await h.call('browser_tabs', { action: 'list' }, 'fresh'))
  assert.match(list, /No tabs are open/)
})
