import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import zlib from 'node:zlib'
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
// a script big enough to be worth compressing, and files the phone does not keep (the 3D character, another language's dictionary)
fs.writeFileSync(path.join(web, 'assets', 'big-AbCd1234.js'), 'export const t = "jolty jolty jolty jolty";\n'.repeat(400))
fs.writeFileSync(path.join(web, 'assets', 'Rig3D-AbCd1234.js'), 'y')
fs.writeFileSync(path.join(web, 'assets', 'de-AbCd1234.js'), 'y')
fs.writeFileSync(path.join(web, 'sw.js'), "const CACHE = 'jolty-shell-__VERSION__'")
fs.writeFileSync(path.join(dir, 'secret.txt'), 'secret')

const PORT = 47990
fs.writeFileSync(path.join(dir, 'remote.json'), JSON.stringify({ enabled: false, port: PORT, devices: [] }))
const remote = new Remote(undefined, web)
const calls: unknown[][] = []
remote.register('sessions:list', () => [{ id: 's1' }])
remote.register('sessions:setComputer', (...a) => (calls.push(a), undefined))
remote.register('power:arm', () => undefined)
remote.register('sessions:send', (...a) => (calls.push(a), undefined))
remote.register('sessions:setPermissionMode', (...a) => (calls.push(a), undefined))
remote.register('sessions:start', (...a) => (calls.push(a), { id: 'new' }))
remote.register('app:saveSettings', (...a) => (calls.push(a), {}))
remote.register('sessions:handoff', (...a) => (calls.push(a), { id: 'handed' }))
remote.register('browser:info', () => ({ mode: 'jolty' }))
remote.register('remote:wakeConfig', () => remote.wakeConfig())
remote.register('remote:wakeSet', () => 'nope')
remote.register('remote:wakeStatus', () => 'nope')
remote.register('app:copyText', () => 'pc clipboard')
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

