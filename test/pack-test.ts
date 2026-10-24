// Share packs: the file format (untrusted input), what leaves this PC, and importing with overwrite choices and undo.
// Everything runs against a temporary home folder and data folder.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import zlib from 'node:zlib'
import { decodePack, encodePack, FORMAT, LIMITS, MAGIC, PackError, safeRel, safeSegment, type PackEntry } from '../src/main/share-pack-format'
import { exportProfile, exportSchedule, exportSettings, localItems } from '../src/main/share-pack-local'
import { apply, items as packItems, openPackFile, writePack } from '../src/main/share-pack'
import { personalIn } from '../src/main/share-pack-personal'
import { undoImport } from '../src/main/share-pack-apply'
import { loadProfiles, saveProfiles, saveSchedules, saveSettings } from '../src/main/store'
import type { Profile } from '../src/shared/types'

const roots: string[] = []
/** A new empty home and data folder; the modules read both lazily. */
function fresh(): { home: string; data: string; tmp: string } {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jolty-pack-'))
  roots.push(tmp)
  const home = path.join(tmp, 'home')
  const data = path.join(tmp, 'data')
  fs.mkdirSync(home)
  fs.mkdirSync(data)
  process.env.HOME = home
  process.env.USERPROFILE = home
  process.env.JOLTY_DATA_DIR = data
  return { home, data, tmp }
}
test.after(() => {
  for (const r of roots) fs.rmSync(r, { recursive: true, force: true })
})

const META = { format: FORMAT, app: '0.0.1', name: 'test pack', createdAt: 1 }
const file = (path_: string, text: string, modifiedAt = 1000) => ({ path: path_, data: Buffer.from(text), modifiedAt })
const skillEntry = (folder: string, files: PackEntry['files'], modifiedAt = 1000): PackEntry => ({
  key: `skills:claude/${folder}`,
  part: 'skills',
  name: `claude/${folder}`,
  label: folder,
  modifiedAt,
  files
})
const skillMd = (name: string, body = 'x') => `---\nname: ${name}\ndescription: test\n---\n${body}\n`
const jsonEntry = (part: PackEntry['part'], name: string, value: unknown): PackEntry => ({
  key: `${part}:${name}`,
  part,
  name,
  label: name,
  modifiedAt: 0,
  files: [file('item.json', JSON.stringify(value), 0)]
})
const write = (dir: string, entries: PackEntry[], meta = META): string => {
  const f = path.join(dir, 'in.joltypack')
  fs.writeFileSync(f, encodePack(meta, entries))
  return f
}

/** Changes the header of an encoded pack and puts it back together. */
function patchHeader(buf: Buffer, edit: (h: Record<string, any>) => void): Buffer {
  const hlen = buf.readUInt32BE(MAGIC.length)
  const start = MAGIC.length + 4
  const h = JSON.parse(buf.subarray(start, start + hlen).toString('utf8'))
  edit(h)
  const nh = Buffer.from(JSON.stringify(h))
  const len = Buffer.alloc(4)
  len.writeUInt32BE(nh.length)
  return Buffer.concat([MAGIC, len, nh, buf.subarray(start + hlen)])
}
const codeOf = (fn: () => unknown): string => {
  try {
    fn()
  } catch (e) {
    assert.ok(e instanceof PackError, `expected a PackError, got ${String(e)}`)
    return e.message
  }
  return 'no error'
}

// ---------------------------------------------------------------- format

test('a pack survives encode and decode', () => {
  const entries = [skillEntry('a', [file('SKILL.md', skillMd('a')), file('sub/dir/x.txt', 'hello')]), jsonEntry('settings', 'app', { mascot: true })]
  const d = decodePack(encodePack(META, entries))
  assert.equal(d.entries.length, 2)
  assert.equal(d.entries[0].files[1].path, 'sub/dir/x.txt')
  assert.equal(d.entries[0].files[1].data.toString(), 'hello')
  assert.equal(d.meta.name, 'test pack')
  assert.deepEqual(d.warnings, [])
})

