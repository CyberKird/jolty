import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { autoMerge, checkOf, issue, issueText, overview } from '../src/main/github'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jolty-gh-'))
process.env.JOLTY_GH = path.resolve('test/fixtures/gh-stub.js')
process.env.GH_STUB_DIR = dir
const cwd = dir // any folder that exists

test('a check run and an old-style status both end up as pass, fail, pending or skipped', () => {
  assert.deepEqual(checkOf({ name: 'a', status: 'COMPLETED', conclusion: 'SUCCESS' }), { name: 'a', state: 'pass' })
  assert.deepEqual(checkOf({ name: 'a', status: 'COMPLETED', conclusion: 'TIMED_OUT' }), { name: 'a', state: 'fail' })
  assert.deepEqual(checkOf({ name: 'a', status: 'IN_PROGRESS', conclusion: '' }), { name: 'a', state: 'pending' })
  assert.deepEqual(checkOf({ name: 'a', status: 'COMPLETED', conclusion: 'SKIPPED' }), { name: 'a', state: 'skipped' })
  assert.deepEqual(checkOf({ context: 'ci/x', state: 'FAILURE' }), { name: 'ci/x', state: 'fail' })
  assert.deepEqual(checkOf({ context: 'ci/x', state: 'PENDING' }), { name: 'ci/x', state: 'pending' })
})

test('the overview has the repository, the pull request with its checks and the open issues', async () => {
  const o = await overview(cwd, true)
  assert.equal(o.kind, 'ok')
  if (o.kind !== 'ok') return
  assert.equal(o.repo, 'acme/shop')
  assert.equal(o.pr?.number, 12)
  assert.deepEqual(o.pr?.checks.map((c) => c.state), ['pass', 'pending', 'fail'])
  assert.equal(o.pr?.autoMerge, false)
  assert.deepEqual(o.issues.map((i) => [i.number, i.labels, i.author]), [[7, ['bug'], 'ana'], [9, [], 'dan']])
})

test('auto-merge is asked for and taken back, and the next overview shows it', async () => {
  await autoMerge(cwd, true)
  const on = await overview(cwd)
  assert.equal(on.kind === 'ok' && on.pr?.autoMerge, true)
  await autoMerge(cwd, false)
  const off = await overview(cwd)
  assert.equal(off.kind === 'ok' && off.pr?.autoMerge, false)
})

test('an issue becomes text with its link, labels, body and conversation', async () => {
  const text = await issue(cwd, 7)
  assert.ok(text.startsWith('GitHub issue #7: Cart loses items\nhttps://github.com/acme/shop/issues/7\nLabels: bug\n\nItems vanish after login.'))
  assert.ok(text.includes('Comments:\n- dan: Same here.'))
  assert.equal(issueText({ number: 1, title: 't', url: 'u', body: 'x'.repeat(30000) }).length, 20001)
})

test('only a whole number reaches gh as an issue', async () => {
  for (const bad of ['7; rm', -1, 1.5, 0, null]) await assert.rejects(issue(cwd, bad))
})

test('without a pull request the overview still lists the issues; without a repo or a login it says why', async () => {
  process.env.GH_STUB_MODE = 'nopr'
  const a = await overview(cwd, true)
  assert.equal(a.kind === 'ok' && a.pr, undefined)
  assert.equal(a.kind === 'ok' && a.issues.length, 2)
  process.env.GH_STUB_MODE = 'norepo'
  assert.deepEqual(await overview(cwd, true), { kind: 'off', reason: 'no-repo' })
  process.env.GH_STUB_MODE = 'noauth'
  assert.deepEqual(await overview(cwd, true), { kind: 'off', reason: 'no-auth' })
  delete process.env.GH_STUB_MODE
})
