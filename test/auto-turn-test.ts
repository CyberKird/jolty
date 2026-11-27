import assert from 'node:assert/strict'
import { test } from 'node:test'
import { startsOwnTurn } from '../src/main/engines/auto-turn'

const idle = { turn: false, stopping: false }

test('output after a background task ends marks the chat running again (it stays in Live)', () => {
  assert.equal(startsOwnTurn({ type: 'stream_event' }, idle), true)
  assert.equal(startsOwnTurn({ type: 'assistant', parent_tool_use_id: null }, idle), true)
})

test('a turn already known, a Stop in progress or a subagent message start nothing', () => {
  assert.equal(startsOwnTurn({ type: 'assistant' }, { turn: true, stopping: false }), false)
  assert.equal(startsOwnTurn({ type: 'assistant' }, { turn: false, stopping: true }), false)
  assert.equal(startsOwnTurn({ type: 'assistant', parent_tool_use_id: 'toolu_1' }, idle), false)
})

test('bookkeeping messages are not a turn', () => {
  for (const type of ['system', 'result', 'user', 'rate_limit_event']) assert.equal(startsOwnTurn({ type }, idle), false)
})
