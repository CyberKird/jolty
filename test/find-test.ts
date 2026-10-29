import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { ChatItem } from '../src/shared/types'
import { chunksToReach, findMatches, itemText, offsetsOf, stepMatch } from '../src/shared/find'
import { SHORTCUTS, SHORTCUT_GROUPS, keyLabels, shortcutsIn } from '../src/shared/shortcuts'

const items: ChatItem[] = [
  { kind: 'user', id: 'u1', text: 'Fix the Bug in login' },
  { kind: 'reasoning', id: 'r1', text: 'bug bug bug' },
  { kind: 'tool', id: 't1', name: 'Bash', title: 'Run tests', status: 'done', command: 'npm test -- --grep bug', output: 'bug in output' },
  { kind: 'assistant', id: 'a1', text: 'The bug was in login. Another BUG here.' },
  { kind: 'notice', id: 'n1', text: 'bug', level: 'info' }
]

test('hits ignore case, do not overlap and are counted per occurrence', () => {
  assert.deepEqual(offsetsOf('aaaa', 'aa'), [0, 2])
  assert.deepEqual(offsetsOf('Bug bUG', 'bug'), [0, 4])
  assert.deepEqual(offsetsOf('abc', ''), [])
})

test('user and assistant messages, tool title and command are searched; reasoning, tool output and notices are not', () => {
  assert.equal(itemText(items[2]), 'Run tests\nnpm test -- --grep bug')
  assert.equal(itemText(items[1]), '')
  assert.deepEqual(findMatches(items, 'bug'), [
    { item: 0, nth: 0 },
    { item: 2, nth: 0 },
    { item: 3, nth: 0 },
    { item: 3, nth: 1 }
  ])
  assert.deepEqual(findMatches(items, ''), [])
  assert.deepEqual(findMatches(items, 'zzz'), [])
})

test('stepping wraps at both ends and survives no hits', () => {
  assert.equal(stepMatch(3, 4, 1), 0)
  assert.equal(stepMatch(0, 4, -1), 3)
  assert.equal(stepMatch(1, 4, 1), 2)
  assert.equal(stepMatch(0, 0, 1), 0)
})

test('the window grows far enough to reach an old message', () => {
  // 1000 messages when it opened, chunks of 120: the window starts at 880 with one chunk
  assert.equal(chunksToReach(900, 1000, 120), 1)
  assert.equal(chunksToReach(879, 1000, 120), 2)
  assert.equal(chunksToReach(0, 1000, 120), 9)
  // start = base - chunks * chunk must be <= index
  for (const idx of [0, 5, 119, 120, 500, 879]) assert.ok(1000 - chunksToReach(idx, 1000, 120) * 120 <= idx)
})

test('the shortcuts sheet: every shortcut is complete, in a known group, and listed once', () => {
  const groups = SHORTCUT_GROUPS.map((g) => g.id)
  const seen = new Set<string>()
  for (const s of SHORTCUTS) {
    assert.ok(groups.includes(s.group))
    assert.ok(s.keys.length && s.keys.every(Boolean))
    assert.ok(s.label().trim())
    const id = `${s.group}:${s.keys.join('+')}`
    assert.ok(!seen.has(id), id)
    seen.add(id)
  }
  for (const g of groups) assert.ok(shortcutsIn(g).length)
  assert.equal(shortcutsIn('general').length + shortcutsIn('chat').length + shortcutsIn('composer').length, SHORTCUTS.length)
})

test('Mod is Ctrl, or Cmd on a Mac', () => {
  assert.deepEqual(keyLabels(['Mod', 'K'], false), ['Ctrl', 'K'])
  assert.deepEqual(keyLabels(['Mod', 'K'], true), ['⌘', 'K'])
})
