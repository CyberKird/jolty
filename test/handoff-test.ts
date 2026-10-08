import assert from 'node:assert/strict'
import { test } from 'node:test'
import { digest, handoffPrompt, sameProvider, TEXT_BUDGET } from '../src/main/handoff'
import { editDiff, partialJsonString } from '../src/main/engines/partial-json'
import { splitQuote, withQuote } from '../src/shared/quote'

test('a streaming edit shows as a line diff, every edit of a MultiEdit included', () => {
  const json = '{"file_path":"a.ts","edits":[{"old_string":"let x = 1\\nlet y","new_string":"const x = 2"},{"old_string":"foo","new_str'
  assert.equal(partialJsonString(json, 'file_path'), 'a.ts')
  assert.equal(editDiff(json), '@@ modificarea 1\n-let x = 1\n-let y\n+const x = 2\n@@ modificarea 2\n-foo')
  // cut in the middle of an escape: what arrived so far, no garbage
  assert.equal(partialJsonString('{"new_string":"a\\', 'new_string'), 'a')
})
import type { ChatItem, Profile } from '../src/shared/types'

test('a reply quote survives the round trip and leaves plain messages alone', () => {
  const sent = withQuote('prima linie\na doua', 'de ce?')
  assert.equal(sent, '> prima linie\n> a doua\n\nde ce?')
  assert.deepEqual(splitQuote(sent), { quote: 'prima linie\na doua', body: 'de ce?' })
  assert.deepEqual(splitQuote('fără citat'), { body: 'fără citat' })
  assert.equal(withQuote(undefined, 'x'), 'x')
})

const user = (id: string, text: string): ChatItem => ({ kind: 'user', id, text })
const answer = (id: string, text: string): ChatItem => ({ kind: 'assistant', id, text })

test('a long conversation shrinks to the budget, keeping the first request and the latest turns', () => {
  const items: ChatItem[] = [user('u0', 'Construiește pagina de checkout')]
  for (let i = 1; i <= 60; i++) items.push(user(`u${i}`, `pasul ${i} `.repeat(40)), answer(`a${i}`, `gata ${i} `.repeat(400)))
  const d = digest(items)
  assert.ok(d.recent.length <= TEXT_BUDGET, `recent part ${d.recent.length} chars`)
  assert.ok(d.dropped > 0)
  assert.equal(d.first, 'Construiește pagina de checkout')
  assert.ok(d.recent.includes('pasul 60'), 'the latest request is kept')
  assert.ok(d.recent.includes('gata 60'), 'the end of the latest answer is kept')
})

test('tool calls are left out, the files they changed are listed once', () => {
  const tool = (id: string, path: string): ChatItem => ({ kind: 'tool', id, name: 'Edit', title: `Edit ${path}`, status: 'done', diffs: [{ path, kind: 'modify', diff: '+a' }] } as ChatItem)
  const p = handoffPrompt({ engine: 'Claude Code', cwd: 'C:/p' }, [user('u', 'repară'), tool('t1', 'src/a.ts'), tool('t2', 'src/a.ts'), answer('a', 'am reparat')], '', { next: 'și acum testele', graph: true })
  assert.ok(!p.includes('[Unealtă]'))
  assert.equal(p.split('- src/a.ts').length - 1, 1)
  assert.ok(p.includes('GRAPH_REPORT.md'))
  assert.ok(p.trimEnd().endsWith('și acum testele\n</message>'))
})

test('a short conversation goes over whole, without a separate first request', () => {
  const d = digest([user('u', 'salut'), answer('a', 'salut')])
  assert.equal(d.dropped, 0)
  assert.equal(d.first, undefined)
})

test('same provider: two Anthropic accounts or one endpoint, never across engines', () => {
  const p = (id: string, engine: Profile['engine'], auth: Profile['auth'], baseUrl?: string): Profile => ({ id, name: id, engine, auth, baseUrl, isDefaultDir: false, color: '' })
  assert.ok(sameProvider(p('a', 'claude', 'subscription'), p('b', 'claude', 'subscription')))
  assert.ok(sameProvider(p('a', 'claude', 'endpoint', 'https://api.deepseek.com/anthropic/'), p('b', 'claude', 'endpoint', 'https://api.deepseek.com/anthropic')))
  assert.ok(!sameProvider(p('a', 'claude', 'subscription'), p('b', 'claude', 'endpoint', 'https://api.deepseek.com/anthropic')))
  assert.ok(!sameProvider(p('a', 'codex', 'subscription'), p('b', 'codex', 'subscription')))
})
