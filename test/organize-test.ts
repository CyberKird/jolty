import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import type { ChatItem, SessionMeta } from '../src/shared/types'
import { finishedToArchive, splitSessions } from '../src/shared/organize'

const data = fs.mkdtempSync(path.join(os.tmpdir(), 'jolty-organize-'))
process.env.JOLTY_DATA_DIR = data
// imported after the env var is set
const store = await import('../src/main/store')
const trash = await import('../src/main/trash')

const meta = (id: string, extra: Partial<SessionMeta> = {}): SessionMeta => ({
  id, profileId: 'p', engine: 'claude', cwd: 'C:/x', title: id, permissionMode: 'autoEdit', createdAt: 1, updatedAt: 5, ...extra
})
const item = (text: string): ChatItem => ({ kind: 'user', id: 'u', text })

test('pinned, normal and archived lists keep their order; an archived pin is archived', () => {
  const l = [meta('a'), meta('b', { pinned: true }), meta('c', { archived: true }), meta('d', { pinned: true, archived: true }), meta('e', { pinned: true })]
  const s = splitSessions(l)
  assert.deepEqual(s.pinned.map((x) => x.id), ['b', 'e'])
  assert.deepEqual(s.rest.map((x) => x.id), ['a'])
  assert.deepEqual(s.archived.map((x) => x.id), ['c', 'd'])
})

test('bulk archive takes only finished scheduled runs and lead children', () => {
  const l = [
    meta('plain'),
    meta('sched', { scheduled: true }),
    meta('kid', { parentId: 'plain' }),
    meta('running', { scheduled: true }),
    meta('waiting', { parentId: 'plain' }),
    meta('pinned', { scheduled: true, pinned: true }),
    meta('done', { scheduled: true, archived: true })
  ]
  const status: Record<string, 'idle' | 'running' | 'error'> = { running: 'running', kid: 'error' }
  const permissions = { waiting: [{ id: 'r' } as never] }
  assert.deepEqual(finishedToArchive(l, status, permissions).map((x) => x.id), ['sched', 'kid'])
})

test('a removed conversation comes back whole, with its time, and the trash is empty after', () => {
  store.saveSessions([meta('keep'), meta('gone', { pinned: true })])
  store.saveTranscript('gone', [item('hello')])
  assert.deepEqual(trash.stash(meta('gone', { pinned: true }), [item('hello')]), [])
  store.saveSessions(store.loadSessions().filter((s) => s.id !== 'gone'))
  store.removeTranscript('gone')
  assert.deepEqual(trash.closed().map((c) => c.id), ['gone'])

  const back = trash.restore()
  assert.equal(back.id, 'gone')
  assert.equal(back.updatedAt, 5)
  assert.equal(back.pinned, true)
  assert.deepEqual(store.loadSessions().map((s) => s.id).sort(), ['gone', 'keep'])
  assert.equal((store.loadTranscript('gone')[0] as { text: string }).text, 'hello')
  assert.deepEqual(trash.closed(), [])
  assert.throws(() => trash.restore())
})

test('tool images are not kept in the trash, user images are', () => {
  const tool: ChatItem = { kind: 'tool', id: 't', name: 'Shot', title: 'Shot', status: 'done', images: ['data:image/png;base64,AAAA'] }
  const user: ChatItem = { kind: 'user', id: 'u', text: 'x', images: [{ name: 'p.png', dataUrl: 'data:image/png;base64,BBBB' }] }
  trash.stash(meta('img'), [user, tool])
  const raw = fs.readFileSync(path.join(data, 'trash', 'img.json'), 'utf8')
  assert.ok(!raw.includes('AAAA') && raw.includes('BBBB'))
  trash.purge()
})

test('only the newest KEEP removed conversations stay; the rest are returned to be finished', () => {
  const out: string[] = []
  for (let i = 0; i < trash.KEEP + 3; i++) {
    out.push(...trash.stash(meta(`s${i}`, { worktree: { path: 'w', branch: 'b', base: 'c', root: 'r' } }), []).map((m) => m.id))
    // distinct deletion times
    const f = path.join(data, 'trash', `s${i}.json`)
    const e = JSON.parse(fs.readFileSync(f, 'utf8'))
    fs.writeFileSync(f, JSON.stringify({ ...e, deletedAt: 1000 + i }))
  }
  assert.equal(trash.closed().length, trash.KEEP)
  assert.ok(out.length >= 1)
  assert.equal(trash.closed()[0].id, `s${trash.KEEP + 2}`)
})

test('purge wipes everything; with keepWorktrees the worktree owners leave a file without the transcript', () => {
  trash.purge()
  trash.stash(meta('wt', { worktree: { path: 'w', branch: 'b', base: 'c', root: 'r' } }), [item('secret')])
  trash.stash(meta('no'), [item('secret')])
  assert.deepEqual(trash.purge(true).map((m) => m.id).sort(), ['no', 'wt'])
  const left = fs.readdirSync(path.join(data, 'trash'))
  assert.deepEqual(left, ['wt.json'])
  assert.ok(!fs.readFileSync(path.join(data, 'trash', 'wt.json'), 'utf8').includes('secret'))
  assert.deepEqual(trash.purge().map((m) => m.id), ['wt'])
  assert.deepEqual(fs.readdirSync(path.join(data, 'trash')), [])
})
