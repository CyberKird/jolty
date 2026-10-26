// Box backup provider against a local Box (test/mocks/box-mock.mjs): sign-in with the client secret and no PKCE on the
// fixed redirect, one file per account found by name in a paged root listing, multipart create and replace, the
// download redirect followed without the token, and the single-use refresh token that rotates.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { box } from '../../src/main/backup/providers/box'
import { getSecret } from '../../src/main/store'
import { A, B, CLIENT, SECRET, startBoxMock } from '../mocks/box-mock.mjs'

const mock = await startBoxMock()
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jolty-box-'))
process.env.JOLTY_BACKUP_MOCK = mock.url
process.env.JOLTY_DATA_DIR = tmp
test.after(() => {
  mock.server.close()
  fs.rmSync(tmp, { recursive: true, force: true })
})

const cfg = { clientId: CLIENT, clientSecret: SECRET }
/** Opening the sign-in page: the test is the browser, it follows the redirect back to the loopback port. */
const browser = async (url: string): Promise<void> => void (await fetch(url))
const signIn = (a: typeof A) => {
  mock.state.next = a
  return box.connect(cfg, browser)
}

test('info asks for the client id and a secret and names the redirect', () => {
  const i = box.info()
  assert.equal(i.kind, 'oauth')
  assert.deepEqual(i.fields.map((f) => [f.key, !!f.secret]), [['clientId', false], ['clientSecret', true]])
  assert.match(i.help, /127\.0\.0\.1:53683/)
})

test('connect, find, put, get, replace, disconnect', async () => {
  assert.deepEqual(await signIn(A), { sub: A.id, label: A.login, name: 'Ana' })
  assert.equal(await box.find(cfg), null, 'a folder and a file with similar names are not the backup')
  await assert.rejects(box.get(cfg), /niciun backup/i)

  const first = Buffer.from('first backup \u0000ÿ\r\n--x bytes')
  await box.put(cfg, first)
  const found = await box.find(cfg)
  assert.equal(found?.bytes, first.length)
  assert.ok(Math.abs(found!.modifiedAt - Date.now()) < 60_000)
  mock.state.downloadAuth.length = 0
  assert.deepEqual(await box.get(cfg), first)
  assert.deepEqual(mock.state.downloadAuth, [undefined], 'the temporary download address gets no bearer token')

  const id = mock.files.get(A.id).id
  const second = Buffer.from('a second, longer backup that replaces the first one')
  await box.put(cfg, second)
  assert.equal(mock.files.size, 1)
  assert.equal(mock.files.get(A.id).id, id, 'a new version of the same file, not a second file')
  assert.deepEqual(await box.get(cfg), second)
  assert.equal((await box.find(cfg))?.bytes, second.length)

  await box.disconnect?.(cfg)
  assert.equal(getSecret('backup:box:refresh'), undefined)
  await assert.rejects(box.find(cfg), /conectat/i)
})

test('the file is found on a later page of the listing', async () => {
  await signIn(A)
  mock.state.pageSize = 1
  assert.equal((await box.find(cfg))?.bytes, (await box.get(cfg)).length)
  mock.state.pageSize = 2
  await box.put(cfg, Buffer.from('paged'))
  assert.deepEqual(await box.get(cfg), Buffer.from('paged'))
  assert.equal(mock.files.size, 1)
  mock.state.pageSize = 1000
})

test('a second account has its own empty storage and cannot read the first', async () => {
  await signIn(A)
  const ana = Buffer.from('ana only')
  await box.put(cfg, ana)

  assert.equal((await signIn(B)).sub, B.id)
  assert.equal(await box.find(cfg), null)
  await assert.rejects(box.get(cfg), /niciun backup/i)
  await box.put(cfg, Buffer.from('bob only'))
  assert.equal(mock.files.size, 2)
  assert.deepEqual(mock.files.get(A.id).data, ana, "Bob's backup left Ana's file alone")

  await signIn(A)
  assert.deepEqual(await box.get(cfg), ana)
})

test('a refused token is retried once and the rotated refresh token is stored', async () => {
  await signIn(A)
  const before = getSecret('backup:box:refresh')
  mock.state.fail401 = 1
  await box.put(cfg, Buffer.from('after a 401'))
  assert.equal(mock.state.fail401, 0)
  const after = getSecret('backup:box:refresh')
  assert.ok(after && after !== before, 'the new refresh token replaced the used one')
  assert.ok(mock.refreshes.has(after), 'and it is the one Box knows')
  assert.ok(!mock.refreshes.has(before!), 'a used refresh token is dead at Box')
  assert.deepEqual(await box.get(cfg), Buffer.from('after a 401'))
  mock.state.fail401 = 2
  await assert.rejects(box.find(cfg), /401/)
  mock.state.fail401 = 0
})

test('a download that is not ready yet (202) is retried', async () => {
  await signIn(A)
  await box.put(cfg, Buffer.from('fresh'))
  mock.state.defer202 = 1
  assert.deepEqual(await box.get(cfg), Buffer.from('fresh'))
  assert.equal(mock.state.defer202, 0)
})

test('a backup over the single upload limit is refused before anything is sent', async () => {
  await signIn(A)
  await assert.rejects(box.put(cfg, Buffer.alloc(50 * 1000 * 1000 + 1)), /prea mare/)
})
