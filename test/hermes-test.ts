import assert from 'node:assert/strict'
import path from 'node:path'
import { test } from 'node:test'
import { HermesDriver } from '../src/main/engines/hermes'
import { JsonRpcProcess, type RpcRequest } from '../src/main/engines/jsonrpc'
import type { EngineHost, EngineSession } from '../src/main/engines/types'
import type { ChatEvent, ChatItem, Profile, SessionMeta, TurnUsage } from '../src/shared/types'

const mockPath = path.resolve('test/mocks/mock_acp.cjs')
const env = { SystemRoot: process.env.SystemRoot || '', PATH: process.env.PATH || '', ELECTRON_RUN_AS_NODE: '1' }
const profile: Profile = {
  id: 'hermes-test-profile', name: 'Hermes test', engine: 'hermes',
  auth: 'subscription', isDefaultDir: true, color: '#123456'
}
type WireMessage = { id?: string | number; jsonrpc?: string; method?: string; params?: Record<string, unknown>; result?: unknown }
type PermissionEvent = Extract<ChatEvent, { type: 'permission' }>
async function until<T>(read: () => T | undefined, label: string, timeout = 3000): Promise<T> {
  const started = Date.now()
  while (Date.now() - started < timeout) {
    const value = read()
    if (value !== undefined) return value
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error(`Timed out: ${label}`)
}
function fixture(extraEnv: Record<string, string> = {}) {
  const processes: JsonRpcProcess[] = []
  const events: ChatEvent[] = []
  const usage: TurnUsage[] = []
  const driver = new HermesDriver(() => {
    const rpc = new JsonRpcProcess(process.execPath, [mockPath], { ...env, ...extraEnv }, { jsonrpc: true, label: 'Hermes' })
    processes.push(rpc)
    return rpc
  })
  const host: EngineHost = { emit: (event) => events.push(event), recordUsage: (value) => usage.push(value), recordLimits: () => {} }
  const meta: SessionMeta = {
    id: 'local-test', profileId: profile.id, engine: 'hermes', cwd: process.cwd(), title: 'Test',
    permissionMode: 'ask', createdAt: 1, updatedAt: 1
  }
  let session: EngineSession | undefined
  return {
    driver, events, usage, processes,
    session(patch: Partial<SessionMeta> = {}) {
      session = driver.createSession(profile, { ...meta, ...patch }, host)
      return session
    },
    async messages(): Promise<WireMessage[]> {
      const rpc = [...processes].reverse().find((candidate) => !candidate.exited)
      assert.ok(rpc, 'A running mock process is available')
      return rpc.request<WireMessage[]>('test/inspect')
    },
    async close() {
      await session?.close()
      await driver.shutdown()
      for (const rpc of processes) rpc.kill()
    }
  }
}
function materialize(events: ChatEvent[]): ChatItem[] {
  const items = new Map<string, ChatItem>()
  for (const event of events) {
    if (event.type === 'item') items.set(event.item.id, { ...event.item })
    if (event.type === 'delta') {
      const item = items.get(event.itemId)
      if (item && (item.kind === 'assistant' || item.kind === 'reasoning')) item.text += event.delta
      else items.set(event.itemId, { id: event.itemId, kind: event.kind, text: event.delta })
    }
  }
  return [...items.values()]
}

test('JSON-RPC 2.0 preserves split UTF-8 and string request IDs', async () => {
  const rpc = new JsonRpcProcess(process.execPath, [mockPath], env, { jsonrpc: true, label: 'Hermes' })
  try {
    assert.deepEqual(await rpc.request('test/fragment'), { text: 'Încearcă 🧩' })
    rpc.on('request', (request: RpcRequest) => rpc.respond(request.id, { accepted: true }))
    await rpc.request('test/string-request')
    const messages = await rpc.request<WireMessage[]>('test/inspect')
    assert.ok(messages.every((message) => message.jsonrpc === '2.0'))
    assert.deepEqual(messages.find((message) => message.id === 'server-string-17')?.result, { accepted: true })
  } finally { rpc.kill() }
})
test('legacy transport keeps Codex framing unchanged', async () => {
  const rpc = new JsonRpcProcess(process.execPath, [mockPath, '--legacy'], env)
  try {
    await rpc.request('test/fragment')
    rpc.notify('test/never')
    const messages = await rpc.request<WireMessage[]>('test/inspect')
    assert.ok(messages.every((message) => !Object.hasOwn(message, 'jsonrpc')))
  } finally { rpc.kill() }
})
test('transport rejects errors, timeouts and pending requests at exit', async () => {
  const rpc = new JsonRpcProcess(process.execPath, [mockPath], env, { jsonrpc: true, label: 'Hermes' })
  try {
    await assert.rejects(rpc.request('test/error'), /Mock failure/)
    await assert.rejects(rpc.request('test/never', {}, 30), /test\/never/)
    const waiting = assert.rejects(rpc.request('test/never'), /Hermes|stopped|oprit/i)
    rpc.kill()
    await waiting
  } finally { rpc.kill() }
})
test('configured provider status and models use the ACP handshake', async () => {
  const f = fixture()
  try {
    assert.equal((await f.driver.status(profile)).loggedIn, true)
    const models = await f.driver.models(profile)
    assert.deepEqual(models.map((model) => model.id), ['custom:test-model', 'custom:other'])
    assert.equal(models.find((model) => model.isDefault)?.id, 'custom:test-model')
  } finally { await f.close() }
  const unconfigured = fixture({ MOCK_NO_PROVIDER: '1' })
  try { assert.equal((await unconfigured.driver.status(profile)).loggedIn, false) }
  finally { await unconfigured.close() }
})
test('streaming preserves partial tool metadata, diffs, plan, context and token usage', async () => {
  const f = fixture()
  try {
    let finished = false
    const sending = f.session().send('stream').then(() => { finished = true })
    await until(() => f.events.find((event) => event.type === 'delta' && event.delta.includes('Bună')), 'stream chunk')
    assert.equal(finished, false, 'send must await the prompt response')
    await sending
    const items = materialize(f.events)
    assert.equal(items.filter((item) => item.kind === 'assistant').map((item) => item.text).join(''), 'Bună 🧩 lume!')
    assert.equal(items.filter((item) => item.kind === 'reasoning').map((item) => item.text).join(''), 'Verifică pașii.')
    const tool = items.find((item) => item.kind === 'tool' && item.id === 'tool-edit-1')
    assert.ok(tool?.kind === 'tool')
    assert.equal(tool.status, 'done')
    assert.equal(tool.title, 'write: sample.txt')
    assert.deepEqual(tool.input, { path: 'sample.txt', content: 'new text' })
    assert.equal(tool.diffs?.[0].path, 'sample.txt')
    assert.match(tool.diffs?.[0].diff || '', /-old text/)
    assert.match(tool.diffs?.[0].diff || '', /\+new text/)
    assert.match(tool.output || '', /saved/)
    assert.deepEqual(f.events.find((event) => event.type === 'plan')?.steps, [
      { text: 'Read input', status: 'done' }, { text: 'Check output', status: 'active' }, { text: 'Finish', status: 'pending' }
    ])
    assert.ok(f.events.some((event) => event.type === 'context' && event.used === 1234 && event.window === 64000))
    assert.equal(f.usage.length, 1)
    assert.equal(f.usage[0].inputTokens, 100)
    assert.equal(f.usage[0].outputTokens, 30)
    assert.equal(f.usage[0].cacheReadTokens, 20)
    assert.equal(f.usage[0].engine, 'hermes')
    assert.ok(f.events.some((event) => event.type === 'status' && event.status === 'idle'))
  } finally { await f.close() }
})
for (const [decision, optionId] of [['allow', 'allow_once'], ['allowSession', 'allow_session'], ['deny', 'deny']] as const) {
  test(`permission ${decision} returns exact offered option ID`, async () => {
    const f = fixture()
    try {
      const session = f.session()
      const sending = session.send('permission')
      const event = await until(() => f.events.find((item): item is PermissionEvent => item.type === 'permission'), 'permission')
      assert.equal(event.request.canAllowForSession, true)
      assert.equal(event.request.diffs?.[0].path, 'sample.txt')
      session.respond(event.request.id, decision)
      await sending
      const response = (await f.messages()).find((message) => message.id === 'permission-string-1')
      assert.deepEqual(response?.result, { outcome: { outcome: 'selected', optionId } })
      assert.ok(f.events.some((item) => item.type === 'permissionResolved' && item.requestId === event.request.id))
    } finally { await f.close() }
  })
}
test('session approval never falls back to permanent permission', async () => {
  const f = fixture()
  try {
    const session = f.session()
    const sending = session.send('permission-no-session')
    const event = await until(() => f.events.find((item): item is PermissionEvent => item.type === 'permission'), 'permission')
    assert.equal(event.request.canAllowForSession, false)
    session.respond(event.request.id, 'allowSession')
    await sending
    const response = (await f.messages()).find((message) => message.id === 'permission-string-1')
    assert.deepEqual(response?.result, { outcome: { outcome: 'cancelled' } })
  } finally { await f.close() }
})
test('interrupt cancels an active prompt and outstanding permission', async () => {
  const f = fixture()
  try {
    const session = f.session()
    const sending = session.send('permission')
    const event = await until(() => f.events.find((item): item is PermissionEvent => item.type === 'permission'), 'permission')
    await session.interrupt()
    await sending
    const messages = await f.messages()
    assert.ok(messages.some((message) => message.method === 'session/cancel'))
    assert.deepEqual(messages.find((message) => message.id === 'permission-string-1')?.result, { outcome: { outcome: 'cancelled' } })
    assert.ok(f.events.some((item) => item.type === 'permissionResolved' && item.requestId === event.request.id))
  } finally { await f.close() }
})
test('close settles an in-flight prompt and resolves permission UI', async () => {
  const f = fixture()
  try {
    const session = f.session()
    const sending = session.send('permission').then(() => true, () => true)
    const event = await until(() => f.events.find((item): item is PermissionEvent => item.type === 'permission'), 'permission')
    await session.close()
    assert.equal(await sending, true)
    assert.ok(f.events.some((item) => item.type === 'permissionResolved' && item.requestId === event.request.id))
  } finally { await f.close() }
})
test('history replays once and resuming suppresses duplicate replay', async () => {
  const f = fixture()
  try {
    const history = await f.driver.history(profile, 'history-one', process.cwd())
    assert.deepEqual(history.filter((item) => 'text' in item).map((item) => [item.kind, item.text]), [
      ['user', 'old question'], ['assistant', 'old answer']
    ])
    await f.session({ engineSessionId: 'history-one' }).send('continue')
    const items = materialize(f.events)
    assert.equal(items.some((item) => 'text' in item && item.text.includes('old answer')), false)
    assert.equal(items.filter((item) => item.kind === 'assistant').map((item) => item.text).join(''), 'fresh answer')
  } finally { await f.close() }
})
test('listing follows pagination and unknown sessions fail', async () => {
  const f = fixture()
  try {
    assert.deepEqual((await f.driver.externalSessions(profile, process.cwd())).map((session) => session.engineSessionId), ['history-one', 'history-two'])
    await assert.rejects(f.driver.history(profile, 'not-found', process.cwd()), /not found/i)
    await assert.rejects(f.session({ engineSessionId: 'not-found' }).send('continue'), /not found/i)
  } finally { await f.close() }
})
test('model, mode and compact map to ACP; unsupported controls fail', async () => {
  const f = fixture()
  try {
    const session = f.session()
    await session.send('initial')
    await session.setModel('custom:other')
    await session.setPermissionMode('autoEdit')
    await session.setPermissionMode('full')
    await session.setPermissionMode('ask')
    await assert.rejects(session.setPermissionMode('plan'))
    await assert.rejects(session.setBrowser(true))
    await session.setBrowser(false)
    await session.compact()
    const messages = await f.messages()
    assert.ok(messages.some((message) => message.method === 'session/set_model' && message.params?.modelId === 'custom:other'))
    const modes = messages.filter((message) => message.method === 'session/set_mode').map((message) => message.params?.modeId)
    assert.ok(modes.includes('accept_edits') && modes.includes('dont_ask') && modes.includes('default'))
    assert.equal(modes.includes('plan'), false)
    assert.ok(messages.some((message) => message.method === 'session/prompt' && JSON.stringify(message.params?.prompt).includes('/compact')))
  } finally { await f.close() }
})
test('permission for an unknown session is rejected without an approval dialog', async () => {
  const f = fixture()
  try {
    await f.session().send('initial')
    const rpc = f.processes.find((candidate) => !candidate.exited)!
    await rpc.request('test/unknown-permission')
    const messages = await f.messages()
    assert.deepEqual(messages.find((message) => message.id === 'unknown-permission')?.result, { outcome: { outcome: 'cancelled' } })
    assert.equal(f.events.some((event) => event.type === 'permission'), false)
  } finally { await f.close() }
})
