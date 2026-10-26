// The GitHub backup provider against a local mock of the GitHub API (JOLTY_BACKUP_MOCK).
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import test from 'node:test'
import { github } from '../../src/main/backup/providers/github'
import { BackupError } from '../../src/main/backup/types'
import { A, B, startGithubMock } from '../mocks/github-mock.mjs'

const mock = await startGithubMock()
process.env.JOLTY_BACKUP_MOCK = mock.url
test.after(() => mock.server.close())

const cfgA = { token: A.token, repo: 'ana/jolty-backup', branch: '' }
const cfgB = { token: B.token, repo: 'bob/jolty-backup', branch: '' }
const open = (): void => assert.fail('GitHub does not open a browser')

test('the fields describe a credentials provider', () => {
  const info = github.info()
  assert.equal(info.kind, 'credentials')
  assert.equal(info.fields.find((f) => f.key === 'token')?.secret, true)
  assert.equal(info.fields.find((f) => f.key === 'branch')?.optional, true)
})

test('connect, store, replace and read back 3 MB', async () => {
  const who = await github.connect(cfgA, open)
  assert.deepEqual(who, { sub: '101:ana/jolty-backup', label: 'ana / ana/jolty-backup', name: 'ana' })
  assert.equal((await github.connect({ ...cfgA, repo: 'Ana/Jolty-Backup' }, open)).sub, who.sub, 'the repo name is not case sensitive')
  assert.equal(await github.find(cfgA), null)
  await assert.rejects(github.get(cfgA), /niciun backup/i)

  const first = randomBytes(3 * 1024 * 1024)
  await github.put(cfgA, first)
  const found = await github.find(cfgA)
  assert.equal(found?.bytes, first.length)
  assert.ok(found && Math.abs(found.modifiedAt - Date.now()) < 60_000)
  assert.ok((await github.get(cfgA)).equals(first))

  const second = randomBytes(1024 * 1024 + 7)
  await github.put(cfgA, second)
  assert.equal((await github.find(cfgA))?.bytes, second.length)
  assert.ok((await github.get(cfgA)).equals(second))
  assert.deepEqual([...mock.repos.get('ana/jolty-backup')!.branches.get('main')!.keys()], ['jolty-backup.enc'])
})

test('a sha conflict is retried once, a second one is an error', async () => {
  const data = randomBytes(1000)
  mock.state.conflicts = 1
  const before = mock.state.puts
  await github.put(cfgA, data)
  assert.equal(mock.state.puts - before, 2)
  assert.ok((await github.get(cfgA)).equals(data))
  mock.state.conflicts = 2
  await assert.rejects(github.put(cfgA, data), BackupError)
  mock.state.conflicts = 0
})

test('a branch other than the default is used when set', async () => {
  const onDev = { ...cfgA, branch: 'dev' }
  assert.equal(await github.find(onDev), null)
  const data = randomBytes(5000)
  await github.put(onDev, data)
  assert.ok((await github.get(onDev)).equals(data))
  assert.equal(mock.repos.get('ana/jolty-backup')!.branches.get('dev')!.size, 1)
  await assert.rejects(github.put({ ...cfgA, branch: 'nope' }, data), BackupError)
})

test('a second account has its own empty storage and cannot read the first', async () => {
  const who = await github.connect(cfgB, open)
  assert.equal(who.sub, '202:bob/jolty-backup')
  assert.equal(await github.find(cfgB), null)
  await assert.rejects(github.get(cfgB), /niciun backup/i)
  await github.put(cfgB, Buffer.from('bob'))
  assert.notEqual((await github.get(cfgA)).toString(), 'bob')
  // Bob's token on Ana's private repo: she is the only one who can see it
  await assert.rejects(github.connect({ ...cfgB, repo: 'ana/jolty-backup' }, open), BackupError)
  const stolen = { ...cfgB, repo: 'ana/jolty-backup' }
  assert.equal(await github.find(stolen), null, "Ana's file is invisible to Bob")
  await assert.rejects(github.get(stolen), /niciun backup/i)
  await assert.rejects(github.put(stolen, Buffer.from('x')), BackupError)
})

test('bad credentials, public repos, read-only tokens and giant files are refused', async () => {
  await assert.rejects(github.connect({ ...cfgA, token: 'nope' }, open), (e) => e instanceof BackupError && /Tokenul/.test(e.message))
  await assert.rejects(github.connect({ ...cfgA, repo: 'ana/missing' }, open), BackupError)
  await assert.rejects(github.connect({ ...cfgA, repo: 'not a repo' }, open), BackupError)
  await assert.rejects(github.connect({ ...cfgA, repo: 'ana/public' }, open), (e) => e instanceof BackupError && /public/.test(e.message))
  await assert.rejects(github.connect({ ...cfgB, repo: 'bob/readonly' }, open), (e) => e instanceof BackupError && /scrie/.test(e.message))
  await assert.rejects(github.put({ ...cfgA, token: 'nope' }, Buffer.from('x')), BackupError)
  await assert.rejects(github.put(cfgA, Buffer.alloc(100 * 1024 * 1024 + 1)), (e) => e instanceof BackupError && /100 MB/.test(e.message))
})
