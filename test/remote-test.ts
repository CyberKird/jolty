import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { after, before, test } from 'node:test'
import { WebSocket } from 'ws'
import { Remote } from '../src/main/remote'

// the phone link: pairing, the allowed list, events, and the refusals (wrong host, wrong key, files outside the page)
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jolty-remote-'))
process.env.JOLTY_DATA_DIR = dir
const web = path.join(dir, 'web')
fs.mkdirSync(path.join(web, 'assets'), { recursive: true })
fs.writeFileSync(path.join(web, 'index.html'), `<html><head><meta http-equiv="Content-Security-Policy" content="default-src 'self'; connect-src 'self' blob:"></head><body></body></html>`)
fs.writeFileSync(path.join(web, 'assets', 'a.js'), 'x')
fs.writeFileSync(path.join(dir, 'secret.txt'), 'secret')

const PORT = 47990
fs.writeFileSync(path.join(dir, 'remote.json'), JSON.stringify({ enabled: false, port: PORT, devices: [] }))
const remote = new Remote(undefined, web)
const calls: unknown[][] = []
remote.register('sessions:list', () => [{ id: 's1' }])
remote.register('sessions:send', (...a) => (calls.push(a), undefined))
remote.register('sessions:setPermissionMode', (...a) => (calls.push(a), undefined))
remote.register('sessions:start', (...a) => (calls.push(a), { id: 'new' }))
remote.register('app:saveSettings', (...a) => (calls.push(a), {}))
remote.register('app:pickFolder', () => 'C:\\')
remote.register('remote:enable', () => 'nope')

type Reply = { status: number; text: string; headers: http.IncomingHttpHeaders }

function request(opts: http.RequestOptions, body?: string): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: PORT, ...opts }, (res) => {
      let text = ''
      res.on('data', (c) => (text += c))
      res.on('end', () => resolve({ status: res.statusCode || 0, text, headers: res.headers }))
    })
    req.on('error', reject)
    req.end(body)
  })
}

async function pair(): Promise<string> {
  const { code } = remote.startPairing()
  const r = await request({ path: '/api/pair', method: 'POST', headers: { 'Content-Type': 'application/json' } }, JSON.stringify({ code, name: 'Test phone' }))
  assert.equal(r.status, 200)
  return JSON.parse(r.text).token
}

interface Conn {
  ws: WebSocket
  msgs: Array<Record<string, unknown>>
  closed: Promise<number>
}

function connect(token: string, headers: Record<string, string> = {}): Promise<Conn> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`, { headers })
    const msgs: Array<Record<string, unknown>> = []
    const closed = new Promise<number>((res) => ws.on('close', (code) => res(code)))
    ws.on('message', (d) => msgs.push(JSON.parse(String(d))))
    ws.on('open', () => {
      ws.send(JSON.stringify({ t: 'auth', token }))
      resolve({ ws, msgs, closed })
    })
    ws.on('error', reject)
  })
}

const until = async (f: () => boolean): Promise<void> => {
  for (let i = 0; i < 100 && !f(); i++) await new Promise((r) => setTimeout(r, 20))
  assert.ok(f(), 'timed out')
}

async function ask(c: Conn, id: number, channel: string, args: unknown[]): Promise<Record<string, unknown>> {
  c.ws.send(JSON.stringify({ t: 'call', id, channel, args }))
  await until(() => c.msgs.some((m) => m.t === 'res' && m.id === id))
  return c.msgs.find((m) => m.t === 'res' && m.id === id)!
}

before(async () => {
  await (remote as unknown as { listen(): Promise<void> }).listen()
})
after(async () => {
  await remote.stop()
  fs.rmSync(dir, { recursive: true, force: true })
})

test('serves the page with the phone connection allowed, and the language script', async () => {
  const r = await request({ path: '/', headers: { Host: `127.0.0.1:${PORT}` } })
  assert.equal(r.status, 200)
  assert.match(r.text, new RegExp(`connect-src 'self' blob: wss://127\\.0\\.0\\.1:${PORT}`))
  assert.match(r.text, /<script src="\/lang\.js">/)
  assert.match(r.text, /rel="manifest"/)
  assert.match(r.text, /apple-mobile-web-app-capable/)
  assert.match((await request({ path: '/lang.js' })).text, /joltyLang/)
  assert.match(String((await request({ path: '/assets/a.js' })).headers['cache-control']), /immutable/)
})

