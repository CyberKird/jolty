import test from 'node:test'
import assert from 'node:assert/strict'

// The phone's line to the PC (remote/link.ts) with a fake socket: what the PC tells right after the line is up (the turns running, the
// questions waiting for a yes) arrives before the page has mounted and subscribed. A page that subscribes later must still learn it.

class FakeWs {
  static all: FakeWs[] = []
  static OPEN = 1
  static CONNECTING = 0
  readyState = 0
  binaryType = ''
  sent: string[] = []
  onopen?: () => void
  onmessage?: (ev: { data: unknown }) => void
  onclose?: (ev: { code: number; reason: string }) => void
  constructor() {
    FakeWs.all.push(this)
    queueMicrotask(() => {
      this.readyState = 1
      this.onopen?.()
    })
  }
  send(t: string): void {
    this.sent.push(t)
  }
  close(): void {
    this.readyState = 3
  }
  say(m: unknown): void {
    this.onmessage?.({ data: JSON.stringify(m) })
  }
}

const win = new EventTarget()
const g = globalThis as unknown as Record<string, unknown>
Object.assign(g, {
  WebSocket: FakeWs,
  window: Object.assign(win, { addEventListener: win.addEventListener.bind(win) }),
  document: { addEventListener: () => undefined, visibilityState: 'visible' },
  location: { protocol: 'http:', host: 'pc.test' },
  localStorage: { getItem: () => null, setItem: () => undefined, removeItem: () => undefined },
  setInterval: (() => ({ unref() {} })) as unknown
})
Object.defineProperty(globalThis, 'navigator', { value: { connection: undefined }, configurable: true })

const { Link } = await import('../src/renderer/src/remote/link')

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 5))

test('a page that subscribes after the line was up still learns what runs and what waits for a yes', async () => {
  const link = new Link('tok')
  const started = link.start()
  await tick()
  const ws = FakeWs.all[0]
  ws.say({ t: 'ready', epoch: 'e1', seq: 9, resumed: false, version: '1' })
  await started
  // what the PC tells right after the line is up: no page is listening yet
  ws.say({ t: 'ev', channel: 'jolty:event', data: { type: 'status', sessionId: 'a', status: 'running', ageMs: 5000 } })
  ws.say({ t: 'ev', channel: 'jolty:event', data: { type: 'status', sessionId: 'b', status: 'running', ageMs: 0 } })
  ws.say({ t: 'ev', channel: 'jolty:event', data: { type: 'permission', sessionId: 'b', request: { id: 'r1' } } })
  ws.say({ t: 'ev', channel: 'jolty:event', data: { type: 'delta', sessionId: 'a', itemId: 'i', delta: 'x', kind: 'assistant' } })

  const late: Array<Record<string, unknown>> = []
  link.listen('jolty:event', (e) => late.push(e as Record<string, unknown>))
  assert.deepEqual(late.map((e) => `${e.type}:${e.sessionId}`).sort(), ['permission:b', 'status:a', 'status:b'])
  const a = late.find((e) => e.type === 'status' && e.sessionId === 'a')!
  assert.ok((a.ageMs as number) >= 5000 && (a.ageMs as number) < 8000, 'the clock of a turn keeps counting from its real start')

  // live events still reach it, and a finished turn (and its question) is not told to the next subscriber
  ws.say({ t: 'ev', channel: 'jolty:event', data: { type: 'status', sessionId: 'b', status: 'idle' } })
  assert.equal(late.at(-1)!.status, 'idle')
  const next: Array<Record<string, unknown>> = []
  link.listen('jolty:event', (e) => next.push(e as Record<string, unknown>))
  assert.deepEqual(next.map((e) => `${e.type}:${e.sessionId}`), ['status:a'])
})

test('a question that was answered is not told again', async () => {
  const link = new Link('tok2')
  const started = link.start()
  await tick()
  const ws = FakeWs.all.at(-1)!
  ws.say({ t: 'ready', epoch: 'e2', seq: 0, resumed: false, version: '1' })
  await started
  ws.say({ t: 'ev', channel: 'jolty:event', data: { type: 'permission', sessionId: 'c', request: { id: 'q1' } } })
  ws.say({ t: 'ev', channel: 'jolty:event', data: { type: 'permissionResolved', sessionId: 'c', requestId: 'q1' } })
  const got: unknown[] = []
  link.listen('jolty:event', (e) => got.push(e))
  assert.equal(got.length, 0)
})

test('refresh makes a new, not resumed, line: the PC tells everything again and the page is told it is done', async () => {
  const link = new Link('tok3')
  const started = link.start()
  await tick()
  const first = FakeWs.all.at(-1)!
  first.say({ t: 'ready', epoch: 'e3', seq: 4, resumed: false, version: '1' })
  await started
  first.say({ t: 'ev', channel: 'jolty:event', data: { type: 'status', sessionId: 'd', status: 'running' } })
  let resync = 0
  let done = 0
  win.addEventListener('jolty:resync', () => resync++)
  win.addEventListener('jolty:refreshed', () => done++)

  link.refresh()
  await new Promise((r) => setTimeout(r, 900))
  const second = FakeWs.all.at(-1)!
  assert.notEqual(second, first, 'a new socket was opened')
  const auth = JSON.parse(second.sent[0]) as { since?: unknown }
  assert.equal(auth.since, undefined, 'it asks for everything, not for what it missed')
  second.say({ t: 'ready', epoch: 'e3', seq: 8, resumed: false, version: '1' })
  assert.equal(resync, 1)
  assert.equal(done, 1)
  const got: unknown[] = []
  link.listen('jolty:event', (e) => got.push(e))
  assert.equal(got.length, 0, 'what was kept from before the refresh is forgotten until the PC says it again')
})
