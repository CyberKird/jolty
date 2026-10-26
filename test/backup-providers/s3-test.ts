// The S3 provider against a local S3 that recomputes the SigV4 signature of every request (test/mocks/s3-mock.mjs).
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import test from 'node:test'
import { s3 } from '../../src/main/backup/providers/s3'
import { BackupError, type Config } from '../../src/main/backup/types'
import { A, B, MOVED, REGION, startS3Mock } from '../mocks/s3-mock.mjs'

const mock = await startS3Mock()
test.after(() => mock.close())

const cfg = (acct: typeof A, extra: Config = {}): Config => ({ endpoint: mock.url, region: REGION, bucket: acct.bucket, accessKeyId: acct.accessKeyId, secretAccessKey: acct.secretAccessKey, ...extra })
const refused = (p: Promise<unknown>, code: RegExp): Promise<void> => assert.rejects(p, (e: Error) => e instanceof BackupError && code.test(e.message))
const open = (): undefined => undefined

test('info: credential fields, the secret one marked, the prefix optional', () => {
  const i = s3.info()
  assert.equal(i.kind, 'credentials')
  assert.deepEqual(i.fields.map((f) => f.key), ['endpoint', 'region', 'bucket', 'accessKeyId', 'secretAccessKey', 'prefix'])
  assert.deepEqual(i.fields.filter((f) => f.secret).map((f) => f.key), ['secretAccessKey'])
  assert.deepEqual(i.fields.filter((f) => f.optional).map((f) => f.key), ['prefix'])
})

test('connect, find nothing, put 3 MB, find it, get the same bytes, put again replaces', async () => {
  const who = await s3.connect(cfg(A), open)
  assert.equal(who.sub, `${mock.url}|bucket-a||${A.accessKeyId}`)
  assert.equal(who.label, `bucket-a (${new URL(mock.url).host})`)
  assert.equal(await s3.find(cfg(A)), null)
  await refused(s3.get(cfg(A)), /backup/)

  const first = randomBytes(3 * 1024 * 1024)
  const before = Date.now()
  await s3.put(cfg(A), first)
  const found = await s3.find(cfg(A))
  assert.equal(found?.bytes, first.length)
  assert.ok(found && Math.abs(found.modifiedAt - before) < 10_000)
  assert.ok(first.equals(await s3.get(cfg(A))))

  const second = randomBytes(1024)
  await s3.put(cfg(A), second)
  assert.equal((await s3.find(cfg(A)))?.bytes, 1024)
  assert.ok(second.equals(await s3.get(cfg(A))))
  assert.equal(mock.objects.size, 1)
})

test('a second bucket with its own keys is separate', async () => {
  assert.equal(await s3.find(cfg(B)), null)
  const mine = randomBytes(2048)
  await s3.put(cfg(B), mine)
  assert.ok(mine.equals(await s3.get(cfg(B))))
  assert.equal((await s3.find(cfg(A)))?.bytes, 1024)
  assert.notEqual((await s3.connect(cfg(B), open)).sub, (await s3.connect(cfg(A), open)).sub)
})

test('a prefix keeps the file in a folder of its own, odd characters included', async () => {
  const c = cfg(A, { prefix: '/jolty backups/é$/' })
  assert.equal(await s3.find(c), null)
  const data = randomBytes(500)
  await s3.put(c, data)
  assert.ok(data.equals(await s3.get(c)))
  assert.ok(mock.objects.has('bucket-a/jolty backups/é$/jolty-backup.enc'))
  assert.equal((await s3.find(cfg(A)))?.bytes, 1024)
  assert.match((await s3.connect(c, open)).sub, /\|bucket-a\|jolty backups\/é\$\/\|/)
})

test('every correctly signed request was accepted by the independent verifier', () => {
  assert.deepEqual(mock.log.filter((l: string) => !l.endsWith(' ok')), [])
})

test('wrong keys, wrong bucket, wrong region and a dead address give a BackupError with the status', async () => {
  const wrong = { ...cfg(A), secretAccessKey: 'not-the-secret' }
  await refused(s3.connect(wrong, open), /403/)
  await refused(s3.find(wrong), /403/)
  await refused(s3.put({ ...cfg(A), accessKeyId: 'AKIAUNKNOWNUNKNOWN00' }, Buffer.from('x')), /403/)
  await refused(s3.connect({ ...cfg(A), bucket: 'no-such-bucket' }, open), /404/)
  await refused(s3.connect({ ...cfg(A), bucket: B.bucket }, open), /403/)
  await refused(s3.connect({ ...cfg(A), bucket: MOVED }, open), /301/)
  await refused(s3.connect({ ...cfg(A), region: 'us-east-1' }, open), /403/)
  await refused(s3.connect({ ...cfg(A), endpoint: 'http://127.0.0.1:1' }, open), /127\.0\.0\.1:1/)
  await refused(s3.connect({ ...cfg(A), endpoint: 'not a url' }, open), /endpoint/)
  await refused(s3.connect({ ...cfg(A), endpoint: 'ftp://x.example' }, open), /endpoint/)
  await refused(s3.connect({ ...cfg(A), bucket: '' }, open), /câmpurile/)
  await refused(s3.connect(cfg(A, { prefix: 'a/../b' }), open), /\.\./)
  await assert.rejects(s3.connect(wrong, open), (e: Error) => !e.message.includes('not-the-secret'))
})
