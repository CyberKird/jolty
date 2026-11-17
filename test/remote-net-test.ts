import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { after, test } from 'node:test'
import { WebSocket } from 'ws'
import { Remote } from '../src/main/remote'
import { DeviceStore } from '../src/main/remote-devices'
import { coalesce, EventLog, Once } from '../src/main/remote-events'

// The phone link on a bad line and through restarts: a phone stays paired whatever happens to the PC's file or process
// (only a revoke unpairs it), it gets exactly the events it missed, streamed text comes in batches, an action sent again
// is not done twice, and a conversation's pictures reach it as small linked copies.

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jolty-remote-net-'))
process.env.JOLTY_DATA_DIR = dir
const web = path.join(dir, 'web')
fs.mkdirSync(path.join(web, 'assets'), { recursive: true })
fs.writeFileSync(path.join(web, 'index.html'), '<html><head></head><body></body></html>')
const PORT = 47991
const file = path.join(dir, 'remote.json')
// enabled, as a PC that has the phone link on; the tests start the local server only (never Tailscale)
fs.writeFileSync(file, JSON.stringify({ enabled: true, port: PORT, devices: [] }))
const listen = (r: Remote): Promise<void> => (r as unknown as { listen(): Promise<void> }).listen()

let sends = 0
function make(): Remote {
  const r = new Remote(undefined, web)
  r.register('sessions:list', () => [{ id: 's1' }])
  r.register('sessions:send', async () => {
    sends++
    await new Promise((res) => setTimeout(res, 150))
    return 'sent'
  })
  r.register('sessions:history', () => history)
  return r
}
let remote = make()
await listen(remote)
after(async () => {
  await remote.stop()
  fs.rmSync(dir, { recursive: true, force: true })
})

// a big screenshot pasted in the chat, an SVG that must not be linked, and a tool that printed a lot
const big = 'data:image/png;base64,' + Buffer.alloc(60_000, 7).toString('base64')
const svg = 'data:image/svg+xml;base64,' + Buffer.from('<svg xmlns="http://www.w3.org/2000/svg">' + ' '.repeat(6000) + '</svg>').toString('base64')
const history = [
  { kind: 'user', id: 'u1', text: 'look', images: [{ name: 'shot.png', dataUrl: big }, { name: 'logo.svg', dataUrl: svg }] },
  { kind: 'tool', id: 't1', name: 'Bash', title: 'build', status: 'done', output: 'x'.repeat(50_000), input: { command: 'y'.repeat(20_000) } }
]

type Reply = { status: number; text: string; headers: http.IncomingHttpHeaders }
function request(opts: http.RequestOptions, body?: string): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: PORT, ...opts }, (res) => {
      const parts: Buffer[] = []
      res.on('data', (c: Buffer) => parts.push(c))
      res.on('end', () => resolve({ status: res.statusCode || 0, text: Buffer.concat(parts).toString('latin1'), headers: res.headers }))
    })
    req.on('error', reject)
    req.end(body)
  })
}

async function pair(): Promise<{ token: string; cookie: string }> {
  const { code } = remote.startPairing()
  const r = await request({ path: '/api/pair', method: 'POST', headers: { 'Content-Type': 'application/json' } }, JSON.stringify({ code, name: 'Net phone' }))
  assert.equal(r.status, 200)
  return { token: JSON.parse(r.text).token, cookie: String(([] as string[]).concat(r.headers['set-cookie'] || [])[0]).split(';')[0] }
}

