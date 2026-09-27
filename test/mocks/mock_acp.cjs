const readline = require('node:readline')
const legacy = process.argv.includes('--legacy')
const received = []
const pending = new Map()
const sessions = new Set(['history-one', 'history-two'])
let nextSession = 0
let writes = Promise.resolve()
function send(message, fragment = false) {
  const body = Buffer.from(JSON.stringify(legacy ? message : { jsonrpc: '2.0', ...message }) + '\n')
  writes = writes.then(async () => {
    if (!fragment) return void process.stdout.write(body)
    const offset = body.indexOf(Buffer.from('ă')) + 1
    const split = offset > 0 ? offset : Math.floor(body.length / 2)
    process.stdout.write(body.subarray(0, split))
    await new Promise((resolve) => setTimeout(resolve, 5))
    process.stdout.write(body.subarray(split))
  })
  return writes
}
const reply = (id, result, fragment = false) => send({ id, result }, fragment)
const fail = (id, message) => send({ id, error: { code: -32602, message } })
const update = (sessionId, value, fragment = false) => send({ method: 'session/update', params: { sessionId, update: value } }, fragment)
const text = (sessionId, value, kind = 'agent_message_chunk', fragment = false) => update(sessionId, {
  sessionUpdate: kind, content: { type: 'text', text: value }
}, fragment)
const models = {
  currentModelId: 'custom:test-model',
  availableModels: [{ modelId: 'custom:test-model', name: 'Test model' }, { modelId: 'custom:other', name: 'Other' }]
}
const modes = {
  currentModeId: 'default',
  availableModes: [{ id: 'default', name: 'Default' }, { id: 'accept_edits', name: 'Accept edits' }, { id: 'dont_ask', name: 'Full access' }]
}
async function complete(id, sessionId, result = 'end_turn') {
  pending.delete(sessionId)
  await reply(id, { stopReason: result, usage: { inputTokens: 120, outputTokens: 30, totalTokens: 150, cachedReadTokens: 20 } })
}
async function prompt(message) {
  const { sessionId, prompt: parts } = message.params
  if (!sessions.has(sessionId)) return fail(message.id, 'Session not found')
  const command = parts.filter((part) => part.type === 'text').map((part) => part.text).join('\n')
  if (command === 'crash') return process.exit(23)
  if (command === 'hold') {
    pending.set(sessionId, { id: message.id })
    return text(sessionId, 'waiting')
  }
  if (command.startsWith('permission')) {
    const permissionId = 'permission-string-1'
    pending.set(sessionId, { id: message.id, permissionId })
    const options = [
      { optionId: 'allow_always', kind: 'allow_always', name: 'Always' },
      { optionId: 'allow_once', kind: 'allow_once', name: 'Once' },
      { optionId: 'deny', kind: 'reject_once', name: 'Deny' }
    ]
    if (command !== 'permission-no-session') options.push({ optionId: 'allow_session', kind: 'allow_always', name: 'Session' })
    return send({ id: permissionId, method: 'session/request_permission', params: {
      sessionId, toolCall: {
        toolCallId: 'write-approval', title: 'Update sample.txt', kind: 'edit', status: 'pending',
        rawInput: { path: 'sample.txt', content: 'new text' },
        content: [{ type: 'diff', path: 'sample.txt', oldText: 'old text', newText: 'new text' }]
      }, options
    } })
  }
  if (command === 'stream') {
    await text(sessionId, 'Verifică ', 'agent_thought_chunk', true)
    await text(sessionId, 'pașii.', 'agent_thought_chunk')
    await update(sessionId, {
      sessionUpdate: 'tool_call', toolCallId: 'tool-edit-1', title: 'write: sample.txt', kind: 'edit', status: 'in_progress',
      rawInput: { path: 'sample.txt', content: 'new text' },
      content: [{ type: 'diff', path: 'sample.txt', oldText: 'old text', newText: 'new text' }]
    })
    await update(sessionId, { sessionUpdate: 'tool_call_update', toolCallId: 'tool-edit-1', status: 'completed', rawOutput: { saved: true } })
    await update(sessionId, { sessionUpdate: 'plan', entries: [
      { content: 'Read input', priority: 'high', status: 'completed' },
      { content: 'Check output', priority: 'medium', status: 'in_progress' },
      { content: 'Finish', priority: 'low', status: 'pending' }
    ] })
    await update(sessionId, { sessionUpdate: 'usage_update', used: 1234, size: 64000 })
    await text(sessionId, 'Bună 🧩', 'agent_message_chunk', true)
    await text(sessionId, ' lume!')
    await new Promise((resolve) => setTimeout(resolve, 35))
  } else {
    await text(sessionId, command === '/compact' ? 'Compacted' : 'fresh answer')
  }
  await complete(message.id, sessionId)
}
async function handle(message) {
  received.push(message)
  if (!legacy && message.jsonrpc !== '2.0') return fail(message.id, 'Expected JSON-RPC 2.0')
  if (!message.method) {
    for (const [sessionId, turn] of pending) {
      if (turn.permissionId !== message.id) continue
      await text(sessionId, JSON.stringify(message.result || message.error))
      await complete(turn.id, sessionId)
    }
    return
  }
  const p = message.params || {}
  switch (message.method) {
    case 'initialize': return reply(message.id, {
      protocolVersion: 1, agentInfo: { name: 'hermes-test', version: '1' },
      agentCapabilities: { loadSession: true, promptCapabilities: { image: true }, sessionCapabilities: { list: {}, resume: {} } },
      authMethods: [
        ...(process.env.MOCK_NO_PROVIDER ? [] : [{ id: 'xiaomi', name: 'Custom runtime credentials' }]),
        { id: 'hermes-setup', name: 'Setup', type: 'terminal', args: ['--setup'] }
      ]
    })
    case 'authenticate': return reply(message.id, {})
    case 'session/new': {
      if (typeof p.cwd !== 'string' || !Array.isArray(p.mcpServers)) return fail(message.id, 'Missing session fields')
      const sessionId = `session-test-${++nextSession}`
      sessions.add(sessionId)
      return reply(message.id, { sessionId, models, modes })
    }
    case 'session/load':
      if (!sessions.has(p.sessionId)) return fail(message.id, 'Session not found')
      await text(p.sessionId, 'old question', 'user_message_chunk')
      await text(p.sessionId, 'old answer')
      return reply(message.id, { models, modes })
    case 'session/list': return reply(message.id, p.cursor ? {
      sessions: [{ sessionId: 'history-two', title: 'Second history', cwd: p.cwd || '/test', updatedAt: '2026-01-02T00:00:00Z' }]
    } : {
      sessions: [{ sessionId: 'history-one', title: 'First history', cwd: p.cwd || '/test', updatedAt: '2026-01-01T00:00:00Z' }], nextCursor: 'history-one'
    })
    case 'session/set_model':
    case 'session/set_mode':
      if (!sessions.has(p.sessionId)) return fail(message.id, 'Session not found')
      return reply(message.id, {})
    case 'session/prompt': return prompt(message)
    case 'session/cancel': {
      const turn = pending.get(p.sessionId)
      if (turn) await complete(turn.id, p.sessionId, 'cancelled')
      return
    }
    case 'test/inspect': return reply(message.id, received)
    case 'test/fragment': return reply(message.id, { text: 'Încearcă 🧩' }, true)
    case 'test/error': return fail(message.id, 'Mock failure')
    case 'test/never': return
    case 'test/string-request':
      await send({ id: 'server-string-17', method: 'test/client', params: { text: 'hello' } })
      return reply(message.id, {})
    case 'test/unknown-permission':
      await send({ id: 'unknown-permission', method: 'session/request_permission', params: {
        sessionId: 'not-owned', toolCall: { toolCallId: 'unknown-tool', title: 'Unknown' },
        options: [{ optionId: 'allow_once', kind: 'allow_once', name: 'Once' }]
      } })
      return reply(message.id, {})
    default: return fail(message.id, `Unsupported method: ${message.method}`)
  }
}
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  try {
    Promise.resolve(handle(JSON.parse(line))).catch((error) => { process.stderr.write(error.stack + '\n'); process.exit(2) })
  } catch (error) { process.stderr.write(error.stack + '\n'); process.exit(2) }
})
