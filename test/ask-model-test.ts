import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import type { Profile } from '../src/shared/types'
import { accepts, fileKind, fileKindsOf, formatAskable, parseAskInput, readAskFiles } from '../src/main/ask-model'
import { bindJoltyTools, handleJoltyTools, JOLTY_READ_TOOLS, JOLTY_TOOLS_PROMPT, type ToolHost } from '../src/main/jolty-tools'
import type { GeminiBrowser, GeminiPage } from '../src/main/engines/gemini-web'
import { GeminiWebDriver } from '../src/main/engines/gemini-web'
import { geminiOnce } from '../src/main/engines/gemini-once'
import { ACCOUNT_SCRIPT, ATTACHED_SCRIPT, CLOSE_MENU_SCRIPT, MENU_SCRIPT, PAGE_LIB, SEND_SCRIPT, UPLOAD_SCRIPT, pickScript } from '../src/main/engines/gemini-page'

const abs = (...p: string[]): string => path.resolve(os.tmpdir(), ...p)

test('ask_model input: profile and question are needed, files must be absolute, at most 8, duplicates dropped', () => {
  const ok = parseAskInput({ profile: ' codex-main ', question: ' why? ', model: ' gpt-5.5 ', files: [abs('a.png'), abs('a.png'), abs('b.txt')] })
  assert.deepEqual(ok, { profile: 'codex-main', question: 'why?', model: 'gpt-5.5', files: [abs('a.png'), abs('b.txt')] })
  assert.deepEqual(parseAskInput({ profile: 'x', question: 'q' }), { profile: 'x', question: 'q', model: undefined, files: [] })
  assert.equal(parseAskInput({ profile: 'x', question: 'q', model: '', files: null }).model, undefined)
  assert.throws(() => parseAskInput({ question: 'q' }), /profile is needed/)
  assert.throws(() => parseAskInput({ profile: 5, question: 'q' }), /profile is needed/)
  assert.throws(() => parseAskInput({ profile: 'x', question: '  ' }), /question is empty/)
  assert.throws(() => parseAskInput({ profile: 'x', question: 'q'.repeat(200_001) }), /too long/)
  assert.throws(() => parseAskInput({ profile: 'x', question: 'q', model: 3 }), /model must be a text/)
  assert.throws(() => parseAskInput({ profile: 'x', question: 'q', files: 'a.png' }), /list of absolute paths/)
  assert.throws(() => parseAskInput({ profile: 'x', question: 'q', files: ['relative/a.png'] }), /absolute paths/)
  assert.throws(() => parseAskInput({ profile: 'x', question: 'q', files: [7] }), /absolute paths/)
  assert.throws(() => parseAskInput({ profile: 'x', question: 'q', files: Array.from({ length: 9 }, (_, i) => abs(`f${i}.txt`)) }), /at most 8/)
})

const P = (engine: Profile['engine'], extra: Partial<Profile> = {}): Profile => ({ id: engine, name: engine, engine, auth: 'subscription', isDefaultDir: true, color: '#fff', ...extra })

test('which profile takes which file: PDF only Claude with a subscription and Gemini, audio and video only Gemini', () => {
  assert.equal(fileKind('C:\\x\\Clip.MP4').kind, 'video')
  assert.equal(fileKind('/x/a.pdf').mime, 'application/pdf')
  assert.equal(fileKind('/x/notes.md').kind, 'text')
  assert.deepEqual(fileKindsOf(P('claude')), ['image', 'pdf'])
  assert.deepEqual(fileKindsOf(P('codex')), ['image'])
  assert.deepEqual(fileKindsOf(P('opencode')), [])
  assert.deepEqual(fileKindsOf(P('gemini', { auth: 'existing' })), ['image', 'pdf', 'audio', 'video'])
  assert.deepEqual(fileKindsOf(P('claude', { auth: 'endpoint' })), [], 'an endpoint model reads images only when the profile says so')
  assert.deepEqual(fileKindsOf(P('claude', { auth: 'endpoint', vision: true })), ['image'])
  assert.equal(accepts(P('claude'), { vision: false }, 'image'), false, 'a model that cannot see')
  assert.equal(accepts(P('opencode'), undefined, 'text'), true)
})

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ask-model-test-'))
}

