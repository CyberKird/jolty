// The rules of the compaction indicator: a pill while it runs, the result for a few seconds, never a stuck pill.
import assert from 'node:assert/strict'
import test from 'node:test'
import { compactView, reduceCompaction, RESULT_MS, settleCompaction } from '../src/shared/compaction'

test('start shows the working pill, the end shows the result and keeps the size the start knew', () => {
  const started = reduceCompaction(undefined, { active: true, before: 180000 }, 1000)
  assert.equal(compactView(started, 1000), 'working')
  const ended = reduceCompaction(started, { active: false, after: 40000 }, 5000)
  assert.deepEqual([ended.before, ended.after], [180000, 40000])
  assert.equal(compactView(ended, 5000 + RESULT_MS - 1), 'done')
  assert.equal(compactView(ended, 5000 + RESULT_MS), undefined, 'the result goes away by itself')
})

test('a failed compaction says so', () => {
  const s = reduceCompaction(reduceCompaction(undefined, { active: true }, 0), { active: false, failed: true }, 10)
  assert.equal(compactView(s, 11), 'failed')
})

test('a turn that ends while the pill is up clears it; a finished result is left alone', () => {
  const running = reduceCompaction(undefined, { active: true }, 0)
  const settled = settleCompaction(running, 50)!
  assert.equal(settled.active, false)
  assert.equal(compactView(settled, 60), 'failed')
  const done = reduceCompaction(running, { active: false, before: 9, after: 3 }, 20)
  assert.equal(settleCompaction(done, 90), done)
  assert.equal(settleCompaction(undefined), undefined)
})

test('nothing is drawn for a conversation that never compacted', () => {
  assert.equal(compactView(undefined), undefined)
})
