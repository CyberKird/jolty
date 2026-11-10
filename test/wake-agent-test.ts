import assert from 'node:assert/strict'
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import dgram from 'node:dgram'
import http from 'node:http'
import path from 'node:path'
import { after, before, test } from 'node:test'

// the wake agent (tools/wake-agent.py): the right packet, only for the right token and origin
const python = ['python3', 'python'].find((p) => spawnSync(p, ['--version']).status === 0)
const PORT = 48731
const TOKEN = 'a-long-enough-secret-token'
const ORIGIN = 'https://my-pc.tailnet.ts.net'
const MAC = '60:CF:84:C8:F3:48'
let child: ChildProcess | undefined
const udp = dgram.createSocket('udp4')
const packets: Buffer[] = []
let udpPort = 0

function call(method: string, p: string, headers: Record<string, string> = {}): Promise<{ status: number; body: Record<string, unknown>; headers: http.IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: PORT, path: p, method, headers }, (res) => {
      let t = ''
      res.on('data', (c) => (t += c))
      res.on('end', () => resolve({ status: res.statusCode || 0, body: t ? JSON.parse(t) : {}, headers: res.headers }))
    })
    req.on('error', reject)
    req.end()
  })
}

before(async () => {
  if (!python) return
  udp.on('message', (m) => packets.push(m))
  await new Promise<void>((r) => udp.bind(0, '127.0.0.1', () => r()))
  udpPort = udp.address().port
  child = spawn(python, [path.resolve('tools/wake-agent.py'), '--mac', MAC, '--token', TOKEN, '--origin', ORIGIN, '--port', String(PORT), '--broadcast', '127.0.0.1', '--wol-port', String(udpPort)], { stdio: 'ignore' })
  for (let i = 0; i < 50; i++) {
    try {
      await call('GET', '/ping')
      break
    } catch {
      await new Promise((r) => setTimeout(r, 100))
    }
  }
})

after(() => {
  child?.kill()
  udp.close()
})

test('sends a magic packet: six 0xFF then the MAC sixteen times', { skip: !python && 'python is not installed' }, async () => {
  const r = await call('POST', '/wake', { Authorization: `Bearer ${TOKEN}`, Origin: ORIGIN })
  assert.equal(r.status, 200)
  assert.equal(r.headers['access-control-allow-origin'], ORIGIN)
  for (let i = 0; i < 50 && !packets.length; i++) await new Promise((x) => setTimeout(x, 40))
  assert.equal(packets.length, 1)
  const mac = Buffer.from(MAC.replace(/:/g, ''), 'hex')
  assert.deepEqual(packets[0], Buffer.concat([Buffer.alloc(6, 0xff), ...Array.from({ length: 16 }, () => mac)]))
})

test('refuses a missing or wrong token, and sends nothing', { skip: !python && 'python is not installed' }, async () => {
  const before = packets.length
  assert.equal((await call('POST', '/wake')).status, 401)
  assert.equal((await call('POST', '/wake', { Authorization: 'Bearer nope' })).status, 401)
  assert.equal((await call('GET', '/ping')).status, 401)
  await new Promise((x) => setTimeout(x, 150))
  assert.equal(packets.length, before)
})

test('answers CORS only for the PC page, and ping tells the MAC', { skip: !python && 'python is not installed' }, async () => {
  const other = await call('OPTIONS', '/wake', { Origin: 'https://evil.example.com' })
  assert.equal(other.headers['access-control-allow-origin'], undefined)
  const own = await call('OPTIONS', '/wake', { Origin: ORIGIN })
  assert.equal(own.status, 204)
  assert.equal(own.headers['access-control-allow-origin'], ORIGIN)
  const ping = await call('GET', '/ping', { Authorization: `Bearer ${TOKEN}` })
  assert.equal(ping.body.mac, MAC)
})

test('too many wakes in a minute are held back', { skip: !python && 'python is not installed' }, async () => {
  let last = 200
  for (let i = 0; i < 14; i++) last = (await call('POST', '/wake', { Authorization: `Bearer ${TOKEN}` })).status
  assert.equal(last, 429)
})