test('files: text goes into the question, images and PDF as bytes, audio and video as a path; secrets, big and unknown binaries are refused', () => {
  const dir = tmpDir()
  try {
    const txt = path.join(dir, 'notes.txt')
    const png = path.join(dir, 'a.png')
    const mp3 = path.join(dir, 'voice.mp3')
    fs.writeFileSync(txt, 'hello <world>')
    fs.writeFileSync(png, Buffer.from([1, 2, 3]))
    fs.writeFileSync(mp3, Buffer.from([4, 5]))
    const all = readAskFiles([txt, png, mp3], () => true, 'Gemini')
    assert.equal(all.inlined, '\n\n<file name="notes.txt">\nhello <world>\n</file>')
    assert.deepEqual(all.attachments.map((a) => [a.name, a.mime, a.data, a.path === undefined]), [['a.png', 'image/png', 'AQID', true], ['voice.mp3', 'audio/mpeg', undefined, false]])
    assert.throws(() => readAskFiles([mp3], (k) => k !== 'audio', 'Codex'), /Codex cannot take audio files/)
    const env = path.join(dir, '.env')
    fs.writeFileSync(env, 'KEY=1')
    assert.throws(() => readAskFiles([env], () => true, 'x'), /secrets/)
    const bin = path.join(dir, 'data.bin')
    fs.writeFileSync(bin, Buffer.from([65, 0, 66]))
    assert.throws(() => readAskFiles([bin], () => true, 'x'), /binary file/)
    assert.throws(() => readAskFiles([path.join(dir, 'missing.txt')], () => true, 'x'), /not a readable file/)
    assert.throws(() => readAskFiles([dir], () => true, 'x'), /not a readable file/)
    fs.writeFileSync(txt, 'x'.repeat(101 * 1024))
    assert.throws(() => readAskFiles([txt], () => true, 'x'), /limit for text files/)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('the model list names the profile id, the scores, the default model and the files each profile takes', () => {
  const text = formatAskable([
    { id: 'claude-main', name: 'Claude', engine: 'claude', files: ['image', 'pdf'], models: [{ id: 'opus', label: 'Opus 5.5', isDefault: true, iq: 54, tps: 74, speed: 'mediu' }, { id: 'glm', label: 'glm', vision: false }] },
    { id: 'g', name: 'Gemini', engine: 'gemini', files: ['image', 'pdf', 'audio', 'video'], models: [] },
    { id: 'oc', name: 'OpenCode', engine: 'opencode', files: [], models: [{ id: 'big', label: 'big' }] }
  ])
  assert.match(text, /Claude \(profile id: claude-main, claude\) takes files: image, pdf/)
  assert.match(text, /opus \(Opus 5\.5\): intelligence 54, speed 74 tokens\/s \(mediu\), default/)
  assert.match(text, /glm: no images/)
  assert.match(text, /Gemini \(profile id: g, gemini\) takes files: image, pdf, audio, video\n.*leave model out/)
  assert.match(text, /OpenCode .* takes files: text only/)
  assert.match(formatAskable([]), /No profile can answer/)
})

function host(over: Partial<ToolHost> = {}): ToolHost {
  return { askable: async () => [], ask: async () => ({ who: 'X', answer: 'ok' }), meta: () => undefined, ...over } as unknown as ToolHost
}
const call = async (name: string, args: object): Promise<{ text: string; isError?: boolean }> => {
  const r = (await handleJoltyTools('s1', { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } })) as { result: { content: { text: string }[]; isError?: boolean } }
  return { text: r.result.content[0].text, isError: r.result.isError }
}

test('both tools are offered; looking is free, asking is not; a bad question never reaches the host', async () => {
  const asked: unknown[] = []
  bindJoltyTools(host({ ask: async (i) => (asked.push(i), { who: 'Codex (gpt)', answer: 'forty-two' }) }))
  const list = (await handleJoltyTools('s1', { jsonrpc: '2.0', id: 1, method: 'tools/list' })) as { result: { tools: { name: string; inputSchema: { required?: string[] } }[] } }
  const names = list.result.tools.map((t) => t.name)
  assert.ok(names.includes('list_models') && names.includes('ask_model'))
  assert.deepEqual(list.result.tools.find((t) => t.name === 'ask_model')!.inputSchema.required, ['profile', 'question'])
  assert.ok(JOLTY_READ_TOOLS.includes('list_models'))
  assert.ok(!JOLTY_READ_TOOLS.includes('ask_model'), 'ask_model sends data to another account: it is asked about like any action')
  assert.match(JOLTY_TOOLS_PROMPT, /list_models.*ask_model/)

  assert.match((await call('list_models', {})).text, /No profile can answer/)
  const bad = await call('ask_model', { profile: 'codex', question: '' })
  assert.equal(bad.isError, true)
  assert.match(bad.text, /question is empty/)
  assert.deepEqual(asked, [])
  const good = await call('ask_model', { profile: 'codex', question: 'meaning?', files: [] })
  assert.equal(good.isError, undefined)
  assert.equal(good.text, 'Answer from Codex (gpt):\n\nforty-two')
  assert.deepEqual(asked, [{ profile: 'codex', question: 'meaning?', model: undefined, files: [] }])

  bindJoltyTools(host({ ask: async () => { throw new Error('Codex has no model "zzz".') } }))
  const failed = await call('ask_model', { profile: 'codex', question: 'q', model: 'zzz' })
  assert.equal(failed.isError, true)
  assert.match(failed.text, /no model "zzz"/)
})

// ---- Gemini, one question ----

const MENU = {
  ok: true,
  models: [
    { id: 'bard-mode-option-b', title: '3.6 Flash', note: '', locked: false, selected: true },
    { id: 'bard-mode-option-c', title: '3.1 Pro', note: '', locked: false, selected: false },
    { id: 'bard-mode-option-upsell_X', title: '4 Argon', note: '', locked: true, selected: false }
  ]
}

/** A Gemini page that answers the page scripts; `states` are what the page shows on each look after the question was sent. */
function fakeOnce(opts: { states: object[]; account?: object }): { page: GeminiPage; calls: string[]; opened: string[]; browser: GeminiBrowser; disposed: () => boolean } {
  const calls: string[] = []
  const opened: string[] = []
  let sent = false
  let uploaded = 0
  let at = 0
  let disposed = false
  const page: GeminiPage = {
    async eval<T>(script: string): Promise<T> {
      if (script === PAGE_LIB) return true as T
      if (script === ACCOUNT_SCRIPT) return (opts.account ?? { composer: true, signIn: false, email: '' }) as T
      if (script === MENU_SCRIPT) return MENU as T
      if (script === CLOSE_MENU_SCRIPT) return true as T
      if (script === ATTACHED_SCRIPT) return { count: uploaded, loading: 0 } as T
      if (script === SEND_SCRIPT) {
        calls.push('send')
        sent = true
        return { ok: true } as T
      }
      if (script === 'window.__joltyGemini.state()') return (sent ? opts.states[Math.min(at++, opts.states.length - 1)] : { responses: 1, busy: false, stop: false, markdown: '' }) as T
      if (script === pickScript('model', 'bard-mode-option-c')) {
        calls.push('pick:3.1 Pro')
        return true as T
      }
      if (script.includes('const t =')) {
        calls.push('type:' + JSON.parse(/const t = (.*)/.exec(script)![1]))
        return { ok: true } as T
      }
      return true as T
    },
    async upload(trigger, files) {
      assert.equal(trigger, UPLOAD_SCRIPT)
      uploaded = files.length
      calls.push('upload:' + files.map((f) => path.basename(f)).join(','))
    },
    async dispose() {
      disposed = true
    }
  }
  return { page, calls, opened, browser: { open: async (key) => (opened.push(key), page), connected: () => true }, disposed: () => disposed }
}

const FAST = { poll: 5, settle: 20, start: 200, cap: 1000, menu: 1 }
const st = (markdown: string, busy: boolean) => ({ responses: 2, busy, stop: busy, markdown, composer: true, url: '' })

test('one question to Gemini: model chosen, files uploaded, question typed, the finished answer returned, the tab closed', async () => {
  const f = fakeOnce({ states: [{ responses: 1, busy: false, stop: false, markdown: '' }, st('Par', true), st('Partial **answer**', true), st('Partial **answer**', false)] })
  const answer = await geminiOnce(f.browser, 'line one\nline two', [{ id: '1', name: 'red.png', mime: 'image/png', data: Buffer.from('x').toString('base64') }, { id: '2', name: 'v.mp4', mime: 'video/mp4', path: abs('v.mp4') }], '3.1 pro', FAST)
  assert.equal(answer, 'Partial **answer**')
  assert.deepEqual(f.calls, ['pick:3.1 Pro', 'upload:file-1.png,v.mp4', 'type:line one\nline two', 'send'])
  assert.equal(f.opened.length, 1)
  assert.match(f.opened[0], /^gemini-once-/)
  assert.equal(f.disposed(), true)
})

test('Gemini: an unknown model, a locked one, a sign-in page and a page that never answers all end in an error and still close the tab', async () => {
  const wrong = fakeOnce({ states: [] })
  await assert.rejects(geminiOnce(wrong.browser, 'q', [], '4 Argon', FAST), /no model "4 Argon" on this account; it has 3\.6 Flash, 3\.1 Pro/)
  assert.equal(wrong.disposed(), true)
  assert.deepEqual(wrong.calls, [], 'nothing was typed')

  const out = fakeOnce({ states: [], account: { composer: false, signIn: true, email: '' } })
  await assert.rejects(geminiOnce(out.browser, 'q', [], undefined, FAST), /Google/)
  assert.equal(out.disposed(), true)

  const silent = fakeOnce({ states: [{ responses: 1, busy: false, stop: false, markdown: '' }] })
  await assert.rejects(geminiOnce(silent.browser, 'q', [], undefined, FAST), /did not start answering/)
  assert.equal(silent.disposed(), true)
})

test('the Gemini driver answers describe() through the same path, with the files it was given', async () => {
  const f = fakeOnce({ states: [st('Hello', false)] })
  const driver = new GeminiWebDriver(f.browser)
  const profile: Profile = { id: 'g', name: 'Gemini', engine: 'gemini', auth: 'existing', isDefaultDir: true, color: '#fff' }
  assert.equal(await driver.describe(profile, [], 'hi'), 'Hello')
  assert.deepEqual(f.calls, ['type:hi', 'send'])
  assert.equal(f.disposed(), true)
})