test('an item whose content does not match its checksum is dropped with a warning', () => {
  const buf = encodePack(META, [skillEntry('a', [file('SKILL.md', skillMd('a'))]), skillEntry('b', [file('SKILL.md', skillMd('b'))])])
  const bad = patchHeader(buf, (h) => {
    h.items[0].files[0].sha256 = '0'.repeat(64)
  })
  const d = decodePack(bad)
  assert.deepEqual(
    d.entries.map((e) => e.name),
    ['claude/b']
  )
  assert.ok(d.warnings.includes('checksum-mismatch'))
})

test('not a pack, a cut pack and a newer format are refused', () => {
  assert.equal(codeOf(() => decodePack(Buffer.from('hello world, definitely not a pack'))), 'not-a-pack')
  const buf = encodePack(META, [skillEntry('a', [file('SKILL.md', skillMd('a'))])])
  assert.equal(codeOf(() => decodePack(buf.subarray(0, MAGIC.length + 6))), 'bad-header')
  assert.equal(codeOf(() => decodePack(patchHeader(buf, (h) => (h.format = FORMAT + 1)))), 'newer-format')
  assert.equal(codeOf(() => decodePack(Buffer.concat([buf.subarray(0, buf.length - 8), Buffer.from('garbage!')]))), 'bad-body')
})

test('unsafe names are refused', () => {
  const bad = ['../x', 'a/../b', '/etc/passwd', 'C:/x', 'C:\\x', 'a\\b', 'con.txt', 'NUL', 'aux/x', 'file.txt:stream', 'x.', 'x ', ' x', '', 'a//b', '.', '..', 'a/b\0c', 'lpt1.md', 'com¹']
  for (const p of bad) assert.equal(safeRel(p), false, JSON.stringify(p))
  for (const p of ['SKILL.md', 'a/b/c.txt', '.hidden', 'a-b_c.d', 'console.log', 'commander']) assert.equal(safeRel(p), true, p)
  assert.equal(safeSegment('x'.repeat(201)), false)

  const buf = encodePack(META, [skillEntry('a', [file('SKILL.md', skillMd('a')), file('ok.txt', 'x')])])
  for (const p of ['../evil', '..\\evil', '/abs', 'C:/Windows/x', 'a/../../b']) {
    assert.equal(codeOf(() => decodePack(patchHeader(buf, (h) => (h.items[0].files[1].path = p)))), 'unsafe-path', p)
  }
})

test('names that collide on Windows are refused', () => {
  const dup = (a: string, b: string) => decodePack(encodePack(META, [skillEntry('a', [file(a, 'x'), file(b, 'y')])]))
  assert.equal(codeOf(() => dup('Readme.md', 'README.MD')), 'duplicate-path')
  assert.equal(codeOf(() => dup('a', 'A/b')), 'duplicate-path')
  assert.equal(codeOf(() => dup('a/b', 'a')), 'duplicate-path')
  assert.equal(codeOf(() => decodePack(encodePack(META, [skillEntry('a', [file('SKILL.md', 'x')]), skillEntry('A', [file('SKILL.md', 'x')])]))), 'duplicate-key')
})

test('over the limits is refused', () => {
  const one = encodePack(META, [skillEntry('a', [file('SKILL.md', skillMd('a'))])])
  assert.equal(codeOf(() => decodePack(patchHeader(one, (h) => (h.items[0].files[0].size = LIMITS.file + 1)))), 'too-large')
  assert.equal(codeOf(() => decodePack(patchHeader(one, (h) => (h.items = Array.from({ length: LIMITS.items + 1 }, (_, i) => ({ ...h.items[0], key: `skills:claude/s${i}` })))))), 'too-many-items')
  // a header that declares a little and a body that inflates to more than the limit
  const bomb = zlib.gzipSync(Buffer.alloc(LIMITS.total + 1024, 0))
  const hlen = one.readUInt32BE(MAGIC.length)
  const head = one.subarray(0, MAGIC.length + 4 + hlen)
  assert.equal(codeOf(() => decodePack(Buffer.concat([head, bomb]))), 'too-large')
  assert.equal(codeOf(() => decodePack(Buffer.alloc(LIMITS.packFile + 1))), 'too-large')
  // a header length that points past the end
  const lie = Buffer.from(one)
  lie.writeUInt32BE(LIMITS.header + 1, MAGIC.length)
  assert.equal(codeOf(() => decodePack(lie)), 'bad-header')
})

