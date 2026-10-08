import assert from 'node:assert/strict'
import { test } from 'node:test'
import { CodexDriver } from '../src/main/engines/codex'
import { setLang } from '../src/shared/i18n'
import type { ChatEvent, SessionMeta } from '../src/shared/types'

// the assertions below read the Romanian messages
setLang('ro')

function fixture() {
  const events: ChatEvent[] = []
  const calls: { method: string; params: any }[] = []
  let start: (() => Promise<any>) | undefined
  let compact: (() => Promise<any>) | undefined
  const rpc = {
    request: async (method: string, params: any) => {
      calls.push({ method, params })
      if (method === 'thread/start') return { thread: { id: 'thread' }, model: 'test' }
      if (method === 'turn/start') return start ? start() : { turn: { id: 'turn', status: 'inProgress' } }
      if (method === 'thread/compact/start' && compact) return compact()
      return {}
    },
    respond: () => {}
  }
  const server = { get: async () => rpc, rpc, sessions: new Map() }
  const driver = new CodexDriver()
  ;(driver as any).server = () => server
  const profile = { id: 'test', name: 'Test', engine: 'codex', auth: 'subscription', color: '' } as const
  const meta: SessionMeta = {
    id: 'local', engine: 'codex', profileId: profile.id, title: 'Test', cwd: process.cwd(),
    permissionMode: 'ask', createdAt: 1, updatedAt: 1
  }
  const session = driver.createSession(profile, meta, {
    emit: (event) => events.push(event), recordUsage: () => {}, recordLimits: () => {}
  }) as any
  return {
    session, events, calls,
    start: (fn: () => Promise<any>) => { start = fn },
    compact: (fn: () => Promise<any>) => { compact = fn },
    status: () => events.filter((e) => e.type === 'status').at(-1),
    notify: (method: string, params: any = {}) => session.onNotification(method, { threadId: 'thread', ...params })
  }
}

test('a late start response cannot resurrect a completed turn', async () => {
  const f = fixture()
  f.start(async () => {
    f.notify('turn/started', { turn: { id: 'turn' } })
    f.notify('turn/completed', { turn: { id: 'turn', status: 'completed' } })
    return { turn: { id: 'turn', status: 'inProgress' } }
  })
  await f.session.send('hello')
  await f.session.interrupt()
  assert.equal(f.calls.filter((c) => c.method === 'turn/interrupt').length, 0)
  assert.equal(f.status()?.status, 'idle')
})

test('completion from an older turn cannot mark a newer turn idle', async () => {
  const f = fixture()
  await f.session.send('hello')
  f.notify('turn/started', { turn: { id: 'new-turn' } })
  f.notify('turn/completed', { turn: { id: 'old-turn', status: 'completed' } })
  assert.equal(f.status()?.status, 'running')
  await f.session.interrupt()
  assert.equal(f.calls.at(-1)?.params.turnId, 'new-turn')
})

test('thread state reconciles compaction and missing completion notifications', async () => {
  const f = fixture()
  await f.session.compact()
  assert.equal(f.status()?.status, 'running')
  f.notify('thread/status/changed', { status: { type: 'idle' } })
  assert.equal(f.status()?.status, 'idle')
  f.notify('thread/status/changed', { status: { type: 'active', activeFlags: [] } })
  assert.equal(f.status()?.status, 'running')
})

test('a start timeout does not claim that an observed live turn stopped', async () => {
  const f = fixture()
  f.start(async () => {
    f.notify('turn/started', { turn: { id: 'turn' } })
    f.notify('item/started', { turnId: 'turn', item: { type: 'contextCompaction', id: 'compact' } })
    throw new Error('turn/start: fără răspuns de la Codex')
  })
  await f.session.send('hello')
  assert.equal(f.status()?.status, 'running')
  f.notify('item/completed', { turnId: 'turn', item: { type: 'contextCompaction', id: 'compact' } })
  f.notify('item/agentMessage/delta', { turnId: 'turn', itemId: 'answer', delta: 'resumed answer' })
  assert.ok(f.events.some((e) => e.type === 'delta' && e.delta === 'resumed answer'))
  f.notify('turn/completed', { turn: { id: 'turn', status: 'completed' } })
  assert.equal(f.status()?.status, 'idle')
})

