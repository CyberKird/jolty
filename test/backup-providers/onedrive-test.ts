// OneDrive backup provider against a local Microsoft (test/mocks/onedrive-mock.mjs): sign-in with PKCE on
// http://localhost without a secret, one file per account in the app folder, the download redirect followed without the
// token, a refused token retried once, and the rotated refresh token kept.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { onedrive } from '../../src/main/backup/providers/onedrive'
import { getSecret } from '../../src/main/store'
import { A, B, CLIENT, startOneDriveMock } from '../mocks/onedrive-mock.mjs'

const mock = await startOneDriveMock()
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jolty-onedrive-'))
process.env.JOLTY_BACKUP_MOCK = mock.url
process.env.JOLTY_DATA_DIR = tmp
test.after(() => {
  mock.server.close()
  fs.rmSync(tmp, { recursive: true, force: true })
})

const cfg = { clientId: CLIENT }
/** Opening the sign-in page: the test is the browser, it follows the redirect back to the loopback port. */
const browser = async (url: string): Promise<void> => void (await fetch(url))
const signIn = (a: typeof A) => {
  mock.state.next = a
  return onedrive.connect(cfg, browser)
}

test('info asks for the application id only', () => {
  const i = onedrive.info()
  assert.equal(i.kind, 'oauth')
  assert.deepEqual(i.fields.map((f) => f.key), ['clientId'])
  assert.ok(!i.fields.some((f) => f.secret))
})

test('connect, find, put, get, replace, disconnect', async () => {
  assert.deepEqual(await signIn(A), { sub: A.id, label: A.mail, name: 'Ana' })
  assert.equal(await onedrive.find(cfg), null)
  await assert.rejects(onedrive.get(cfg), /niciun backup/i)

  const first = Buffer.from('first backup \u0000ÿ bytes')
  await onedrive.put(cfg, first)
  const found = await onedrive.find(cfg)
  assert.equal(found?.bytes, first.length)
  assert.ok(Math.abs(found!.modifiedAt - Date.now()) < 60_000)
  mock.state.downloadAuth.length = 0
  assert.deepEqual(await onedrive.get(cfg), first)
  assert.deepEqual(mock.state.downloadAuth, [undefined], 'the pre-authenticated address gets no bearer token')

  const second = Buffer.from('a second, longer backup that replaces the first one')
  await onedrive.put(cfg, second)
  assert.equal(mock.files.size, 1)
  assert.deepEqual(await onedrive.get(cfg), second)
  assert.equal((await onedrive.find(cfg))?.bytes, second.length)

  await onedrive.disconnect?.(cfg)
  assert.equal(getSecret('backup:onedrive:refresh'), undefined)
  await assert.rejects(onedrive.find(cfg), /conectat/i)
})

test('a second account has its own empty storage and cannot read the first', async () => {
  await signIn(A)
  const ana = Buffer.from('ana only')
  await onedrive.put(cfg, ana)

  const who = await signIn(B)
  assert.deepEqual(who, { sub: B.id, label: B.userPrincipalName, name: 'Bob' }, 'no mail: the user principal name is the label')
  assert.equal(await onedrive.find(cfg), null)
  await assert.rejects(onedrive.get(cfg), /niciun backup/i)
  await onedrive.put(cfg, Buffer.from('bob only'))
  assert.equal(mock.files.size, 2)
  assert.deepEqual(mock.files.get(A.id).data, ana, "Bob's backup left Ana's file alone")

  await signIn(A)
  assert.deepEqual(await onedrive.get(cfg), ana)
})

test('a refused token is retried once, and the rotated refresh token is the one kept', async () => {
  await signIn(A)
  const before = getSecret('backup:onedrive:refresh')
  mock.state.fail401 = 1
  await onedrive.put(cfg, Buffer.from('after a 401'))
  assert.equal(mock.state.fail401, 0)
  const after = getSecret('backup:onedrive:refresh')
  assert.ok(after && after !== before, 'the new refresh token replaced the old one')
  assert.ok(mock.refreshes.has(after), 'and it is the one Microsoft knows')
  assert.ok(!mock.refreshes.has(before!), 'the old one is dead')
  assert.deepEqual(await onedrive.get(cfg), Buffer.from('after a 401'))
  mock.state.fail401 = 2
  await assert.rejects(onedrive.find(cfg), /401/)
  mock.state.fail401 = 0
})

test('a backup over the simple upload limit is refused before anything is sent', async () => {
  await signIn(A)
  await assert.rejects(onedrive.put(cfg, Buffer.alloc(250 * 1000 * 1000 + 1)), /prea mare/)
})