test('a pack from a newer app warns, one from an unknown part is skipped', () => {
  const { tmp } = fresh()
  const f = write(tmp, [skillEntry('a', [file('SKILL.md', skillMd('a'))])], { ...META, app: '99.0.0' })
  assert.ok(openPackFile(f).warnings.includes('newer-app-version'))
  const buf = patchHeader(encodePack(META, [skillEntry('a', [file('SKILL.md', skillMd('a'))])]), (h) => {
    h.items.push({ key: 'wormhole:x', part: 'wormhole', label: 'x', modifiedAt: 1, files: [] })
  })
  assert.ok(decodePack(buf).warnings.includes('unknown-parts'))
})

// ---------------------------------------------------------------- what leaves

test('secrets never go into a pack', () => {
  const { home, tmp } = fresh()
  const dir = path.join(home, '.claude', 'skills', 'leaky')
  fs.mkdirSync(path.join(dir, 'sub'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'SKILL.md'), skillMd('leaky'))
  fs.writeFileSync(path.join(dir, '.env'), 'TOKEN=abc')
  fs.writeFileSync(path.join(dir, 'credentials.json'), '{}')
  fs.writeFileSync(path.join(dir, 'sub', 'notes.txt'), 'key sk-ant-api03-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')
  fs.writeFileSync(path.join(dir, 'sub', 'ok.txt'), 'fine')

  saveSettings({ mascot: true, language: 'ro', computerTrusted: ['notepad.exe'], browserProfile: 'Default', lastCwd: 'C:\\secret' } as never)
  assert.deepEqual(exportSettings(loadSettingsForTest()), { mascot: true, language: 'ro' })
  assert.deepEqual(exportSettings({ language: '../../x', mascot: 'yes', browserMode: 'nope' }), {})

  const p: Profile = {
    id: 'id-1', name: 'Work', engine: 'claude', auth: 'endpoint', isDefaultDir: false, color: '#fff',
    baseUrl: 'https://user:pw@api.example.com/v1/?token=abc#frag', hasSecret: true, hasCookie: true, models: ['m1', 'bad model!'], dir: 'C:\\x'
  } as never
  const e = exportProfile(p)!
  assert.deepEqual(Object.keys(e).sort(), ['auth', 'baseUrl', 'color', 'engine', 'models', 'name'])
  assert.equal(e.baseUrl, 'https://api.example.com/v1')
  assert.deepEqual(e.models, ['m1'])
  assert.equal(exportProfile({ ...p, baseUrl: 'https://h.example.com/sk-ant-api03-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' })?.baseUrl, undefined)
  assert.equal(exportProfile({ ...p, isDefaultDir: true }), undefined)
  assert.equal(exportProfile({ ...p, engine: 'hermes' }), undefined)

  const task = { id: 't', name: 'Nightly', prompt: 'use sk-ant-api03-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', profileId: 'id-1', cwd: 'C:\\x', permissionMode: 'autoEdit', enabled: true, schedule: { kind: 'every', minutes: 60 }, createdAt: 5 }
  assert.deepEqual(Object.keys(exportSchedule(task, [p])!).sort(), ['name', 'permissionMode', 'profileName', 'prompt', 'schedule'])
  saveProfiles([p])
  saveSchedules([task as never])

  const items = localItems()
  const out = writePack({ keys: items.map((i) => i.key), name: 'all' }, path.join(tmp, 'out.joltypack'))
  assert.deepEqual(out.skipped.map((s) => s.file).sort(), ['.env', 'credentials.json', 'item.json', 'sub/notes.txt'])
  const d = decodePack(fs.readFileSync(out.file))
  const paths = d.entries.flatMap((x) => x.files.map((f) => f.path))
  assert.ok(paths.includes('SKILL.md') && paths.includes('sub/ok.txt'))
  assert.ok(!d.entries.some((x) => x.part === 'schedules'))
  const all = Buffer.concat(d.entries.flatMap((x) => x.files.map((f) => f.data))).toString()
  for (const s of ['sk-ant', 'TOKEN=abc', 'id-1', 'pw@', 'token=abc', 'notepad', 'secret', 'hasSecret', 'C:\\\\x']) assert.ok(!all.includes(s), s)
})

