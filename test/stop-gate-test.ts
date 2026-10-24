import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { ChatEvent, ChatItem } from '../src/shared/types'
import { afterStop } from '../src/main/stop-gate'

const sid = 's'
const tool = (id: string, status: 'running' | 'done' | 'error' = 'running'): ChatItem => ({ kind: 'tool', id, name: 'Bash', title: 'Bash', status })
const shown = new Map<string, ChatItem>([['t1', tool('t1')]])
const lookup = (id: string): ChatItem | undefined => shown.get(id)
const keeps = (e: ChatEvent): boolean => afterStop(e, lookup)

test('after Stop the trailing text, drafts, plans, new tools and a late "running" are dropped', () => {
  assert.equal(keeps({ type: 'delta', sessionId: sid, itemId: 'a', kind: 'assistant', delta: 'x' }), false)
  assert.equal(keeps({ type: 'draft', sessionId: sid, toolId: 't', name: 'Write', content: '', done: false }), false)
  assert.equal(keeps({ type: 'plan', sessionId: sid, steps: [] }), false)
  assert.equal(keeps({ type: 'item', sessionId: sid, item: { kind: 'assistant', id: 'a', text: 'x' } }), false)
  assert.equal(keeps({ type: 'item', sessionId: sid, item: { kind: 'reasoning', id: 'r', text: 'x' } }), false)
  assert.equal(keeps({ type: 'item', sessionId: sid, item: tool('new') }), false)
  assert.equal(keeps({ type: 'status', sessionId: sid, status: 'running' }), false)
})

test('after Stop the end of a shown tool, notices, idle, error and other events still pass', () => {
  assert.equal(keeps({ type: 'item', sessionId: sid, item: tool('t1', 'error') }), true)
  assert.equal(keeps({ type: 'item', sessionId: sid, item: { kind: 'notice', id: 'n', text: 'Oprit.', level: 'info' } }), true)
  assert.equal(keeps({ type: 'status', sessionId: sid, status: 'idle' }), true)
  assert.equal(keeps({ type: 'status', sessionId: sid, status: 'error', error: 'x' }), true)
  assert.equal(keeps({ type: 'permissionResolved', sessionId: sid, requestId: 'p' }), true)
  assert.equal(keeps({ type: 'context', sessionId: sid, used: 1 }), true)
})
