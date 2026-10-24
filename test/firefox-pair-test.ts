// The signed Firefox extension has no token file: it asks the hub for the token (pairing). Only the extension the user
// paired, or the first one asking while Install is open, may get it; a web page never can.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
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

test('the signed xpi matches the extension folder', { skip: !fs.existsSync('browser-extension-firefox-signed/jolty.xpi') }, async () => {
  // an xpi is a zip: read manifest.json out of it with the platform's own unzip via node's zlib-free approach (adm-zip is not a dependency)
  const { execFileSync } = await import('node:child_process')
  const text = execFileSync('tar', ['-xOf', 'browser-extension-firefox-signed/jolty.xpi', 'manifest.json'], { encoding: 'utf8' })
  const folder = JSON.parse(fs.readFileSync('browser-extension-firefox/manifest.json', 'utf8'))
  assert.equal(JSON.parse(text).version, folder.version, 'sign again after changing the extension')
})