function loadSettingsForTest(): unknown {
  return JSON.parse(fs.readFileSync(path.join(process.env.JOLTY_DATA_DIR!, 'settings.json'), 'utf8'))
}

// ---------------------------------------------------------------- what comes in

const localSkill = (home: string, folder: string, text: string, mtime?: number): string => {
  const dir = path.join(home, '.claude', 'skills', folder)
  fs.mkdirSync(dir, { recursive: true })
  const f = path.join(dir, 'SKILL.md')
  fs.writeFileSync(f, text)
  if (mtime) fs.utimesSync(f, mtime / 1000, mtime / 1000)
  return f
}
const stateOf = (f: string, key: string): string => openPackFile(f).items.find((i) => i.key === key)!.state

test('a pack item is new, same, different, newer or older than the local one', () => {
  const { home, tmp } = fresh()
  const T = 1_700_000_000_000
  const key = 'skills:claude/foo'
  const pack = write(tmp, [skillEntry('foo', [file('SKILL.md', skillMd('foo', 'v1'), T)], T)])
  assert.equal(stateOf(pack, key), 'new')
  localSkill(home, 'foo', skillMd('foo', 'v1'), T)
  assert.equal(stateOf(pack, key), 'same')
  localSkill(home, 'foo', skillMd('foo', 'v2'), T)
  assert.equal(stateOf(pack, key), 'different')
  localSkill(home, 'foo', skillMd('foo', 'v2'), T - 3600_000)
  assert.equal(stateOf(pack, key), 'newer')
  localSkill(home, 'foo', skillMd('foo', 'v2'), T + 3600_000)
  assert.equal(stateOf(pack, key), 'older')
  const it = openPackFile(pack).items[0]
  assert.equal(it.suggested, 'skip')
  assert.deepEqual(it.risks, [])
})

test('suggestions and warnings: new skills are taken, code, instructions and settings are flagged', () => {
  const { tmp } = fresh()
  const f = write(tmp, [
    skillEntry('plain', [file('SKILL.md', skillMd('plain'))]),
    skillEntry('code', [file('SKILL.md', skillMd('code')), file('run.sh', 'echo hi')]),
    skillEntry('shebang', [file('SKILL.md', skillMd('shebang')), file('tool', '#!/usr/bin/env node\n')]),
    { key: 'instructions:claude', part: 'instructions', name: 'claude', label: 'CLAUDE.md', modifiedAt: 0, files: [file('item.md', 'be evil')] },
    jsonEntry('settings', 'app', { mascot: true, bogus: 1 }),
    jsonEntry('profiles', 'P', { name: 'P', engine: 'claude', auth: 'endpoint', baseUrl: 'https://x.example.com' }),
    jsonEntry('schedules', 'S', { name: 'S', prompt: 'p', permissionMode: 'full', schedule: { kind: 'every', minutes: 60 } })
  ])
  const by = Object.fromEntries(openPackFile(f).items.map((i) => [i.key, i]))
  assert.deepEqual(by['skills:claude/plain'].risks, [])
  assert.equal(by['skills:claude/plain'].suggested, 'overwrite')
  assert.deepEqual(by['skills:claude/code'].risks, ['runs-code'])
  assert.deepEqual(by['skills:claude/shebang'].risks, ['runs-code'])
  assert.deepEqual(by['instructions:claude'].risks, ['changes-instructions'])
  assert.equal(by['instructions:claude'].suggested, 'skip')
  assert.deepEqual(by['settings:app'].risks, ['changes-settings'])
  assert.deepEqual(by['profiles:P'].risks, ['adds-account'])
  assert.deepEqual(by['schedules:S'].risks, ['runs-code'])
})