test('refuses other hosts, header tricks and paths outside the page', async () => {
  assert.equal((await request({ path: '/', headers: { Host: 'evil.example.com' } })).status, 421)
  assert.equal((await request({ path: '/', headers: { Host: 'x.ts.net; script-src *' } })).status, 421)
  assert.equal((await request({ path: '/..%2fsecret.txt' })).status, 403)
  const dots = await request({ path: '/%2e%2e/secret.txt' })
  assert.ok(dots.status === 403 || dots.status === 404, 'URL parsing keeps it inside the page folder')
  assert.doesNotMatch(dots.text, /secret/)
  assert.equal((await request({ path: '/', method: 'DELETE' })).status, 405)
})

test('pairing: a code works once, wrong codes lock after five tries', async () => {
  const bad = await request({ path: '/api/pair', method: 'POST' }, JSON.stringify({ code: 'NOPE' }))
  assert.equal(bad.status, 403)
  const { code } = remote.startPairing()
  const body = JSON.stringify({ code })
  assert.equal((await request({ path: '/api/pair', method: 'POST' }, body)).status, 200)
  assert.equal((await request({ path: '/api/pair', method: 'POST' }, body)).status, 403)
  for (let i = 0; i < 5; i++) await request({ path: '/api/pair', method: 'POST' }, JSON.stringify({ code: 'WRONG' + i }))
  const fresh = remote.startPairing().code
  assert.equal((await request({ path: '/api/pair', method: 'POST' }, JSON.stringify({ code: fresh }))).status, 403, 'locked even with a right code')
  ;(remote as unknown as { failures: number[] }).failures = []
})

test('a wrong or missing key is closed, a right one is served', async () => {
  const bad = await connect('wrong-token')
  assert.equal(await bad.closed, 4401)
  const ok = await connect(await pair())
  await until(() => ok.msgs.some((m) => m.t === 'ready'))
  const r = await ask(ok, 1, 'sessions:list', [])
  assert.deepEqual(r.value, [{ id: 's1' }])
  ok.ws.close()
})

test('only listed channels, never the desktop ones, and no open modes from the phone', async () => {
  const c = await connect(await pair())
  await until(() => c.msgs.some((m) => m.t === 'ready'))
  assert.equal((await ask(c, 1, 'app:pickFolder', [])).ok, false)
  assert.equal((await ask(c, 2, 'remote:enable', [true])).ok, false)
  assert.equal((await ask(c, 3, 'sessions:setPermissionMode', ['s1', 'full'])).ok, false)
  assert.equal((await ask(c, 4, 'sessions:setPermissionMode', ['s1', 'project'])).ok, false)
  assert.equal((await ask(c, 5, 'sessions:setPermissionMode', ['s1', 'ask'])).ok, true)
  assert.equal((await ask(c, 6, 'sessions:start', [{ profileId: 'p', cwd: 'C:\\x', permissionMode: 'full' }])).ok, false)
  assert.equal((await ask(c, 7, 'sessions:start', [{ profileId: 'p', cwd: 'C:\\x', permissionMode: 'autoEdit' }])).ok, true)
  assert.equal((await ask(c, 8, 'sessions:send', ['s1', 'hello', [], false])).ok, true)
  assert.deepEqual(calls.at(-1), ['s1', 'hello', [], false])
  await ask(c, 9, 'app:saveSettings', [{ theme: 'glass', browserMode: 'own', dataDir: 'x' }])
  assert.deepEqual(calls.at(-1), [{ theme: 'glass' }], 'only look and last-choice keys pass')
  c.ws.close()
})

test('events reach every connected phone, and a revoked phone is cut off', async () => {
  const token = await pair()
  const a = await connect(token)
  await until(() => a.msgs.some((m) => m.t === 'ready'))
  remote.broadcast('jolty:event', { type: 'status', sessionId: 's1', status: 'running' })
  await until(() => a.msgs.some((m) => m.t === 'ev'))
  assert.deepEqual(a.msgs.find((m) => m.t === 'ev')?.data, { type: 'status', sessionId: 's1', status: 'running' })
  const id = (await remote.status()).devices.at(-1)!.id
  remote.revoke(id)
  assert.equal(await a.closed, 4401)
  assert.equal(await (await connect(token)).closed, 4401)
})

test('a page on another site cannot open the socket', async () => {
  const token = await pair()
  await assert.rejects(connect(token, { Origin: 'https://evil.example.com' }))
  const own = await connect(token, { Origin: `http://127.0.0.1:${PORT}` })
  await until(() => own.msgs.some((m) => m.t === 'ready'))
  own.ws.close()
})
