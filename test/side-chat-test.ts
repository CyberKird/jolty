import assert from 'node:assert/strict'
import { test } from 'node:test'
import { listed, SIDE_BUDGET, sideBrief, sideStart, withBrief } from '../src/main/side-chat'
import { digest } from '../src/main/handoff'
import type { ChatItem, SessionMeta } from '../src/shared/types'

const user = (id: string, text: string): ChatItem => ({ kind: 'user', id, text })
const answer = (id: string, text: string): ChatItem => ({ kind: 'assistant', id, text })
const edit = (id: string, path: string): ChatItem => ({ kind: 'tool', id, name: 'Edit', title: path, status: 'done', diffs: [{ path, kind: 'update', diff: '' }] })

const main: SessionMeta = { id: 'main', profileId: 'claude-1', engine: 'claude', cwd: 'C:/proj', title: 'Checkout', model: 'opus', effort: 'high', permissionMode: 'full', browser: true, computer: true, createdAt: 0, updatedAt: 0 }

test('the brief of a long chat stays small: latest request, files touched and the plan', () => {
  const items: ChatItem[] = [user('u0', 'Construiește pagina de checkout')]
  for (let i = 1; i <= 80; i++) items.push(user(`u${i}`, `pasul ${i} `.repeat(60)), answer(`a${i}`, `gata ${i} `.repeat(500)), edit(`e${i}`, `src/f${i}.ts`))
  items.push(user('last', 'Acum adaugă plata cu cardul'))
  items.push({ kind: 'tool', id: 't', name: 'TodoWrite', title: '', status: 'done', input: { todos: [{ content: 'Formular card', status: 'in_progress' }, { content: 'Teste', status: 'pending' }] } })
  const { text, tokens } = sideBrief(main, items)
  assert.ok(text.includes('Acum adaugă plata cu cardul'), 'the last request is in')
  assert.ok(text.includes('- src/f1.ts') && !text.includes('- src/f16.ts'), 'files capped at 15')
  assert.ok(text.includes('[>] Formular card') && text.includes('[ ] Teste'), 'the plan is in')
  assert.ok(text.includes('read-only'), 'the model is told it is read-only')
  // far below the handoff brief: the recent part keeps to its budget, the rest is a fixed frame
  assert.ok(text.length < SIDE_BUDGET + 2000, `brief is ${text.length} chars`)
  assert.ok(tokens < 1300, `brief is ~${tokens} tokens`)
  assert.ok(digest(items).recent.length > 4 * SIDE_BUDGET, 'the default digest is unchanged')
})

test('an empty main chat still gives a usable brief', () => {
  const { text } = sideBrief(main, [])
  assert.ok(text.includes('(empty)'))
  assert.ok(!text.includes('Files changed') && !text.includes('current plan'))
})

test('the question goes after the brief, unchanged', () => {
  const q = 'ce face funcția asta?'
  const sent = withBrief('BRIEF', q)
  assert.ok(sent.startsWith('BRIEF\n'))
  assert.ok(sent.endsWith(`<message>\n${q}\n</message>`))
})

test('a side chat is always temporary, read-only and without browser or computer', () => {
  const profiles = [{ id: 'claude-1', engine: 'claude' as const }, { id: 'codex-1', engine: 'codex' as const }, { id: 'h', engine: 'hermes' as const }]
  const s = sideStart(main, profiles)
  assert.deepEqual(s, { profileId: 'claude-1', cwd: 'C:/proj', model: 'opus', effort: 'high', permissionMode: 'plan', temporary: true, sideOf: 'main' })
  assert.equal((s as { browser?: boolean }).browser, undefined)
  assert.equal((s as { computer?: boolean }).computer, undefined)
  // a cheaper model of another account: the main chat's model and effort do not follow
  assert.deepEqual(sideStart(main, profiles, { profileId: 'codex-1', model: 'mini' }), { profileId: 'codex-1', cwd: 'C:/proj', model: 'mini', effort: undefined, permissionMode: 'plan', temporary: true, sideOf: 'main' })
  // an engine without temporary chats borrows a Claude or Codex account, and is never picked itself
  assert.equal(sideStart({ ...main, profileId: 'h', engine: 'hermes' }, profiles).profileId, 'claude-1')
  assert.equal(sideStart(main, profiles, { profileId: 'h' }).profileId, 'claude-1')
  assert.throws(() => sideStart(main, [{ id: 'h', engine: 'hermes' }]))
})

test('side chats never reach the session list', () => {
  const list = [{ id: 'a' }, { id: 'b', sideOf: 'a' }, { id: 'c', temporary: true }] as SessionMeta[]
  assert.deepEqual(list.filter(listed).map((m) => m.id), ['a', 'c'])
})