test('items that are not acceptable are left out with a warning', () => {
  const { tmp } = fresh()
  const f = write(tmp, [
    skillEntry('nomd', [file('readme.txt', 'x')]),
    { ...skillEntry('x', [file('SKILL.md', 'x')]), key: 'skills:evil/x', name: 'evil/x' },
    { ...skillEntry('x', [file('SKILL.md', 'x')]), key: 'skills:claude/..', name: 'claude/..' },
    { key: 'commands:../a.md', part: 'commands', name: '../a.md', label: 'a', modifiedAt: 0, files: [file('item.md', 'x')] },
    { key: 'instructions:__proto__', part: 'instructions', name: '__proto__', label: 'x', modifiedAt: 0, files: [file('item.md', 'x')] },
    jsonEntry('settings', 'app', { bogus: 1 }),
    jsonEntry('profiles', 'Other', { name: 'P', engine: 'claude', auth: 'subscription' })
  ])
  const p = openPackFile(f)
  assert.equal(p.items.length, 0)
  assert.ok(p.warnings.includes('invalid-items'))
})

test('apply: skip leaves mine, overwrite keeps a backup, copy lives next to it, undo puts everything back', async () => {
  const { home, tmp } = fresh()
  const mine = localSkill(home, 'foo', skillMd('foo', 'mine'))
  const keep = localSkill(home, 'keep', skillMd('keep', 'mine'))
  const dup = localSkill(home, 'dup', skillMd('dup', 'mine'))
  const pack = write(tmp, [
    skillEntry('foo', [file('SKILL.md', skillMd('foo', 'theirs')), file('extra.txt', 'new file')]),
    skillEntry('keep', [file('SKILL.md', skillMd('keep', 'theirs'))]),
    skillEntry('dup', [file('SKILL.md', skillMd('dup', 'theirs'))]),
    skillEntry('fresh', [file('SKILL.md', skillMd('fresh', 'theirs'))])
  ], { ...META, author: 'Remus Test' })
  const prev = openPackFile(pack)
  const res = await apply(prev.previewId, { 'skills:claude/foo': 'overwrite', 'skills:claude/dup': 'copy', 'skills:claude/fresh': 'overwrite' })
  assert.deepEqual({ imported: res.imported, skipped: res.skipped, copied: res.copied, failed: res.failed }, { imported: 2, skipped: 1, copied: 1, failed: [] })

  const skills = path.join(home, '.claude', 'skills')
  assert.ok(fs.readFileSync(mine, 'utf8').includes('theirs'))
  assert.ok(fs.existsSync(path.join(skills, 'foo', 'extra.txt')))
  assert.ok(fs.readFileSync(keep, 'utf8').includes('mine'))
  assert.ok(fs.readFileSync(dup, 'utf8').includes('mine'))
  const copyDir = path.join(skills, 'dup-remus-test')
  assert.ok(fs.readFileSync(path.join(copyDir, 'SKILL.md'), 'utf8').includes('name: dup-remus-test'))
  assert.ok(fs.existsSync(path.join(skills, 'fresh', 'SKILL.md')))
  assert.deepEqual(fs.readdirSync(skills).sort(), ['dup', 'dup-remus-test', 'foo', 'fresh', 'keep'], 'no temporary folders left behind')
  // the same preview cannot be applied twice
  await assert.rejects(apply(prev.previewId, {}), /preview-expired/)
  // a second copy does not collide with the first
  const again = await apply(openPackFile(pack).previewId, { 'skills:claude/dup': 'copy' })
  assert.equal(again.copied, 1)
  assert.ok(fs.existsSync(path.join(skills, 'dup-remus-test-2')))
  await undoImport(again.importId)
  assert.ok(!fs.existsSync(path.join(skills, 'dup-remus-test-2')))

  await undoImport(res.importId)
  assert.ok(fs.readFileSync(mine, 'utf8').includes('mine'))
  assert.ok(!fs.existsSync(path.join(skills, 'foo', 'extra.txt')))
  assert.ok(!fs.existsSync(path.join(skills, 'fresh')))
  assert.ok(!fs.existsSync(copyDir))
  assert.deepEqual(fs.readdirSync(skills).sort(), ['dup', 'foo', 'keep'])
  await undoImport(res.importId) // a second undo does nothing
  await assert.rejects(undoImport('../../x'), /unknown-import/)
})

