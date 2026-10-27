import assert from 'node:assert/strict'
import test from 'node:test'
import { learnNowRule, learningNudge } from '../src/main/learning'

test('the standing rule exists for Claude, is silent for Hermes, and says to save at once', () => {
  const rule = learnNowRule('claude')
  assert.ok(rule && /right then/.test(rule) && /memory system/.test(rule))
  assert.equal(learnNowRule('hermes'), undefined)
})

test('the periodic check still fires on every tenth message only, and skips what was already saved', () => {
  assert.equal(learningNudge('claude', 9), undefined)
  const nudge = learningNudge('claude', 10)
  assert.ok(nudge && /already saved/.test(nudge))
})
