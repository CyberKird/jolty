import assert from 'node:assert/strict'
import test from 'node:test'
import type { SkillInfo } from '../src/shared/skills'
import { formatFinds, hubSearch, localMatches, parseHub } from '../src/main/skill-finder'

const skill = (name: string, description: string): SkillInfo =>
  ({ id: `claude:${name}`, name, description, home: 'claude', dir: '', linked: false, files: 1, bytes: 1, hash: '', modifiedAt: 0, source: { kind: 'local' }, status: 'ok', problems: [] }) as SkillInfo

test('installed skills match on every word, name hits first', () => {
  const all = [skill('premiere', 'Control Adobe Premiere Pro'), skill('video-notes', 'notes about a premiere edit')]
  assert.deepEqual(localMatches(all, 'premiere edit', 5).map((s) => s.name), ['video-notes'])
  assert.deepEqual(localMatches(all, 'premiere', 5).map((s) => s.name), ['premiere', 'video-notes'])
  assert.deepEqual(localMatches(all, '  ', 5), [])
})

test('the directory answer keeps only well-formed entries', () => {
  const json = { skills: [{ source: 'kepano/obsidian-skills', skillId: 'obsidian-markdown', installs: 5 }, { source: 'bad source', skillId: 'x' }, { source: 'a/b', skillId: '../x' }, null] }
  assert.deepEqual(parseHub(json, 5), [{ source: 'kepano/obsidian-skills', skillId: 'obsidian-markdown', installs: 5 }])
  assert.deepEqual(parseHub('nope', 5), [])
})

test('hubSearch sends the query url-encoded and reports a failing directory', async () => {
  let url = ''
  const good = (async (u: string) => ((url = u), { ok: true, json: async () => ({ skills: [] }) })) as unknown as typeof fetch
  await hubSearch('a b&c', 3, good)
  assert.match(url, /q=a%20b%26c&limit=3$/)
  const bad = (async () => ({ ok: false, status: 503 })) as unknown as typeof fetch
  await assert.rejects(hubSearch('x', 3, bad), /503/)
})

test('the answer says to ask before installing', () => {
  const text = formatFinds('pdf', [], [{ source: 'a/b', skillId: 'pdf', installs: 9 }])
  assert.match(text, /install nothing without their yes/)
  assert.match(formatFinds('pdf', [], [], 'offline'), /could not be reached/)
})