type M = Record<string, unknown>
interface Conn {
  ws: WebSocket
  msgs: M[]
  closed: Promise<{ code: number; reason: string }>
}
function connect(auth: M, headers: Record<string, string> = {}): Promise<Conn> {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`, { headers })
    const msgs: M[] = []
    const closed = new Promise<{ code: number; reason: string }>((res) => ws.on('close', (code, reason) => res({ code, reason: String(reason) })))
    ws.on('message', (d) => msgs.push(JSON.parse(String(d))))
    ws.on('open', () => {
      ws.send(JSON.stringify({ t: 'auth', ...auth }))
      resolve({ ws, msgs, closed })
    })
    ws.on('error', () => undefined)
  })
}
const until = async (ok: () => boolean, ms = 4000): Promise<void> => {
  const end = Date.now() + ms
  while (!ok()) {
    if (Date.now() > end) throw new Error('timed out')
    await new Promise((r) => setTimeout(r, 15))
  }
}
/** connects and says how it ended: ready, or closed with a code and reason */
async function outcome(auth: M, headers: Record<string, string> = {}): Promise<string> {
  const c = await connect(auth, headers)
  const r = await Promise.race([c.closed.then((x) => `${x.code} ${x.reason}`), until(() => c.msgs.some((m) => m.t === 'ready')).then(() => 'ready')])
  c.ws.close()
  return r
}
/** a new Remote on the same data folder, as after a restart or an update of Jolty */
async function restart(): Promise<void> {
  await remote.stop()
  remote = make()
  await listen(remote)
}

test('a phone stays paired through restarts, torn or rewritten files, a missing data folder and a key kept only as a cookie', async () => {
  const { token, cookie } = await pair()
  assert.equal(await outcome({ token }), 'ready')
  assert.ok(fs.existsSync(`${file}.bak`), 'a copy of the list is kept beside it')

  // Jolty restarts (an update): same key, accepted
  await restart()
  assert.equal(await outcome({ token }), 'ready')

  // the file is rewritten by another process (same content, other layout) while this one runs
  fs.writeFileSync(file, JSON.stringify(JSON.parse(fs.readFileSync(file, 'utf8'))))
  assert.equal(await outcome({ token }), 'ready')

  // a crash left the file torn: the copy beside it is used, right after a restart too
  const whole = fs.readFileSync(file, 'utf8')
  fs.writeFileSync(file, '\0\0\0\0')
  await restart()
  assert.equal(await outcome({ token }), 'ready')

  // the file and its copy unreadable while Jolty runs: a phone not in the last good list gets "try again", never "unknown key"
  const store = new DeviceStore()
  assert.equal(typeof store.whoOf([token]), 'object')
  fs.writeFileSync(`${file}.bak`, '{"enabled": tr')
  fs.writeFileSync(file, '{"enabled": tr')
  assert.equal(typeof store.whoOf([token]), 'object', 'the last good list still knows it')
  assert.equal(store.whoOf(['someone-paired-meanwhile']), 'unavailable')
  // ... and at the start of Jolty: nothing is decided and nothing is written over the file; the server waits for the file
  const fresh = new DeviceStore()
  assert.equal(fresh.whoOf([token]), 'unavailable')
  assert.throws(() => fresh.add('x'), /cannot be read/)
  assert.equal(fs.readFileSync(file, 'utf8'), '{"enabled": tr', 'the unreadable file is left as it is')
  await remote.stop()
  remote = make()
  const starting = remote.init(50)
  await new Promise((r) => setTimeout(r, 300))
  assert.equal((await remote.status()).running, false, 'no server answers "unknown" while the list is unreadable')
  fs.writeFileSync(file, whole)
  await starting
  assert.equal(await outcome({ token }), 'ready', 'the server starts once the file can be read')

  // the data folder is on a drive that is not there yet: "try again", not "nothing was ever paired"
  process.env.JOLTY_DATA_DIR = path.join(dir, 'not-mounted')
  assert.equal(new DeviceStore().whoOf([token]), 'unavailable')
  process.env.JOLTY_DATA_DIR = dir

  // the phone's storage holds an old key, its cookie the right one: the cookie names it
  assert.equal(await outcome({ token: 'old-key-from-before' }, { Cookie: cookie }), 'ready')
  assert.equal(await outcome({ token: '' }, { Cookie: cookie }), 'ready')
  // a key never seen is "unknown key", which the phone does not take as unpaired
  assert.equal(await outcome({ token: 'never-seen' }), '4401 unknown key')

  // the session check renews the cookie from the key the phone keeps
  const renew = await request({ path: '/api/session', method: 'POST', headers: { 'Content-Type': 'application/json' } }, JSON.stringify({ token }))
  assert.equal(renew.status, 200)
  assert.match(String(renew.headers['set-cookie']), new RegExp(`jolty_dev=${token};.*HttpOnly`))
  // a gateway answering for a stopped Jolty is not this server: only a 401 with ok:false means "not paired" (checked by the page)
  const none = await request({ path: '/api/session' })
  assert.equal(none.status, 401)
  assert.deepEqual(JSON.parse(none.text), { ok: false, revoked: false })

  // the last-seen note cannot be written (file read-only): the phone is still let in
  const s = JSON.parse(fs.readFileSync(file, 'utf8'))
  s.devices.forEach((d: { lastSeen?: number }) => (d.lastSeen = 1))
  fs.writeFileSync(file, JSON.stringify(s))
  fs.chmodSync(file, 0o444)
  try {
    await restart()
    assert.equal(await outcome({ token }), 'ready')
  } finally {
    fs.chmodSync(file, 0o644)
  }
})

test('only a revoke at the PC unpairs, and the phone learns it even after a restart', async () => {
  const { token, cookie } = await pair()
  const st = await remote.status()
  const id = st.devices[st.devices.length - 1].id
  remote.revoke(id)
  assert.equal(await outcome({ token }), '4401 revoked')
  await restart()
  assert.equal(await outcome({ token }), '4401 revoked', 'remembered across a restart')
  assert.equal(await outcome({ token: '' }, { Cookie: cookie }), '4401 revoked')
  const r = await request({ path: '/api/session', method: 'POST', headers: { 'Content-Type': 'application/json' } }, JSON.stringify({ token }))
  assert.equal(r.status, 401)
  assert.equal(JSON.parse(r.text).revoked, true)
  assert.match(String(r.headers['set-cookie']), /jolty_dev=;.*Max-Age=0/)
})

test('a phone that comes back gets exactly what it missed; another run of Jolty or a gap too old means a full reload', async () => {
  const { token } = await pair()
  const a = await connect({ token })
  await until(() => a.msgs.some((m) => m.t === 'ready'))
  const ready = a.msgs.find((m) => m.t === 'ready') as { epoch: string; seq: number; resumed: boolean }
  assert.equal(ready.resumed, false)
  remote.broadcast('jolty:event', { type: 'meta', sessionId: 'r1', meta: { id: 'r1' } })
  await until(() => a.msgs.some((m) => m.t === 'ev'))
  const seen = (a.msgs.find((m) => m.t === 'ev') as { s: number }).s
  a.ws.close()
  await a.closed
  // missed while away: a status, a run of streamed text, a question
  remote.broadcast('jolty:event', { type: 'status', sessionId: 'r1', status: 'running' })
  for (const w of ['Hel', 'lo ', 'there']) remote.broadcast('jolty:event', { type: 'delta', sessionId: 'r1', itemId: 'a1', kind: 'assistant', delta: w })
  remote.broadcast('jolty:event', { type: 'permission', sessionId: 'r1', request: { id: 'q1', toolName: 'Bash', title: 'run' } })
  const b = await connect({ token, since: { epoch: ready.epoch, seq: seen } })
  await until(() => b.msgs.some((m) => m.t === 'ready') && b.msgs.some((m) => m.t === 'evs' || m.t === 'ev'))
  await new Promise((r) => setTimeout(r, 150))
  const back = b.msgs.find((m) => m.t === 'ready') as { resumed: boolean }
  assert.equal(back.resumed, true)
  const evs = b.msgs.filter((m) => m.t === 'evs' || m.t === 'ev').flatMap((m) => (m.t === 'evs' ? (m.list as Array<[string, M]>).map((x) => x[1]) : [m.data as M]))
  assert.deepEqual(evs.map((e) => e.type), ['status', 'delta', 'permission'], 'each missed event once, the text joined, nothing else')
  assert.equal(evs[1].delta, 'Hello there')
  b.ws.close()
  // a number from another run of Jolty: no replay, the page reloads its lists
  const c = await connect({ token, since: { epoch: 'another-run', seq: seen } })
  await until(() => c.msgs.some((m) => m.t === 'ready'))
  assert.equal((c.msgs.find((m) => m.t === 'ready') as { resumed: boolean }).resumed, false)
  c.ws.close()
  // the log keeps only so much: a gap older than that is not replayed
  const log = new EventLog()
  for (let i = 0; i < 6000; i++) log.add('jolty:event', { type: 'delta' }, 10)
  assert.equal(log.since(log.epoch, 10), undefined)
  assert.equal(log.since(log.epoch, 5990)?.length, 10)
  assert.equal(log.since(log.epoch, 7000), undefined)
})

test('streamed text is sent in batches, not one message per token, and a file being written keeps only its newest state', async () => {
  const { token } = await pair()
  const c = await connect({ token })
  await until(() => c.msgs.some((m) => m.t === 'ready'))
  const n0 = c.msgs.length
  let text = ''
  for (let i = 0; i < 300; i++) {
    const w = `w${i} `
    text += w
    remote.broadcast('jolty:event', { type: 'delta', sessionId: 'b1', itemId: 'a1', kind: 'assistant', delta: w })
    if (i % 50 === 49) await new Promise((r) => setTimeout(r, 20))
  }
  remote.broadcast('jolty:event', { type: 'status', sessionId: 'b1', status: 'idle' })
  await until(() => c.msgs.some((m) => m.t === 'ev' && (m.data as M).type === 'status' && (m.data as M).sessionId === 'b1'))
  const got = c.msgs.slice(n0)
  const deltas = got.flatMap((m) => (m.t === 'evs' ? (m.list as Array<[string, M]>).map((x) => x[1]) : m.t === 'ev' ? [m.data as M] : [])).filter((e) => e.type === 'delta')
  assert.equal(deltas.map((d) => d.delta).join(''), text, 'all the text, in order, once')
  assert.ok(got.length <= 12, `300 tokens came in ${got.length} messages`)
  c.ws.close()
  const drafts = coalesce([
    ['jolty:event', { type: 'draft', sessionId: 's', toolId: 't', content: 'a', done: false }, 1],
    ['jolty:event', { type: 'delta', sessionId: 's', itemId: 'x', delta: '1' }, 2],
    ['jolty:event', { type: 'draft', sessionId: 's', toolId: 't', content: 'ab', done: false }, 3]
  ])
  assert.deepEqual(drafts.map((d) => d[2]), [2, 3])
})

test('an action sent again with its id after a lost answer is done once, and both tries get the answer', async () => {
  const { token } = await pair()
  const before = sends
  const a = await connect({ token })
  await until(() => a.msgs.some((m) => m.t === 'ready'))
  a.ws.send(JSON.stringify({ t: 'call', id: 1, channel: 'sessions:send', args: ['s1', 'hi'], k: 'act-123456789' }))
  // the line drops before the answer
  await new Promise((r) => setTimeout(r, 30))
  a.ws.terminate()
  const b = await connect({ token })
  await until(() => b.msgs.some((m) => m.t === 'ready'))
  b.ws.send(JSON.stringify({ t: 'call', id: 7, channel: 'sessions:send', args: ['s1', 'hi'], k: 'act-123456789' }))
  await until(() => b.msgs.some((m) => m.t === 'res' && m.id === 7))
  assert.equal((b.msgs.find((m) => m.t === 'res') as { value: string }).value, 'sent')
  assert.equal(sends - before, 1, 'sent once')
  b.ws.close()
  // without an id, or with a failure, it runs again
  const once = new Once()
  let n = 0
  await once.run(undefined, async () => n++)
  await once.run(undefined, async () => n++)
  await once.run('fail-12345678', async () => Promise.reject(new Error('x'))).catch(() => undefined)
  await once.run('fail-12345678', async () => n++)
  assert.equal(n, 3)
})

test('a conversation reaches the phone light: pictures as small linked copies, long tool output shortened', async () => {
  const { token } = await pair()
  const c = await connect({ token })
  await until(() => c.msgs.some((m) => m.t === 'ready'))
  c.ws.send(JSON.stringify({ t: 'call', id: 3, channel: 'sessions:history', args: ['s1'] }))
  await until(() => c.msgs.some((m) => m.t === 'res' && m.id === 3))
  const items = (c.msgs.find((m) => m.t === 'res' && m.id === 3) as { value: Array<M & { images?: Array<{ dataUrl: string }>; output?: string; input?: { command: string } }> }).value
  const link = items[0].images![0].dataUrl
  assert.match(link, /^\/api\/img\/[\w-]{32}$/)
  assert.equal(items[0].images![1].dataUrl, svg, 'an SVG stays inline (never served from this origin)')
  assert.ok(items[1].output!.length < 7000 && items[1].input!.command.length < 7000)
  assert.ok(JSON.stringify(items).length < 30_000, 'the history is a fraction of its size on the PC')
  const img = await request({ path: link })
  assert.equal(img.status, 200)
  assert.match(String(img.headers['content-type']), /^image\//)
  assert.match(String(img.headers['cache-control']), /immutable/)
  assert.equal((await request({ path: '/api/img/' + 'A'.repeat(32) })).status, 404)
  assert.equal((await request({ path: link, headers: { Host: 'evil.example' } })).status, 421)
  // a picture arriving live is linked the same way
  remote.broadcast('jolty:event', { type: 'item', sessionId: 's1', item: history[0] })
  await until(() => c.msgs.some((m) => m.t === 'ev' && (m.data as M).type === 'item'))
  const live = (c.msgs.find((m) => m.t === 'ev' && (m.data as M).type === 'item') as { data: { item: { images: Array<{ dataUrl: string }> } } }).data.item
  assert.equal(live.images[0].dataUrl, link)
  c.ws.close()
})

test('the page names every script the phone will run up front, compressed at its best, and the phone keeps only what it runs', async () => {
  const m = {
    'index.html': { file: 'assets/index-AAAAAAAA.js', imports: ['_i18n-BBBBBBBB.js'], css: ['assets/index-CCCCCCCC.css'] },
    '_i18n-BBBBBBBB.js': { file: 'assets/i18n-BBBBBBBB.js' },
    'src/App.tsx': { file: 'assets/App-DDDDDDDD.js', imports: ['_i18n-BBBBBBBB.js', '_store-EEEEEEEE.js'], css: ['assets/App-FFFFFFFF.css'] },
    '_store-EEEEEEEE.js': { file: 'assets/store-EEEEEEEE.js' },
    'src/remote/boot.ts': { file: 'assets/boot-GGGGGGGG.js' },
    '../shared/locales/en.json': { file: 'assets/en-HHHHHHHH.js' },
    '../shared/locales/de.json': { file: 'assets/de-IIIIIIII.js' },
    'src/mascot/Rig3D.tsx': { file: 'assets/Rig3D-JJJJJJJJ.js' }
  }
  fs.writeFileSync(path.join(web, 'build-manifest.json'), JSON.stringify(m))
  for (const f of ['Mascot-KKKKKKKK.js', 'barlow-latin-400-normal-LLLLLLLL.woff', 'barlow-latin-400-normal-LLLLLLLL.woff2', 'App-DDDDDDDD.js']) fs.writeFileSync(path.join(web, 'assets', f), 'x')
  fs.writeFileSync(path.join(web, 'assets', 'Chat-MMMMMMMM.js'), 'export const chat = "jolty chat jolty chat";\n'.repeat(2000))
  const page = (await request({ path: '/' })).text
  for (const f of ['App-DDDDDDDD.js', 'store-EEEEEEEE.js', 'boot-GGGGGGGG.js']) assert.ok(page.includes(`<link rel="modulepreload" crossorigin href="/assets/${f}">`), `${f} is named up front`)
  assert.ok(page.includes('href="/assets/App-FFFFFFFF.css"'))
  assert.ok(!page.includes('i18n-BBBBBBBB.js"') || page.split('i18n-BBBBBBBB.js').length === 1, 'what the entry already imports is not named twice')
  for (const f of ['Rig3D', 'de-IIIIIIII']) assert.ok(!page.includes(f), `${f} is not preloaded`)
  // the build's bookkeeping files under a dot folder are not served
  fs.mkdirSync(path.join(web, '.vite'), { recursive: true })
  fs.writeFileSync(path.join(web, '.vite', 'manifest.json'), '{}')
  assert.equal((await request({ path: '/.vite/manifest.json' })).status, 404)
  // brotli at its best: smaller than the old setting
  const big = await request({ path: '/assets/Chat-MMMMMMMM.js', headers: { 'Accept-Encoding': 'br' } })
  assert.equal(big.headers['content-encoding'], 'br')
  assert.match(String(big.headers['cache-control']), /immutable/)
  const shell = JSON.parse((await request({ path: '/shell.json' })).text) as string[]
  assert.ok(shell.includes('/assets/barlow-latin-400-normal-LLLLLLLL.woff2'))
  for (const f of ['Mascot-KKKKKKKK.js', 'barlow-latin-400-normal-LLLLLLLL.woff']) assert.ok(!shell.includes(`/assets/${f}`), `${f} is not kept on the phone`)
})
