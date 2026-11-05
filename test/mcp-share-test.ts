import assert from 'node:assert/strict'
import { test } from 'node:test'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { McpShare, userStdioServers, type StdioServer } from '../src/main/mcp-share'

const fake = path.resolve(__dirname, '../test/mocks/fake-mcp.cjs')
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jolty-share-'))
const log = path.join(tmp, 'spawns.log')
const spawns = (): number => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('\n').filter(Boolean).length : 0)
const server: StdioServer = { command: process.execPath, args: [fake], env: { FAKE_LOG: log } }
const make = (idleMs = 60_000): McpShare => new McpShare({ servers: () => ({ fake: server }), cacheFile: () => path.join(tmp, 'cache.json'), idleMs })
const call = (s: McpShare, id: number) => s.handle('fake', { jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'whoami', arguments: {} } })
const text = (r: Record<string, unknown> | undefined): string => ((r?.result as { content: { text: string }[] }).content[0].text)
const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** taskkill takes a moment on Windows */
const gone = async (pid: number): Promise<void> => {
  for (let i = 0; i < 50 && alive(pid); i++) await new Promise((r) => setTimeout(r, 100))
  assert.equal(alive(pid), false, `process ${pid} is still running`)
}

test('initialize and notifications never start the server', async () => {
  const s = make()
  const r = await s.handle('fake', { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26' } })
  assert.equal((r?.result as { protocolVersion: string }).protocolVersion, '2025-03-26')
  assert.equal(await s.handle('fake', { jsonrpc: '2.0', method: 'notifications/initialized' }), undefined)
  assert.equal(spawns(), 0)
  const unknown = await s.handle('nope', { jsonrpc: '2.0', id: 2, method: 'ping' })
  assert.equal((unknown?.error as { code: number }).code, -32602)
})

test('concurrent calls from several chats share one process, and the list comes from the cache next time', async () => {
  const s = make()
  const [a, b, c] = await Promise.all([call(s, 1), call(s, 2), call(s, 3)])
  assert.equal(text(a), text(b))
  assert.equal(text(b), text(c))
  assert.equal(spawns(), 1)
  await new Promise((r) => setTimeout(r, 300)) // the background refresh of the list after the start
  await s.stop()
  const again = make() // another app run: same cache file
  const list = await again.handle('fake', { jsonrpc: '2.0', id: 4, method: 'tools/list' })
  assert.equal((list?.result as { tools: { name: string }[] }).tools[0].name, 'whoami')
  const init = await again.handle('fake', { jsonrpc: '2.0', id: 5, method: 'initialize' })
  assert.equal((init?.result as { instructions: string }).instructions, 'use fake wisely')
  assert.equal(spawns(), 1, 'listing tools from the cache starts nothing')
  await again.stop()
})

test('an idle server stops and the next call starts a new one', async () => {
  const s = make(250)
  const first = Number(text(await call(s, 1)))
  assert.ok(alive(first))
  await gone(first)
  assert.deepEqual(await s.running(), [])
  const second = Number(text(await call(s, 2)))
  assert.notEqual(second, first)
  await s.stop()
  await gone(second)
})

test('only stdio servers with a shareable name are taken from the user file, variables expanded', () => {
  const file = path.join(tmp, 'claude.json')
  process.env.JOLTY_SHARE_TEST = 'x'
  fs.writeFileSync(file, JSON.stringify({ mcpServers: {
    ok: { command: 'npx', args: ['-y', '${JOLTY_SHARE_TEST}', '${JOLTY_NOPE:-dflt}'], env: { K: '${JOLTY_SHARE_TEST}' } },
    remote: { type: 'http', url: 'https://example.com/mcp' },
    'bad name': { command: 'x' },
    typed: { type: 'stdio', command: 'y' }
  } }))
  const got = userStdioServers(file)
  assert.deepEqual(Object.keys(got).sort(), ['ok', 'typed'])
  assert.deepEqual(got.ok, { command: 'npx', args: ['-y', 'x', 'dflt'], env: { K: 'x' } })
})
