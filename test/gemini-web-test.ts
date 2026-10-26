import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { ChatEvent, Profile, SessionMeta, TurnUsage } from '../src/shared/types'
import { effortIds, GeminiWebSession, parseMenu, type GeminiBrowser, type GeminiPage } from '../src/main/engines/gemini-web'
import { ACCOUNT_SCRIPT, ATTACHED_SCRIPT, MENU_SCRIPT, PAGE_LIB, SEND_SCRIPT, STOP_SCRIPT, pickScript } from '../src/main/engines/gemini-page'

const MENU = {
  ok: true,
  models: [
    { id: 'bard-mode-option-a', title: '3.5 Flash-Lite', note: 'Fastest', locked: false, selected: false },
    { id: 'bard-mode-option-b', title: '3.6 Flash', note: 'All round', locked: false, selected: true },
    { id: 'bard-mode-option-c', title: '3.1 Pro', note: 'Reasoning', locked: false, selected: false },
    { id: 'bard-mode-option-upsell_X', title: '4 Argon', note: 'Complex', locked: true, selected: false }
  ],
  levels: [
    { title: 'Minimum', note: '', selected: true },
    { title: 'Medium', note: '', selected: false },
    { title: 'Maximum', note: '', selected: false }
  ]
}

test('the model menu becomes the picker list: locked rows out, the checked one is the default, levels by position', () => {
  const list = parseMenu(MENU)
  assert.deepEqual(list.map((m) => m.id), ['3.5 Flash-Lite', '3.6 Flash', '3.1 Pro'])
  assert.deepEqual(list.filter((m) => m.isDefault).map((m) => m.id), ['3.6 Flash'])
  assert.deepEqual(list[0].efforts, ['low', 'medium', 'high'])
  assert.equal(list[0].defaultEffort, 'low')
  assert.deepEqual(parseMenu({ ok: false }), [])
  assert.deepEqual(effortIds(1), [])
  assert.deepEqual(effortIds(2), ['low', 'high'])
})

const meta = (over: Partial<SessionMeta> = {}): SessionMeta => ({ id: 's1', profileId: 'p1', engine: 'gemini', cwd: '/', title: 't', permissionMode: 'ask', createdAt: 0, updatedAt: 0, ...over })
const profile: Profile = { id: 'p1', name: 'Gemini', engine: 'gemini', auth: 'existing', isDefaultDir: true, color: '#fff' }

/** A gemini.google.com that answers the page scripts the way the real one did when they were written. */
function fakePage(opts: { states: object[]; account?: object; auto?: boolean }): { page: GeminiPage; calls: string[]; disposed: () => boolean } {
  const calls: string[] = []
  let at = 0
  let responses = 1
  let disposed = false
  const page: GeminiPage = {
    async eval<T>(script: string): Promise<T> {
      if (script === PAGE_LIB) return true as T
      if (script === ACCOUNT_SCRIPT) return (opts.account ?? { composer: true, signIn: false, email: 'me@example.com' }) as T
      if (script === MENU_SCRIPT) return MENU as T
      if (script === SEND_SCRIPT) {
        responses++
        return { ok: true } as T
      }
      if (script === ATTACHED_SCRIPT) return { count: 1, loading: 0 } as T
      if (script === STOP_SCRIPT) {
        calls.push('stop')
        return true as T
      }
      if (script === 'window.__joltyGemini.state()') return (opts.auto ? { responses, busy: false, stop: false, markdown: 'ok', composer: true, url: 'https://gemini.google.com/app' } : opts.states[Math.min(at++, opts.states.length - 1)]) as T
      if (script.includes('rich-textarea .ql-editor') && script.includes('const t =')) {
        calls.push('type:' + /const t = (.*)/.exec(script)![1])
        return { ok: true } as T
      }
      for (const [kind, key] of [['model', 'bard-mode-option-c'], ['level', 2]] as const) if (script === pickScript(kind, key)) {
        calls.push(`pick:${kind}:${key}`)
        return true as T
      }
      return true as T
    },
    async upload() {
      calls.push('upload')
    },
    async dispose() {
      disposed = true
    }
  }
  return { page, calls, disposed: () => disposed }
}

