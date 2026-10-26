// Dropbox backup provider against a local Dropbox (test/mocks/dropbox-mock.mjs): sign-in with PKCE and no secret on the
// fixed redirect, one file per account in the app folder, a refused token retried once, and disconnect.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { dropbox } from '../../src/main/backup/providers/dropbox'
import { getSecret } from '../../src/main/store'
import { A, B, KEY, startDropboxMock } from '../mocks/dropbox-mock.mjs'

const mock = await startDropboxMock()
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jolty-dropbox-'))
process.env.JOLTY_BACKUP_MOCK = mock.url
process.env.JOLTY_DATA_DIR = tmp
test.after(() => {
  mock.server.close()
  fs.rmSync(tmp, { recursive: true, force: true })
})

const cfg = { clientId: KEY }
/** Opening the sign-in page: the test is the browser, it follows the redirect back to the loopback port. */
const browser = async (url: string): Promise<void> => void (await fetch(url))
const signIn = (a: typeof A) => {
  mock.state.next = a
  return dropbox.connect(cfg, browser)
}

test('info asks for the app key only and names the redirect', () => {
  const i = dropbox.info()
  assert.equal(i.kind, 'oauth')
  assert.deepEqual(i.fields.map((f) => f.key), ['clientId'])
  assert.ok(!i.fields.some((f) => f.secret))
  assert.match(i.help, /127\.0\.0\.1:53682/)
})

test('connect, find, put, get, replace, disconnect', async () => {
  const who = await signIn(A)
  assert.deepEqual(who, { sub: A.account_id, label: A.email, name: 'Ana' })
  assert.equal(await dropbox.find(cfg), null)
  await assert.rejects(dropbox.get(cfg), /niciun backup/i)

  const first = Buffer.from('first backup \u0000ÿ bytes')
  await dropbox.put(cfg, first)
  const found = await dropbox.find(cfg)
  assert.equal(found?.bytes, first.length)
  assert.ok(Math.abs(found!.modifiedAt - Date.now()) < 60_000)
  assert.deepEqual(await dropbox.get(cfg), first)

  const second = Buffer.from('a second, longer backup that replaces the first one')
  await dropbox.put(cfg, second)
  assert.equal(mock.files.size, 1)
  assert.deepEqual(await dropbox.get(cfg), second)
  assert.equal((await dropbox.find(cfg))?.bytes, second.length)

  await dropbox.disconnect?.(cfg)
  assert.equal(mock.revoked.length, 1, 'the token is revoked at Dropbox')
  assert.equal(getSecret('backup:dropbox:refresh'), undefined)
  await assert.rejects(dropbox.find(cfg), /conectat/i)
})

test('a second account has its own empty storage and cannot read the first', async () => {
  await signIn(A)
  const ana = Buffer.from('ana only')
  await dropbox.put(cfg, ana)

  const who = await signIn(B)
  assert.equal(who.sub, B.account_id)
  assert.equal(await dropbox.find(cfg), null)
  await assert.rejects(dropbox.get(cfg), /niciun backup/i)
  await dropbox.put(cfg, Buffer.from('bob only'))
  assert.equal(mock.files.size, 2)
  assert.deepEqual(mock.files.get(A.account_id).data, ana, "Bob's backup left Ana's file alone")

  await signIn(A)
  assert.deepEqual(await dropbox.get(cfg), ana)
})

test('a refused token is retried once with a new one', async () => {
  await signIn(A)
  mock.state.fail401 = 1
  await dropbox.put(cfg, Buffer.from('after a 401'))
  assert.equal(mock.state.fail401, 0)
  assert.deepEqual(await dropbox.get(cfg), Buffer.from('after a 401'))
  // refused twice in a row: gives up with an error instead of looping
  mock.state.fail401 = 2
  await assert.rejects(dropbox.find(cfg), /401/)
  mock.state.fail401 = 0
})

test('a backup over the upload limit is refused before anything is sent', async () => {
  await signIn(A)
  await assert.rejects(dropbox.put(cfg, Buffer.alloc(150 * 1024 * 1024 + 1)), /prea mare/)
})
