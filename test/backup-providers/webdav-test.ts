// The WebDAV backup provider against a local WebDAV mock; the address comes from the user, so it is in the config.
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import test from 'node:test'
import { PRIVATE_HOST, webdav } from '../../src/main/backup/providers/webdav'
import { BackupError } from '../../src/main/backup/types'
import { A, B, startWebdavMock } from '../mocks/webdav-mock.mjs'

const mock = await startWebdavMock()
test.after(() => mock.server.close())

const cfgA = { url: `${mock.url}/dav/files/ana/Jolty/`, user: A.user, password: A.password }
const cfgB = { url: `${mock.url}/dav/files/bob/Jolty`, user: B.user, password: B.password }
const open = (): void => assert.fail('WebDAV does not open a browser')

test('the fields describe a credentials provider', () => {
  const info = webdav.info()
  assert.equal(info.kind, 'credentials')
  assert.equal(info.fields.find((f) => f.key === 'password')?.secret, true)
  assert.match(info.help, /Nextcloud/)
})

test('connect, store, replace and read back 3 MB', async () => {
  const who = await webdav.connect(cfgA, open)
  assert.deepEqual(who, { sub: `${mock.url}/dav/files/ana/jolty/|ana`, label: `ana@127.0.0.1:${new URL(mock.url).port}`, name: 'ana' })
  assert.equal(await webdav.find(cfgA), null)
  await assert.rejects(webdav.get(cfgA), /niciun backup/i)

  const first = randomBytes(3 * 1024 * 1024)
  await webdav.put(cfgA, first)
  const found = await webdav.find(cfgA)
  assert.equal(found?.bytes, first.length)
  assert.ok(found && Math.abs(found.modifiedAt - Date.now()) < 60_000)
  assert.ok((await webdav.get(cfgA)).equals(first))

  const second = randomBytes(2 * 1024 * 1024 + 5)
  await webdav.put(cfgA, second)
  assert.equal((await webdav.find(cfgA))?.bytes, second.length)
  assert.ok((await webdav.get(cfgA)).equals(second))
  assert.equal([...mock.files.keys()].length, 1)
})

test('a second user has his own storage, a missing folder is created once, and the first user is out of reach', async () => {
  assert.equal(mock.collections.has('/dav/files/bob/Jolty/'), false)
  const who = await webdav.connect(cfgB, open)
  assert.equal(who.sub, `${mock.url}/dav/files/bob/jolty/|bob`, 'an address without the last slash is the same folder')
  assert.ok(mock.collections.has('/dav/files/bob/Jolty/'))
  assert.equal(await webdav.find(cfgB), null, 'default-namespace answers parse too')
  await webdav.put(cfgB, Buffer.from('bob data'))
  assert.equal((await webdav.find(cfgB))?.bytes, 8)
  assert.equal((await webdav.get(cfgB)).toString(), 'bob data')
  assert.notEqual((await webdav.get(cfgA)).toString(), 'bob data')

  const peek = { ...cfgB, url: cfgA.url }
  await assert.rejects(webdav.connect(peek, open), BackupError)
  await assert.rejects(webdav.get(peek), BackupError)
  await assert.rejects(webdav.put(peek, Buffer.from('x')), BackupError)
})

test('bad credentials, a missing folder and plain http over the internet are refused', async () => {
  await assert.rejects(webdav.connect({ ...cfgA, password: 'wrong' }, open), (e) => e instanceof BackupError && /parola/i.test(e.message))
  await assert.rejects(webdav.connect({ ...cfgA, user: 'nobody' }, open), BackupError)
  await assert.rejects(webdav.connect({ ...cfgA, url: `${mock.url}/dav/files/ana/Nope/Deeper/` }, open), (e) => e instanceof BackupError && /Folderul/.test(e.message))
  await assert.rejects(webdav.connect({ ...cfgA, url: 'not a url' }, open), BackupError)
  await assert.rejects(webdav.connect({ ...cfgA, url: 'ftp://127.0.0.1/x/' }, open), BackupError)
  for (const bad of ['http://cloud.example.com/dav/', 'http://8.8.8.8/dav/', 'http://172.32.0.1/dav/', 'http://notlocal.com/dav/'])
    await assert.rejects(webdav.connect({ ...cfgA, url: bad }, open), (e) => e instanceof BackupError && /https/.test(e.message), bad)
  // the hosts where the password may travel over http; a closed local port fails at the connection, not at the check
  for (const ok of ['localhost', '[::1]', '127.0.0.1', '10.1.2.3', '192.168.1.5', '172.16.0.1', '172.31.255.1', 'nas.local']) assert.ok(PRIVATE_HOST.test(ok), ok)
  for (const bad of ['example.com', '8.8.8.8', '172.32.0.1', '172.15.0.1', '11.0.0.1', 'local.example.com']) assert.ok(!PRIVATE_HOST.test(bad), bad)
  for (const ok of ['http://localhost:1/x/', 'http://127.0.0.1:1/x/', 'http://[::1]:1/x/'])
    await assert.rejects(webdav.connect({ ...cfgA, url: ok }, open), (e) => e instanceof BackupError && !/https/.test(e.message), ok)
})
