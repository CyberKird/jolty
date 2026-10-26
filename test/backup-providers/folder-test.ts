// The local folder provider: the checks on the path, the atomic replace, and that a link is never followed.
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { folder } from '../../src/main/backup/providers/folder'
import { BackupError, FILE } from '../../src/main/backup/types'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jolty-folder-'))
test.after(() => fs.rmSync(root, { recursive: true, force: true }))
const mk = (name: string): string => {
  const p = path.join(root, name)
  fs.mkdirSync(p)
  return p
}
const refused = (p: Promise<unknown>, re: RegExp): Promise<void> => assert.rejects(p, (e: Error) => e instanceof BackupError && re.test(e.message))
const open = (): undefined => undefined

test('info: one path field, with the sync services named in the help', () => {
  const i = folder.info()
  assert.equal(i.kind, 'credentials')
  assert.deepEqual(i.fields.map((f) => f.key), ['path'])
  assert.match(i.help, /iCloud/)
  assert.match(i.help, /OneDrive/)
})

test('connect, find nothing, put 3 MB, find it, get the same bytes, put again replaces', async () => {
  const dir = mk('a')
  const who = await folder.connect({ path: dir }, open)
  assert.equal(who.label, path.resolve(dir))
  assert.equal(who.sub, process.platform === 'win32' ? path.resolve(dir).toLowerCase() : path.resolve(dir))
  assert.deepEqual(fs.readdirSync(dir), [], 'the probe file is gone')
  assert.equal(await folder.find({ path: dir }), null)
  await refused(folder.get({ path: dir }), /backup/)

  const first = randomBytes(3 * 1024 * 1024)
  const before = Date.now()
  await folder.put({ path: dir }, first)
  const found = await folder.find({ path: dir })
  assert.equal(found?.bytes, first.length)
  assert.ok(found && Math.abs(found.modifiedAt - before) < 10_000)
  assert.ok(first.equals(await folder.get({ path: dir })))

  const second = randomBytes(1000)
  await folder.put({ path: dir }, second)
  assert.ok(second.equals(await folder.get({ path: dir })))
  assert.deepEqual(fs.readdirSync(dir), [FILE], 'no temporary file is left behind')
})

test('another folder is separate, and the same folder written another way is the same account', async () => {
  const a = path.join(root, 'a')
  const b = mk('b')
  assert.equal(await folder.find({ path: b }), null)
  await folder.put({ path: b }, Buffer.from('bee'))
  assert.equal((await folder.find({ path: a }))?.bytes, 1000)
  assert.equal((await folder.find({ path: b }))?.bytes, 3)
  const x = await folder.connect({ path: a }, open)
  const y = await folder.connect({ path: path.join(a, '..', 'a') + path.sep }, open)
  assert.equal(x.sub, y.sub)
  assert.notEqual(x.sub, (await folder.connect({ path: b }, open)).sub)
})

test('bad paths give a BackupError', async () => {
  await refused(folder.connect({ path: '' }, open), /câmpurile/)
  await refused(folder.connect({ path: 'relative/dir' }, open), /completă/)
  await refused(folder.connect({ path: path.join(root, 'missing') }, open), /nu există/)
  await refused(folder.connect({ path: path.join(root, 'a', FILE) }, open), /nu există/)
  await refused(folder.connect({ path: path.parse(root).root }, open), /rădăcina/)
  await refused(folder.put({ path: path.join(root, 'missing') }, Buffer.from('x')), /nu există/)
})

test('a read-only folder is refused when connecting', async (t) => {
  if (process.platform === 'win32') return t.skip('chmod does not make a Windows folder read-only')
  if (process.getuid?.() === 0) return t.skip('root writes anywhere')
  const dir = mk('ro')
  fs.chmodSync(dir, 0o500)
  await refused(folder.connect({ path: dir }, open), /folderul/i)
  fs.chmodSync(dir, 0o700)
})

test('a folder or a link named like the backup is never replaced or read', async (t) => {
  const dir = mk('trap')
  fs.mkdirSync(path.join(dir, FILE))
  await refused(folder.find({ path: dir }), /fișier obișnuit/)
  await refused(folder.put({ path: dir }, Buffer.from('x')), /fișier obișnuit/)
  await refused(folder.get({ path: dir }), /fișier obișnuit/)
  assert.deepEqual(fs.readdirSync(dir), [FILE])

  const dir2 = mk('trap2')
  const secret = path.join(root, 'secret.txt')
  fs.writeFileSync(secret, 'do not touch')
  try {
    fs.symlinkSync(secret, path.join(dir2, FILE))
  } catch {
    return t.diagnostic('no permission to create symlinks here, the link case was skipped')
  }
  await refused(folder.find({ path: dir2 }), /fișier obișnuit/)
  await refused(folder.put({ path: dir2 }, Buffer.from('overwrite')), /fișier obișnuit/)
  await refused(folder.get({ path: dir2 }), /fișier obișnuit/)
  assert.equal(fs.readFileSync(secret, 'utf8'), 'do not touch')
})