test('only listed channels, never the desktop ones', async () => {
  const c = await connect(await pair())
  await until(() => c.msgs.some((m) => m.t === 'ready'))
  assert.equal((await ask(c, 1, 'app:pickFolder', [])).ok, false)
  assert.equal((await ask(c, 2, 'remote:enable', [true])).ok, false)
  assert.equal((await ask(c, 3, 'sessions:setPermissionMode', ['s1', 'full'])).ok, true, 'the owner can pick No permissions on the phone')
  assert.equal((await ask(c, 4, 'sessions:setPermissionMode', ['s1', 'project'])).ok, true)
  assert.equal((await ask(c, 5, 'sessions:setPermissionMode', ['s1', 'ask'])).ok, true)
  assert.equal((await ask(c, 6, 'sessions:start', [{ profileId: 'p', cwd: 'C:\\x', permissionMode: 'full' }])).ok, true)
  assert.equal((await ask(c, 7, 'sessions:start', [{ profileId: 'p', cwd: 'C:\\x', permissionMode: 'autoEdit' }])).ok, true)
  assert.equal((await ask(c, 12, 'sessions:handoff', ['s1', 'p2', undefined, undefined, true])).ok, true, 'continue in another model works')
  assert.equal((await ask(c, 13, 'browser:info', [])).ok, true)
  assert.equal((await ask(c, 14, 'app:copyText', ['x'])).ok, false, 'the PC clipboard is not the phone clipboard')
  assert.equal((await ask(c, 11, 'power:arm', [true, {}])).ok, true, 'the PC can be shut down from the phone')
  assert.equal((await ask(c, 10, 'sessions:setComputer', ['s1', true])).ok, true, 'the PC can be driven from the phone')
  assert.deepEqual(calls.at(-1), ['s1', true])
  assert.equal((await ask(c, 8, 'sessions:send', ['s1', 'hello', [], false])).ok, true)
  assert.deepEqual(calls.at(-1), ['s1', 'hello', [], false])
  await ask(c, 9, 'app:saveSettings', [{ theme: 'glass', browserMode: 'own', siteTrust: 'free', browserApp: 'chrome', childMode: 'ask', remoteScreen: true, dataDir: 'x' }])
  assert.deepEqual(calls.at(-1), [{ theme: 'glass', browserMode: 'own', siteTrust: 'free', browserApp: 'chrome', childMode: 'ask' }], 'every preference passes except the PC\'s own doors')
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

test('a phone that connects mid-turn is told what is running and what waits for a yes', async () => {
  remote.broadcast('jolty:event', { type: 'status', sessionId: 's1', status: 'idle' })
  remote.broadcast('jolty:event', { type: 'status', sessionId: 'run1', status: 'running' })
  remote.broadcast('jolty:event', { type: 'status', sessionId: 'run2', status: 'running' })
  remote.broadcast('jolty:event', { type: 'permission', sessionId: 'run1', request: { id: 'q1', title: 'Allow?' } })
  remote.broadcast('jolty:event', { type: 'status', sessionId: 'run2', status: 'idle' })
  const c = await connect(await pair())
  await until(() => c.msgs.some((m) => m.t === 'ready') && c.msgs.some((m) => (m.data as { type?: string })?.type === 'permission'))
  const events = c.msgs.filter((m) => m.t === 'ev').map((m) => m.data as { type: string; sessionId: string; status?: string })
  assert.ok(events.some((e) => e.type === 'status' && e.sessionId === 'run1' && e.status === 'running'))
  assert.ok(!events.some((e) => e.sessionId === 'run2'), 'a finished turn is not replayed')
  remote.broadcast('jolty:event', { type: 'permissionResolved', sessionId: 'run1', requestId: 'q1' })
  remote.broadcast('jolty:event', { type: 'status', sessionId: 'run1', status: 'idle' })
  const later = await connect(await pair())
  await until(() => later.msgs.some((m) => m.t === 'ready'))
  await new Promise((r) => setTimeout(r, 100))
  assert.equal(later.msgs.filter((m) => m.t === 'ev').length, 0, 'nothing left to replay')
  c.ws.close()
  later.ws.close()
})

test('the page is kept for offline starts: the service worker is served fresh with the version in its cache name', async () => {
  const r = await request({ path: '/sw.js' })
  assert.equal(r.status, 200)
  assert.match(r.text, /jolty-shell-dev/)
  assert.doesNotMatch(r.text, /__VERSION__/)
  assert.match(String(r.headers['cache-control']), /no-cache/)
  assert.equal(r.headers['service-worker-allowed'], '/')
})

/** One GET with the bytes as they came (the compressed body is not text). */
function raw(p: string, headers: Record<string, string> = {}): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: Buffer }> {
  return new Promise((resolve, reject) => {
    http
      .get({ host: '127.0.0.1', port: PORT, path: p, headers }, (res) => {
        const parts: Buffer[] = []
        res.on('data', (c: Buffer) => parts.push(c))
        res.on('end', () => resolve({ status: res.statusCode || 0, headers: res.headers, body: Buffer.concat(parts) }))
      })
      .on('error', reject)
  })
}

test('on a slow line the page comes compressed, and a visit again gets "not modified" instead of the file', async () => {
  const plain = await raw('/assets/big-AbCd1234.js')
  assert.equal(plain.headers['content-encoding'], undefined)
  assert.ok(plain.body.length > 10_000)
  const br = await raw('/assets/big-AbCd1234.js', { 'Accept-Encoding': 'gzip, br' })
  assert.equal(br.headers['content-encoding'], 'br')
  assert.ok(br.body.length < plain.body.length / 10, 'much smaller')
  assert.equal(zlib.brotliDecompressSync(br.body).toString(), plain.body.toString())
  const gz = await raw('/assets/big-AbCd1234.js', { 'Accept-Encoding': 'gzip' })
  assert.equal(gz.headers['content-encoding'], 'gzip')
  assert.equal(zlib.gunzipSync(gz.body).toString(), plain.body.toString())
  assert.match(String(br.headers.vary), /Accept-Encoding/)
  // the page itself is checked again each visit, and answers 304 when it has not changed
  const first = await raw('/')
  assert.ok(first.headers.etag)
  const again = await raw('/', { 'If-None-Match': String(first.headers.etag) })
  assert.equal(again.status, 304)
  assert.equal(again.body.length, 0)
})

test('the list of files the phone keeps leaves out the 3D character and other languages', async () => {
  const list = JSON.parse((await raw('/shell.json')).body.toString()) as string[]
  assert.ok(list.includes('/assets/big-AbCd1234.js'))
  assert.ok(!list.some((f) => f.includes('Rig3D')))
  assert.ok(!list.some((f) => f.includes('/de-')))
})

test('the phone can ask whether the line is alive, and the PC answers', async () => {
  const c = await connect(await pair())
  await until(() => c.msgs.some((m) => m.t === 'ready'))
  c.ws.send(JSON.stringify({ t: 'ping' }))
  await until(() => c.msgs.some((m) => m.t === 'pong'))
  c.ws.close()
})

test('the wake agent: only https addresses, a shared secret, allowed in the page policy, and phones get the way to wake but cannot change it', async () => {
  await assert.rejects(remote.wakeSet('http://box.tailnet.ts.net'), /https/)
  await assert.rejects(remote.wakeSet('not an address'))
  assert.equal(remote.wakeConfig(), null, 'nothing until an address is set')
  const w = await remote.wakeSet('https://box.tailnet.ts.net:8443/anything')
  assert.equal(w.url, 'https://box.tailnet.ts.net:8443')
  assert.ok(w.token.length >= 24)
  assert.deepEqual(remote.wakeConfig(), { url: 'https://box.tailnet.ts.net:8443', token: w.token })
  assert.equal((await remote.wakeSet('https://box.tailnet.ts.net:8443')).token, w.token, 'the secret stays')
  const page = await request({ path: '/', headers: { Host: `127.0.0.1:${PORT}` } })
  assert.match(page.text, /connect-src 'self' blob: wss:\/\/127\.0\.0\.1:\d+ ws:\/\/127\.0\.0\.1:\d+ https:\/\/box\.tailnet\.ts\.net:8443/)
  const c = await connect(await pair())
  await until(() => c.msgs.some((m) => m.t === 'ready'))
  assert.equal((await ask(c, 31, 'remote:wakeConfig', [])).ok, true)
  assert.equal((await ask(c, 32, 'remote:wakeSet', ['https://evil.example.com'])).ok, false)
  assert.equal((await ask(c, 33, 'remote:wakeStatus', [])).ok, false, 'the secret is not read from a phone by name')
  c.ws.close()
})