test('stop during startup interrupts the turn once its ID arrives', async () => {
  const f = fixture()
  let release!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  f.start(async () => {
    await gate
    f.notify('turn/started', { turn: { id: 'turn' } })
    return { turn: { id: 'turn', status: 'inProgress' } }
  })
  const sending = f.session.send('hello')
  await new Promise((resolve) => setImmediate(resolve))
  await f.session.interrupt()
  release()
  await sending
  assert.equal(f.calls.filter((c) => c.method === 'turn/interrupt').length, 1)
  assert.equal(f.calls.find((c) => c.method === 'turn/interrupt')?.params.turnId, 'turn')
})

test('compaction idle before its acknowledgement still completes', async () => {
  const f = fixture()
  f.compact(async () => {
    f.notify('thread/status/changed', { status: { type: 'idle' } })
    return {}
  })
  await f.session.compact()
  assert.equal(f.status()?.status, 'idle')
  await f.session.send('next message')
  assert.equal(f.calls.filter((c) => c.method === 'turn/start').length, 1)
})

test('duplicate completion cannot clear a newer pending start', async () => {
  const f = fixture()
  await f.session.send('first')
  f.notify('turn/completed', { turn: { id: 'turn', status: 'completed' } })
  let release!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  f.start(async () => { await gate; return { turn: { id: 'new-turn', status: 'inProgress' } } })
  const sending = f.session.send('second')
  await new Promise((resolve) => setImmediate(resolve))
  f.notify('turn/completed', { turn: { id: 'turn', status: 'completed' } })
  assert.equal(f.status()?.status, 'running')
  await assert.rejects(f.session.send('third'), /lucrează deja/)
  release()
  await sending
  assert.equal(f.calls.filter((c) => c.method === 'turn/start').length, 2)
})

test('terminal notification permits the next queued message before the old acknowledgement', async () => {
  const f = fixture()
  let release!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  f.start(async () => {
    f.notify('turn/started', { turn: { id: 'turn' } })
    f.notify('turn/completed', { turn: { id: 'turn', status: 'completed' } })
    await gate
    return { turn: { id: 'turn', status: 'inProgress' } }
  })
  const first = f.session.send('first')
  await new Promise((resolve) => setImmediate(resolve))
  f.start(async () => ({ turn: { id: 'next-turn', status: 'inProgress' } }))
  await f.session.send('queued')
  release()
  await first
  await f.session.interrupt()
  assert.equal(f.calls.at(-1)?.params.turnId, 'next-turn')
})

test('interruption clears pending permissions and terminalizes running tools', async () => {
  const f = fixture()
  await f.session.send('hello')
  f.notify('item/started', { turnId: 'turn', item: { type: 'commandExecution', id: 'tool', command: 'test', status: 'inProgress' } })
  f.notify('item/commandExecution/outputDelta', { turnId: 'turn', itemId: 'tool', delta: 'partial output' })
  f.session.onRequest({ id: 7, method: 'item/commandExecution/requestApproval', params: { threadId: 'thread', command: 'test' } })
  f.notify('turn/completed', { turn: { id: 'turn', status: 'interrupted' } })
  const tool = f.events.filter((e) => e.type === 'item' && e.item.id === 'tool').at(-1)
  assert.equal(tool?.item.kind, 'tool')
  assert.equal(tool?.item.status, 'error')
  assert.equal(tool?.item.output, 'partial output')
  assert.ok(f.events.some((e) => e.type === 'permissionResolved'))
  assert.equal(f.status()?.status, 'idle')
})

test('active notifications supersede an earlier idle before the start acknowledgement', async () => {
  const f = fixture()
  f.start(async () => {
    f.notify('thread/status/changed', { status: { type: 'idle' } })
    f.notify('turn/started', { turn: { id: 'turn' } })
    return { turn: { id: 'turn', status: 'inProgress' } }
  })
  await f.session.send('hello')
  assert.equal(f.status()?.status, 'running')
})

test('stop is honored when an item supplies the turn ID before a start timeout', async () => {
  const f = fixture()
  let release!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  f.start(async () => {
    await gate
    f.notify('item/started', { turnId: 'turn', item: { type: 'contextCompaction', id: 'compact' } })
    throw new Error('turn/start: fără răspuns de la Codex')
  })
  const sending = f.session.send('hello')
  await new Promise((resolve) => setImmediate(resolve))
  await f.session.interrupt()
  release()
  await sending
  assert.equal(f.calls.filter((c) => c.method === 'turn/interrupt').length, 1)
})