test('apply never writes through a link', async (t) => {
  const { home, tmp } = fresh()
  const outside = path.join(tmp, 'outside')
  fs.mkdirSync(outside)
  fs.writeFileSync(path.join(outside, 'keep.txt'), 'safe')
  const skills = path.join(home, '.claude', 'skills')
  fs.mkdirSync(skills, { recursive: true })
  try {
    fs.symlinkSync(outside, path.join(skills, 'foo'), 'junction')
  } catch {
    t.skip('no permission to create links here')
    return
  }
  const pack = write(tmp, [skillEntry('foo', [file('SKILL.md', skillMd('foo'))])])
  const res = await apply(openPackFile(pack).previewId, { 'skills:claude/foo': 'overwrite' })
  assert.equal(res.failed.length, 1)
  assert.deepEqual(fs.readdirSync(outside), ['keep.txt'])
})

test('instructions: overwrite keeps the old file in the backup and undo restores it', async () => {
  const { home, tmp } = fresh()
  const f = path.join(home, '.claude', 'CLAUDE.md')
  fs.mkdirSync(path.dirname(f), { recursive: true })
  fs.writeFileSync(f, 'mine')
  const pack = write(tmp, [{ key: 'instructions:claude', part: 'instructions', name: 'claude', label: 'CLAUDE.md', modifiedAt: 0, files: [file('item.md', 'theirs', 0)] }])
  const res = await apply(openPackFile(pack).previewId, { 'instructions:claude': 'overwrite' })
  assert.equal(fs.readFileSync(f, 'utf8'), 'theirs')
  await undoImport(res.importId)
  assert.equal(fs.readFileSync(f, 'utf8'), 'mine')
})

test('settings, profiles and tasks: import is limited to safe fields, a main account is never rewritten, undo restores', async () => {
  const { tmp } = fresh()
  const main: Profile = { id: 'main-id', name: 'Main', engine: 'claude', auth: 'subscription', isDefaultDir: true, color: '#111111' }
  const mine: Profile = { id: 'w-id', name: 'Work', engine: 'claude', auth: 'endpoint', isDefaultDir: false, color: '#222222', baseUrl: 'https://a.example.com', hasSecret: true, models: ['a'] }
  saveProfiles([main, mine])
  saveSettings({ mascot: false, language: 'ro' })
  fs.writeFileSync(path.join(process.env.JOLTY_DATA_DIR!, 'secrets.json'), JSON.stringify({ 'w-id': 'enc-key', 'main-id': 'enc-main' }))

  const pack = write(tmp, [
    jsonEntry('settings', 'app', { mascot: true, bogus: 1 }),
    jsonEntry('profiles', 'Main', { name: 'Main', engine: 'codex', auth: 'endpoint', baseUrl: 'https://evil.example.com' }),
    jsonEntry('profiles', 'Work', { name: 'Work', engine: 'claude', auth: 'endpoint', baseUrl: 'https://b.example.com', models: ['b'] }),
    jsonEntry('schedules', 'Nightly', { name: 'Nightly', prompt: 'do it', permissionMode: 'full', schedule: { kind: 'every', minutes: 60 }, profileName: 'Work' })
  ], { ...META, author: 'Bob' })
  const prev = openPackFile(pack)
  assert.equal(prev.items.find((i) => i.key === 'profiles:Main')!.state, 'different')
  const res = await apply(prev.previewId, { 'settings:app': 'overwrite', 'profiles:Main': 'overwrite', 'profiles:Work': 'overwrite', 'schedules:Nightly': 'overwrite' })
  assert.deepEqual(res.failed, [])

  const after = loadProfiles()
  assert.deepEqual(after.find((p) => p.id === 'main-id'), main, 'the main account is untouched')
  assert.ok(after.some((p) => p.name === 'Main-bob' && p.engine === 'codex' && !p.isDefaultDir), 'it came in as a separate profile')
  const work = after.find((p) => p.id === 'w-id')!
  assert.equal(work.baseUrl, 'https://b.example.com')
  assert.equal(work.hasSecret, false, 'a key does not follow its profile to another endpoint')
  const secrets = () => JSON.parse(fs.readFileSync(path.join(process.env.JOLTY_DATA_DIR!, 'secrets.json'), 'utf8'))
  assert.equal(secrets()['w-id'], undefined)
  assert.equal(secrets()['main-id'], 'enc-main')
  const st = loadSettingsForTest() as Record<string, unknown>
  assert.equal(st.mascot, true)
  assert.equal(st.bogus, undefined)
  const task = JSON.parse(fs.readFileSync(path.join(process.env.JOLTY_DATA_DIR!, 'schedules.json'), 'utf8'))[0]
  assert.equal(task.enabled, false, 'an imported task waits switched off')
  assert.equal(task.profileId, 'w-id')

  await undoImport(res.importId)
  assert.deepEqual(loadProfiles(), [main, mine])
  assert.equal(secrets()['w-id'], 'enc-key')
  assert.equal((loadSettingsForTest() as Record<string, unknown>).mascot, false)
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(process.env.JOLTY_DATA_DIR!, 'schedules.json'), 'utf8')), [])
})

