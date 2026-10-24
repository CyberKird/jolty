// The signed Firefox extension has no token file: it asks the hub for the token (pairing). Only the extension the user
// paired, or the first one asking while Install is open, may get it; a web page never can.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import zlib from 'node:zlib'
import { test } from 'node:test'
import { BrowserHub } from '../src/main/jbrowser/hub'

const EXT = 'moz-extension://11111111-2222-3333-4444-555555555555'
const OTHER = 'moz-extension://aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'

test('pairing hands the token only to the paired extension', async () => {
  let paired: string | undefined
  const hub = new BrowserHub({ token: () => 'secret-token', bundledVersion: () => '1', mcp: async () => undefined, paired: { get: () => paired, set: (o) => (paired = o) } })
  const port = await hub.start()
  const ask = (origin?: string) => fetch(`http://127.0.0.1:${port}/jolty-pair`, { method: 'POST', headers: origin ? { origin } : {} })
  try {
    assert.equal((await ask(EXT)).status, 403, 'closed pairing')
    hub.openPairing()
    assert.equal((await ask('https://evil.example')).status, 403, 'a web page')
    assert.equal((await ask()).status, 403, 'no origin')
    assert.equal((await ask('chrome-extension://abcdefghijklmnopabcdefghijklmnop')).status, 403, 'not Firefox')
    const ok = await ask(EXT)
    assert.equal(ok.status, 200)
    assert.equal(ok.headers.get('access-control-allow-origin'), EXT)
    assert.deepEqual(await ok.json(), { token: 'secret-token' })
    assert.equal(paired, EXT)
    // pairing closes after one extension; the paired one can ask again, another cannot
    assert.equal((await ask(OTHER)).status, 403)
    assert.equal((await ask(EXT)).status, 200)
    // Install again (new Firefox profile): the next extension replaces the old pairing
    hub.openPairing()
    assert.equal((await ask(OTHER)).status, 200)
    assert.equal(paired, OTHER)
    assert.equal((await ask(EXT)).status, 403)
    // a rebound DNS name is refused like everywhere else
    const status = await new Promise<number>((resolve, reject) =>
      http.request({ host: '127.0.0.1', port, path: '/jolty-pair', method: 'POST', headers: { host: 'evil.example:1', origin: OTHER } }, (r) => resolve(r.statusCode || 0)).on('error', reject).end()
    )
    assert.equal(status, 421)
  } finally {
    await hub.stop()
  }
})

/** The files of a zip (an xpi), read through its central directory. */
function unzip(file: string): Map<string, Buffer> {
  const buf = fs.readFileSync(file)
  const files = new Map<string, Buffer>()
  let at = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 5, 6]))
  const count = buf.readUInt16LE(at + 10)
  at = buf.readUInt32LE(at + 16)
  for (let i = 0; i < count; i++) {
    const method = buf.readUInt16LE(at + 10)
    const size = buf.readUInt32LE(at + 20)
    const nameLen = buf.readUInt16LE(at + 28)
    const extra = buf.readUInt16LE(at + 30) + buf.readUInt16LE(at + 32)
    const local = buf.readUInt32LE(at + 42)
    const name = buf.toString('utf8', at + 46, at + 46 + nameLen)
    const data = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28)
    const raw = buf.subarray(data, data + size)
    files.set(name, method === 8 ? zlib.inflateRawSync(raw) : raw)
    at += 46 + nameLen + extra
  }
  return files
}

test('the signed xpi is the extension folder, signed', { skip: !fs.existsSync('browser-extension-firefox-signed/jolty.xpi') }, () => {
  const xpi = unzip('browser-extension-firefox-signed/jolty.xpi')
  for (const name of fs.readdirSync('browser-extension-firefox')) {
    const mine = fs.readFileSync(`browser-extension-firefox/${name}`)
    // web-ext rewrites the manifest's whitespace; the content must be the same
    const same = name === 'manifest.json' ? xpi.has(name) && JSON.stringify(JSON.parse(xpi.get(name)!.toString())) === JSON.stringify(JSON.parse(mine.toString())) : !!xpi.get(name)?.equals(mine)
    assert.ok(same, `${name} differs: bump the version in manifest.json and sign again (node scripts/sign-firefox.mjs)`)
  }
  assert.ok(xpi.has('META-INF/mozilla.rsa'), 'not signed')
  assert.ok(!xpi.has('config.json'), 'a token file inside a signed add-on')
})
