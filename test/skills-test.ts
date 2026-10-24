import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { pathToFileURL } from 'node:url'

// a throwaway HOME and data folder, set before anything reads them; file:// remotes only under JOLTY_TEST
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jolty-skills-test-'))
process.env.JOLTY_TEST = '1'
process.env.JOLTY_DATA_DIR = path.join(tmp, 'data')
process.env.HOME = process.env.USERPROFILE = path.join(tmp, 'home')
const skills = path.join(tmp, 'home', '.claude', 'skills')
fs.mkdirSync(skills, { recursive: true })

import { hashSkillDir } from '../src/main/skill-fs'
import * as api from '../src/main/skills'
import { parseFrontmatter, validCommit, validGitUrl, validRef, validSubdir } from '../src/main/skills-parse'
import { needsAttention } from '../src/shared/skills'

const write = (f: string, text: string): void => {
  fs.mkdirSync(path.dirname(f), { recursive: true })
  fs.writeFileSync(f, text)
}
const md = (name: string, body = 'x'): string => `---\nname: ${name}\ndescription: Does ${body}\n---\nbody ${body}\n`
const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8' })

test('frontmatter: quotes, folded blocks, CRLF, BOM, broken blocks', () => {
  assert.deepEqual(parseFrontmatter('---\nname: a\ndescription: "b: c"\n---\n'), { present: true, bad: false, name: 'a', description: 'b: c' })
  assert.equal(parseFrontmatter('﻿---\r\nname: a\r\ndescription: >\r\n  one\r\n  two\r\n---\r\n').description, 'one two')
  assert.equal(parseFrontmatter('---\nname: a\n').bad, true)
  assert.equal(parseFrontmatter('no block').present, false)
  assert.equal(parseFrontmatter('---\nname: a\ndescription: "open\n---\n').bad, true)
})

test('validators refuse flag injection and odd sources', () => {
  assert.equal(validGitUrl('https://github.com/a/b.git'), true)
  for (const bad of ['--upload-pack=x', 'http://x/y', 'https://u:p@x/y', 'git@github.com:a/b.git', 'https://x y/z', 5]) assert.equal(validGitUrl(bad), false, String(bad))
  assert.equal(validGitUrl('git@github.com:a/b.git', true), true)
  assert.equal(validGitUrl(pathToFileURL(tmp).href), true) // JOLTY_TEST only
  for (const bad of ['-x', 'a..b', '/a', 'a//b', 'a.lock', '', 'a b']) assert.equal(validRef(bad), false, bad)
  assert.equal(validRef('feature/x-1.2'), true)
  for (const bad of ['..', 'a/../b', '/abs', 'a\\b', '-x', 'c:x', 'a//b']) assert.equal(validSubdir(bad), false, bad)
  assert.equal(validSubdir('skills/foo'), true)
  assert.equal(validCommit('abc1234'), true)
  assert.equal(validCommit('abc;rm'), false)
})

test('hashSkillDir: same content same hash, ignores .git, notices an edit', () => {
  const a = path.join(tmp, 'h1')
  const b = path.join(tmp, 'h2')
  for (const d of [a, b]) write(path.join(d, 'SKILL.md'), md('h'))
  write(path.join(a, '.git', 'junk'), '1')
  assert.equal(hashSkillDir(a), hashSkillDir(b))
  write(path.join(b, 'SKILL.md'), md('h', 'y'))
  assert.notEqual(hashSkillDir(a), hashSkillDir(b))
})

test('list: problems found offline, attention only for what needs it', async () => {
  write(path.join(skills, 'good', 'SKILL.md'), md('good'))
  write(path.join(skills, 'empty', 'readme.txt'), 'x')
  write(path.join(skills, 'twin-a', 'SKILL.md'), md('twin'))
  write(path.join(skills, 'twin-b', 'SKILL.md'), md('twin'))
  write(path.join(skills, '.hidden', 'SKILL.md'), md('hidden'))
  const byId = Object.fromEntries((await api.list()).map((s) => [s.id, s]))
  assert.equal(byId['claude:good'].status, 'unknown')
  assert.equal(needsAttention(byId['claude:good']), false)
  assert.ok(byId['claude:empty'].problems.includes('no-skill-md'))
  assert.equal(byId['claude:empty'].status, 'broken')
  assert.ok(byId['claude:twin-a'].problems.includes('duplicate-name'))
  assert.equal(byId['claude:.hidden'], undefined)
  await assert.rejects(api.update('claude:nope'), /skill-not-found/)
  await assert.rejects(api.update('claude:good'), /no-source/)
})

test('setSource refuses a source that could inject git flags', async () => {
  for (const source of [{ kind: 'git', url: '--upload-pack=x' }, { kind: 'git', url: 'https://github.com/a/b.git', ref: '-x' }, { kind: 'git', url: 'https://github.com/a/b.git', subdir: '../x' }, { kind: 'pack' }, { kind: 'git', url: 'git@h:a/b' }])
    await assert.rejects(api.setSource('claude:good', source as never), /bad-source/)
})

