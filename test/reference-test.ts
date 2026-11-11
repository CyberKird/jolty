import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import type { ChatItem } from '../src/shared/types'
import { referenceMarkdown, writeReference } from '../src/main/reference'

const items: ChatItem[] = [
  { kind: 'user', id: 'u1', text: 'Fix the bridge deck' },
  { kind: 'assistant', id: 'a1', text: 'Done, the deck is 12 m.' },
  { kind: 'tool', id: 't1', name: 'Edit', title: 'Edit deck.py', status: 'done', output: 'x'.repeat(50_000), diffs: [{ path: 'deck.py', insertions: 1, deletions: 0, patch: '' } as never] },
  { kind: 'tool', id: 't2', name: 'Bash', title: 'run tests', status: 'error', command: 'npm test' }
]

test('a conversation becomes a short Markdown file: messages in full, tool runs as one line, no tool output', () => {
  const md = referenceMarkdown({ title: 'Bridge', cwd: '/proj' }, items)
  assert.match(md, /^# Bridge/)
  assert.match(md, /## User\nFix the bridge deck/)
  assert.match(md, /## Assistant\nDone, the deck is 12 m\./)
  assert.match(md, /- tool Bash: npm test \(failed\)/)
  assert.match(md, /## Files changed in this conversation\n- deck\.py/)
  assert.ok(md.length < 1000, 'tool output is left out')
})

test('the file is written under the data folder and rewritten in place', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jolty-ref-'))
  try {
    const a = writeReference(dir, { id: 's:1/x', title: 'T', cwd: '/p' }, items)
    const b = writeReference(dir, { id: 's:1/x', title: 'T', cwd: '/p' }, items.slice(0, 2))
    assert.equal(a, b)
    assert.ok(a.startsWith(path.join(dir, 'references')))
    assert.doesNotMatch(path.basename(a), /[:/]/)
    assert.doesNotMatch(fs.readFileSync(a, 'utf8'), /Bash/)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
