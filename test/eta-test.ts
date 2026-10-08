import assert from 'node:assert/strict'
import { test } from 'node:test'
import { clock, etaLabel, tick, timeLeft } from '../src/shared/eta'
import type { PlanStep } from '../src/shared/types'

const steps = (done: number, total: number): PlanStep[] =>
  Array.from({ length: total }, (_, i) => ({ text: `pas ${i}`, status: i < done ? 'done' : i === done ? 'active' : 'pending' }))

test('estimates from the pace of finished steps', () => {
  let c = tick({ turn: 0 }, undefined, steps(0, 4), 1000)
  assert.equal(timeLeft(c, steps(0, 4), 5000), undefined, 'no estimate before the first step is done')
  c = tick(c, steps(0, 4), steps(1, 4), 61_000) // one step took 60 s
  assert.equal(timeLeft(c, steps(1, 4), 61_000), 180_000)
  // 30 s into the next step: 30 s less
  assert.equal(timeLeft(c, steps(1, 4), 91_000), 150_000)
  // a step running long never drops the estimate under a tenth of a step per remaining work
  assert.equal(timeLeft(c, steps(1, 4), 999_000), 180_000 - 54_000)
})

test('a new task list after a finished one restarts the clock', () => {
  let c = tick(undefined, undefined, steps(0, 2), 1)
  c = tick(c, steps(0, 2), steps(2, 2), 100_000)
  c = tick(c, steps(2, 2), steps(0, 3), 200_000)
  assert.equal(c.plan, 200_000)
  assert.equal(timeLeft(c, steps(0, 3), 210_000), undefined)
})

test('a list that arrives with steps already done does not count them', () => {
  const c = tick(undefined, undefined, steps(2, 4), 1)
  assert.equal(timeLeft(c, steps(2, 4), 10_000), undefined)
})

test('labels', () => {
  assert.equal(etaLabel(undefined), 'se estimează')
  assert.equal(etaLabel(30_000), 'sub 1 min rămas')
  assert.equal(etaLabel(150_000), '~3 min rămase')
  assert.equal(clock(75_000), '1:15')
  assert.equal(clock(3_725_000), '1:02:05')
})