test('copy from a repo subfolder: install, check, update with backup, edit counts as modified', async () => {
  const repo = path.join(tmp, 'remote')
  fs.mkdirSync(repo)
  git(repo, 'init', '-q', '-b', 'main')
  write(path.join(repo, 'skills', 'foo', 'SKILL.md'), md('foo', 'v1'))
  write(path.join(repo, 'other', 'file.txt'), '1')
  git(repo, 'add', '-A')
  git(repo, 'commit', '-qm', 'one')
  write(path.join(skills, 'foo', 'SKILL.md'), md('foo', 'old'))
  const url = pathToFileURL(repo).href
  const set = await api.setSource('claude:foo', { kind: 'git', url, ref: 'main', subdir: 'skills/foo' })
  assert.equal(set.source.kind, 'git')
  assert.equal(set.status, 'unknown')

  let foo = await api.update('claude:foo')
  assert.equal(foo.status, 'ok')
  assert.match(fs.readFileSync(path.join(skills, 'foo', 'SKILL.md'), 'utf8'), /v1/)
  const backups = (): string[] => fs.readdirSync(path.join(tmp, 'data', 'skill-backups'))
  assert.equal(backups().length, 1)
  assert.match(fs.readFileSync(path.join(tmp, 'data', 'skill-backups', backups()[0], 'SKILL.md'), 'utf8'), /old/)
  assert.deepEqual(fs.readdirSync(skills).filter((n) => n.startsWith('.foo')), [])

  // a commit elsewhere in the repo does not make the skill outdated
  write(path.join(repo, 'other', 'file.txt'), '2')
  git(repo, 'commit', '-qam', 'two')
  foo = (await api.check(['claude:foo'])).find((s) => s.id === 'claude:foo')!
  assert.equal(foo.status, 'ok')

  write(path.join(repo, 'skills', 'foo', 'SKILL.md'), md('foo', 'v2'))
  git(repo, 'commit', '-qam', 'three')
  foo = (await api.check()).find((s) => s.id === 'claude:foo')!
  assert.equal(foo.status, 'outdated')
  assert.ok(foo.latest)
  assert.equal(needsAttention(foo), true)

  write(path.join(skills, 'foo', 'extra.txt'), 'mine')
  assert.equal((await api.list()).find((s) => s.id === 'claude:foo')!.status, 'modified')
  foo = await api.update('claude:foo')
  assert.equal(foo.status, 'ok')
  assert.match(fs.readFileSync(path.join(skills, 'foo', 'SKILL.md'), 'utf8'), /v2/)
  assert.equal(fs.existsSync(path.join(skills, 'foo', 'extra.txt')), false)
  assert.equal(backups().length, 2)
  assert.ok(backups().some((b) => fs.existsSync(path.join(tmp, 'data', 'skill-backups', b, 'extra.txt'))), 'the edit survives in a backup')
})

test('a skill folder that is a clone is pulled, and refused when it has local changes', async () => {
  const repo = path.join(tmp, 'remote2')
  fs.mkdirSync(repo)
  git(repo, 'init', '-q', '-b', 'main')
  write(path.join(repo, 'SKILL.md'), md('cloned', 'v1'))
  git(repo, 'add', '-A')
  git(repo, 'commit', '-qm', 'one')
  git(skills, 'clone', '-q', pathToFileURL(repo).href, 'cloned')
  let s = (await api.list()).find((x) => x.id === 'claude:cloned')!
  assert.equal(s.source.kind, 'git')

  write(path.join(repo, 'SKILL.md'), md('cloned', 'v2'))
  git(repo, 'commit', '-qam', 'two')
  s = (await api.check(['claude:cloned'])).find((x) => x.id === 'claude:cloned')!
  assert.equal(s.status, 'outdated')

  write(path.join(skills, 'cloned', 'notes.txt'), 'wip')
  assert.equal((await api.list()).find((x) => x.id === 'claude:cloned')!.status, 'modified')
  await assert.rejects(api.update('claude:cloned'), /has-local-changes/)
  fs.rmSync(path.join(skills, 'cloned', 'notes.txt'))

  s = await api.update('claude:cloned')
  assert.equal(s.status, 'ok')
  assert.match(fs.readFileSync(path.join(skills, 'cloned', 'SKILL.md'), 'utf8'), /v2/)
})

test('an unreachable source leaves the last result alone', async () => {
  const before = (await api.list()).find((s) => s.id === 'claude:foo')!
  await api.setSource('claude:foo', { kind: 'git', url: pathToFileURL(path.join(tmp, 'gone')).href, ref: 'main', subdir: 'skills/foo' })
  const after = (await api.check(['claude:foo'])).find((s) => s.id === 'claude:foo')!
  assert.equal(after.checkedAt, before.checkedAt)
})

test('cleanup', () => fs.rmSync(tmp, { recursive: true, force: true }))
