import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import type { ChatItem } from '../src/shared/types'

const data = fs.mkdtempSync(path.join(os.tmpdir(), 'jolty-store-'))
process.env.JOLTY_DATA_DIR = data
// imported after the env var is set
const store = await import('../src/main/store')

const big = 'x'.repeat(500_000)
const tool = (id: string): ChatItem => ({
  kind: 'tool', id, name: 'Read', title: 'Read', status: 'done',
  output: big, command: big, input: { content: big, n: 1 }, images: ['data:image/png;base64,' + big],
  diffs: [{ path: 'a', kind: 'update', diff: big }]
})
const user: ChatItem = { kind: 'user', id: 'u', text: 'hi', images: [{ name: 'p.png', dataUrl: 'data:image/png;base64,AAAA' }] }

test('tool results are clipped, tool images dropped, user images kept', () => {
  const [u, t] = store.slimTranscript([user, tool('t')])
  assert.deepEqual(u, user)
  assert.equal(t.kind, 'tool')
  if (t.kind !== 'tool') return
  assert.ok(t.output!.length < 21000 && t.output!.includes('characters omitted'))
  assert.ok(t.command!.length < 21000)
  assert.ok(JSON.stringify(t.input).length < 21000 && (t.input as { n: number }).n === 1)
  assert.ok(t.diffs![0].diff.length < 21000)
  assert.equal(t.images, undefined)
})

test('saved transcripts are compact and small texts untouched', () => {
  store.saveTranscript('a', [user, tool('t'), { kind: 'assistant', id: 'x', text: 'short' }])
  const raw = fs.readFileSync(path.join(data, 'transcripts', 'a.json'), 'utf8')
  assert.ok(raw.length < 100_000)
  assert.ok(!raw.includes('\n'))
  assert.equal(store.loadTranscript('a')[2].kind, 'assistant')
})

test('old oversized transcripts shrink, small ones are left alone', async () => {
  const dir = path.join(data, 'transcripts')
  fs.writeFileSync(path.join(dir, 'old.json'), JSON.stringify([tool('1'), tool('2'), tool('3')], null, 2))
  fs.writeFileSync(path.join(dir, 'tiny.json'), '[ ]')
  await store.shrinkTranscripts()
  assert.ok(fs.statSync(path.join(dir, 'old.json')).size < 300_000)
  assert.equal(fs.readFileSync(path.join(dir, 'tiny.json'), 'utf8'), '[ ]')
})

test.after(() => fs.rmSync(data, { recursive: true, force: true }))

test('profile colors never repeat, order follows the saved ids', () => {
  const colors = Array.from({ length: 30 }).reduce<{ color: string }[]>((acc) => [...acc, { color: store.freeColor(acc) }], [])
  assert.equal(new Set(colors.map((c) => c.color)).size, 30)
  const p = (id: string, color?: string) => ({ id, name: id, engine: 'claude' as const, auth: 'apiKey' as const, color })
  store.saveProfiles([p('a', '#d97757'), p('b', '#10a37f'), p('c', '#D97757'), p('d')])
  store.fixProfileColors()
  const fixed = store.loadProfiles()
  assert.equal(fixed[0].color, '#d97757')
  assert.equal(new Set(fixed.map((x) => x.color?.toLowerCase())).size, 4)
  assert.deepEqual(store.reorderProfiles(['c', 'zzz', 'a']).map((x) => x.id), ['c', 'a', 'b', 'd'])
  assert.deepEqual(store.loadProfiles().map((x) => x.id), ['c', 'a', 'b', 'd'])
  assert.throws(() => store.reorderProfiles('a'))
})