test('personal information is recognised by kind, placeholders and plain text are not', () => {
  const kinds = (t: string): string => [...personalIn(t, 'zorro')].sort().join(',')
  assert.equal(kinds('write to ana.pop@gmail.com'), 'email')
  assert.equal(kinds('contact: you@example.com, noreply@github.com, bot@users.noreply.github.com'), '')
  assert.equal(kinds('call +40 722 123 456 or 0722 123 456'), 'phone')
  assert.equal(kinds('IBAN DE89 3704 0044 0532 0130 00'), 'bank')
  assert.equal(kinds('IBAN DE89 3704 0044 0532 0130 03'), '')
  assert.equal(kinds('card 4111 1111 1111 1111'), 'card')
  assert.equal(kinds('id 1234567890123457'), '')
  assert.equal(kinds('see C:\\Users\\Ana\\Documents and /home/ana/x'), 'home-path')
  assert.equal(kinds('C:\\Users\\Public\\x and /home/user/x'), '')
  assert.equal(kinds('made by Zorro'), 'account-name')
  assert.equal(kinds('Use the zorroish approach. Version 1.2.3, port 8080, 2026-10-24'), '')
})


test('personal information is replaced by placeholders in the pack, the rest of the item travels', () => {
  const { home, tmp } = fresh()
  const mk = (n: string, text: string): void => {
    fs.mkdirSync(path.join(home, '.claude', 'skills', n), { recursive: true })
    fs.writeFileSync(path.join(home, '.claude', 'skills', n, 'SKILL.md'), `---\nname: ${n}\ndescription: d\n---\n${text}\n`)
  }
  mk('clean', 'Do the thing.')
  mk('mine', 'Reply to ana.pop@gmail.com about the invoice, call +40 722 123 456, files in C:\\Users\\Ana\\Docs.')
  return packItems().then((list) => {
    assert.deepEqual(list.find((i) => i.key === 'skills:claude/mine')?.personal, ['email', 'home-path', 'phone'])
    assert.equal(list.find((i) => i.key === 'skills:claude/clean')?.personal, undefined)
    const out = writePack({ keys: ['skills:claude/clean', 'skills:claude/mine'], name: 'a' }, path.join(tmp, 'a.joltypack'))
    assert.equal(out.items, 2)
    assert.equal(out.redacted, 1)
    const text = decodePack(fs.readFileSync(out.file)).entries.flatMap((e) => e.files.map((f) => f.data.toString())).join('\n')
    assert.ok(text.includes('Reply to <email> about the invoice, call <phone>, files in C:\\Users\\<user>\\Docs.'))
    assert.ok(!/gmail|722 123/i.test(text))
  })
})