function run(opts: Parameters<typeof fakePage>[0], m: SessionMeta = meta()) {
  const fake = fakePage(opts)
  const events: ChatEvent[] = []
  const usage: TurnUsage[] = []
  const browser: GeminiBrowser = { open: async () => fake.page, connected: () => true }
  const session = new GeminiWebSession(m, profile, { emit: (e) => events.push(e), recordUsage: (u) => usage.push(u), recordLimits: () => undefined }, browser)
  return { session, events, usage, fake }
}

const st = (responses: number, markdown: string, busy: boolean, url = 'https://gemini.google.com/app') => ({ responses, busy, stop: busy, markdown, composer: true, url })

test('an answer is shown as it grows, ends as one item, and the chat address is kept for next time', async () => {
  const { session, events, usage } = run({
    states: [st(1, '', false), st(2, 'Hel', true), st(2, 'Hello wor', true), st(2, 'Hello world', false, 'https://gemini.google.com/app/77f449cd2727dd08')]
  })
  await session.send('Say hello')
  const deltas = events.filter((e): e is Extract<ChatEvent, { type: 'delta' }> => e.type === 'delta').map((e) => e.delta)
  assert.deepEqual(deltas, ['Hel', 'lo wor', 'ld'])
  const item = events.find((e) => e.type === 'item')
  assert.ok(item && item.type === 'item' && item.item.kind === 'assistant' && item.item.text === 'Hello world')
  assert.deepEqual(events.filter((e) => e.type === 'status').map((e) => (e as { status: string }).status), ['running', 'idle'])
  assert.equal(session.meta.engineSessionId, 'https://gemini.google.com/app/77f449cd2727dd08')
  assert.equal(usage.length, 1)
  assert.equal(usage[0].engine, 'gemini')
})

test('the message is typed with its line breaks, and the chosen model and thinking level are put on the page first', async () => {
  const { session, fake } = run({ states: [], auto: true }, meta({ model: '3.1 Pro', effort: 'high' }))
  await session.send('line one\nline two')
  assert.deepEqual(fake.calls.slice(0, 3), ['pick:model:bard-mode-option-c', 'pick:level:2', 'type:' + JSON.stringify('line one\nline two')])
  await session.send('again')
  assert.equal(fake.calls.filter((c) => c.startsWith('pick:')).length, 2, 'a second message does not touch the menu again')
})

test('files go in before the message', async () => {
  const { session, fake } = run({ states: [], auto: true })
  await session.send('what is this', [{ id: 'a', name: 'red.png', mime: 'image/png', data: Buffer.from('x').toString('base64') }])
  assert.equal(fake.calls[0], 'upload')
})

test('a Google sign-in page instead of the chat says so, and the chat ends with an error, not a hang', async () => {
  const { session, events } = run({ states: [st(1, '', false)], account: { composer: false, signIn: true, email: '' } })
  await assert.rejects(session.send('hi'), /Google/)
  const last = events.filter((e) => e.type === 'status').pop()
  assert.ok(last && last.type === 'status' && last.status === 'error')
})

test('Stop presses the stop button of the page and ends the turn quietly', async () => {
  const { session, events, fake } = run({ states: [st(1, '', false), st(2, 'long answer', true)] })
  const sending = session.send('write a lot')
  await new Promise((r) => setTimeout(r, 700))
  await session.interrupt()
  await sending
  assert.ok(fake.calls.includes('stop'))
  assert.equal(events.filter((e) => e.type === 'status' && e.status === 'error').length, 0)
})

test('closing the chat closes its tab', async () => {
  const { session, fake } = run({ states: [st(1, '', false), st(2, 'x', false)] })
  await session.send('hi')
  await session.close()
  assert.equal(fake.disposed(), true)
})
