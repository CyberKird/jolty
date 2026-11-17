// Incremental backup round trip through the folder provider: a seeded PC backs up, changes a little and backs up
// again (only the changed chunks travel, measured), then a NEW PC with other folders downloads, resumes a cut-off
// download, refuses a tampered pack, applies the restore without losing its own files, and ends up with the same
// files as the first PC (paths mapped onto its own folders). Secrets, caches and models never leave the first PC.
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { folder } from '../src/main/backup/providers/folder'
import { backupVault, keysFor, storeOf, forgetKeys } from '../src/main/backup/vault'
import { download, newestVersion } from '../src/main/backup/vault-read'
import { applyPendingRestore, claudeDirName, STAGING } from '../src/main/backup/vault-apply'
import { HEAD, readHead, type Store } from '../src/main/backup/vault-format'

const roots: string[] = []
test.after(() => {
  for (const r of roots) fs.rmSync(r, { recursive: true, force: true })
})

function pc(name: string): { home: string; data: string } {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), `jolty-vault-${name}-`))
  roots.push(tmp)
  const home = path.join(tmp, 'home', name)
  const data = path.join(tmp, 'AppData', 'Jolty')
  fs.mkdirSync(home, { recursive: true })
  fs.mkdirSync(data, { recursive: true })
  process.env.HOME = home
  process.env.USERPROFILE = home
  process.env.JOLTY_DATA_DIR = data
  return { home, data }
}

const write = (file: string, data: string | Buffer): void => {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, data)
}

/** A store that counts what goes up and down, and can fail on purpose. */
function counted(inner: Store): Store & { up: number; down: number; gets: number; failGetAfter?: number } {
  const s = {
    up: 0,
    down: 0,
    gets: 0,
    failGetAfter: undefined as number | undefined,
    put: async (n: string, d: Buffer) => {
      s.up += d.length
      await inner.put(n, d)
    },
    get: async (n: string) => {
      if (s.failGetAfter !== undefined && n.startsWith('jolty2-p-') && s.gets++ >= s.failGetAfter) throw new Error('network down')
      const d = await inner.get(n)
      s.down += d.length
      return d
    },
    find: (n: string) => inner.find(n),
    remove: (n: string) => inner.remove(n)
  }
  return s
}

const PASS = 'correct horse battery'
const vaultDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jolty-vault-store-'))
roots.push(vaultDir)
const cfg = { path: vaultDir }

// ---------------------------------------------------------------- first PC
const A = pc('ana')
const project = path.join(A.home, 'work', 'site')
fs.mkdirSync(project, { recursive: true })
const sid = 'aaaaaaaa-1111-2222-3333-444444444444'
const sid2 = 'bbbbbbbb-1111-2222-3333-444444444444'
write(path.join(A.data, 'settings.json'), JSON.stringify({ theme: 'frost', lastCwd: project, model: 'opus' }, null, 2))
write(path.join(A.data, 'profiles.json'), JSON.stringify([{ id: 'p1', engine: 'claude', name: 'Main', isDefaultDir: true }, { id: 'p2', engine: 'claude', name: 'Work' }], null, 2))
write(path.join(A.data, 'sessions.json'), JSON.stringify([{ id: 's1', profileId: 'p1', engine: 'claude', cwd: project, engineSessionId: sid, title: 'one' }, { id: 's2', profileId: 'p2', engine: 'claude', cwd: project, engineSessionId: sid2, title: 'two' }], null, 2))
write(path.join(A.data, 'schedules.json'), '[]')
write(path.join(A.data, 'secrets.json'), JSON.stringify({ p1: { enc: false, value: 'sk-ant-secret' } }))
write(path.join(A.data, 'models', 'ggml.bin'), randomBytes(2 * 1024 * 1024))
write(path.join(A.data, 'mcp-share-cache.json'), '{}')
write(path.join(A.data, 'ledgers', 'site.md'), '# ledger\n')
// chats: many small ones and two big ones (random = incompressible, so sizes are honest)
for (let i = 0; i < 40; i++) write(path.join(A.data, 'transcripts', `t${i}.json`), JSON.stringify([{ role: 'user', text: `hello ${i} `.repeat(200) }]))
write(path.join(A.data, 'transcripts', 'big.json'), randomBytes(6 * 1024 * 1024))
const engineDir = path.join(A.data, 'profiles', 'p2', 'claude')
write(path.join(engineDir, 'projects', claudeDirName(project), `${sid2}.jsonl`), randomBytes(5 * 1024 * 1024))
write(path.join(engineDir, 'CLAUDE.md'), 'rules\n')
write(path.join(engineDir, '.credentials.json'), '{"claudeAiOauth":{"refreshToken":"rt"}}')
write(path.join(engineDir, 'shell-snapshots', 'snap.sh'), 'echo')
write(path.join(A.home, '.claude', 'projects', claudeDirName(project), `${sid}.jsonl`), randomBytes(3 * 1024 * 1024))
write(path.join(A.home, '.claude', 'projects', claudeDirName(project), 'someone-else.jsonl'), 'not ours')
write(path.join(A.home, '.claude', 'skills', 'mine', 'SKILL.md'), '---\nname: mine\ndescription: test\n---\nbody\n')

const store = counted(storeOf(folder, cfg))
const keys = (await keysFor('folder:a', store, PASS, true))!

test('first backup uploads everything once, secrets and caches stay home', async () => {
  const r = await backupVault('folder', store, keys)
  assert.equal(r.unchanged, false)
  const files = fs.readdirSync(vaultDir)
  assert.ok(files.includes(HEAD) && files.includes('jolty2-key'))
  assert.ok(files.filter((f) => f.startsWith('jolty2-p-')).length >= 2, 'big data is split in packs')
  console.log(`[measure] first: ${r.files} files, ${(r.raw / 1048576).toFixed(2)} MiB plain, uploaded ${(store.up / 1048576).toFixed(2)} MiB, used ${(r.used / 1048576).toFixed(2)} MiB`)
  const v = (await newestVersion(store, keys))!
  const paths = v.snap.files.map((f) => f.p)
  assert.ok(paths.includes('data/settings.json') && paths.includes('data/transcripts/big.json') && paths.includes('pack/personal'))
  assert.ok(paths.includes(`data/profiles/p2/claude/projects/${claudeDirName(project)}/${sid2}.jsonl`))
  assert.ok(paths.includes(`home/.claude/projects/${claudeDirName(project)}/${sid}.jsonl`))
  for (const bad of ['secrets.json', 'models/', '.credentials.json', 'shell-snapshots', 'mcp-share-cache', 'someone-else']) assert.ok(!paths.some((p) => p.includes(bad)), bad)
  // nothing readable in the storage
  for (const f of files) assert.ok(!fs.readFileSync(path.join(vaultDir, f)).includes('hello 1'), f)
})

test('second backup sends only what changed; a third with no change sends nothing', async () => {
  fs.appendFileSync(path.join(A.data, 'transcripts', 'big.json'), Buffer.from('{"role":"assistant","text":"new answer"}'))
  write(path.join(A.data, 'settings.json'), JSON.stringify({ theme: 'volt', lastCwd: project, model: 'opus' }, null, 2))
  const before = store.up
  const r = await backupVault('folder', store, keys)
  const sent = store.up - before
  console.log(`[measure] second (1 chat appended + settings): ${r.newChunks} new chunks, uploaded ${(sent / 1024).toFixed(1)} KiB of ${(r.raw / 1048576).toFixed(2)} MiB`)
  assert.equal(r.unchanged, false)
  assert.ok(r.newChunks <= 3, `new chunks ${r.newChunks}`)
  assert.ok(sent < 1.2 * 1024 * 1024, `sent ${sent}`)
  const before3 = store.up
  const r3 = await backupVault('folder', store, keys)
  assert.equal(r3.unchanged, true)
  assert.equal(store.up - before3, 0)
  console.log(`[measure] third (no change): uploaded ${store.up - before3} B`)
})

test('old versions are pruned, storage stays bounded', async () => {
  for (let i = 0; i < 7; i++) {
    write(path.join(A.data, 'ledgers', 'site.md'), `# ledger ${i}\n`)
    write(path.join(A.data, 'transcripts', 'churn.json'), randomBytes(512 * 1024))
    await backupVault('folder', store, keys)
  }
  const head = (await readHead(store, keys))!
  assert.equal(head.snaps.length, 5)
  const packs = fs.readdirSync(vaultDir).filter((f) => f.startsWith('jolty2-p-'))
  const snaps = fs.readdirSync(vaultDir).filter((f) => f.startsWith('jolty2-s-'))
  assert.equal(snaps.length, 5, 'dropped versions are deleted')
  assert.deepEqual(new Set(packs), new Set(Object.keys(head.packs)), 'no stray packs')
  console.log(`[measure] after 10 versions: ${packs.length} packs, ${(Object.values(head.packs).reduce((a, p) => a + p.bytes, 0) / 1048576).toFixed(2)} MiB`)
})

// ---------------------------------------------------------------- new PC
test('a new PC restores exactly, resumes, refuses tampering and keeps what it replaces', async () => {
  const snapshotOf = (root: string, skip: RegExp): Map<string, string> => {
    const out = new Map<string, string>()
    const walk = (d: string, rel: string): void => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const r = rel ? `${rel}/${e.name}` : e.name
        if (skip.test(r)) continue
        if (e.isDirectory()) walk(path.join(d, e.name), r)
        else out.set(r, fs.readFileSync(path.join(d, e.name)).toString('base64'))
      }
    }
    walk(root, '')
    return out
  }
  const oldData = snapshotOf(A.data, /^(secrets\.json|models|mcp-share-cache\.json|backup-state|profiles\/p2\/claude\/(\.credentials\.json|shell-snapshots))/)
  const oldHomeChat = fs.readFileSync(path.join(A.home, '.claude', 'projects', claudeDirName(project), `${sid}.jsonl`))

  const B = pc('bob')
  forgetKeys('folder:a')
  write(path.join(B.data, 'settings.json'), '{"theme":"glass"}')
  write(path.join(B.data, 'secrets.json'), '{"mine":1}')
  const s2 = counted(storeOf(folder, cfg))
  await assert.rejects(keysFor('folder:b', s2, 'wrong password', false), /parol/i)
  const k2 = (await keysFor('folder:b', s2, PASS, false))!
  const v = (await newestVersion(s2, k2))!
  const staging = path.join(B.data, STAGING)

  // cut off after one pack, then resumed: the second attempt skips what is done
  s2.failGetAfter = 1
  await assert.rejects(download(s2, k2, v.name, v.snap, staging), /network down/)
  s2.failGetAfter = undefined
  const firstGets = s2.down
  await download(s2, k2, v.name, v.snap, staging)
  const packsNeeded = new Set(Object.values(v.snap.blobs).map((l) => l[0])).size
  console.log(`[measure] restore: ${packsNeeded} packs, ${(s2.down / 1048576).toFixed(2)} MiB downloaded (${(firstGets / 1048576).toFixed(2)} before the cut)`)

  const report = applyPendingRestore(B.data, B.home)!
  assert.ok(report)
  assert.ok(!fs.existsSync(staging), 'staging removed')
  assert.ok(report.previous && fs.readFileSync(path.join(report.previous, 'data', 'settings.json'), 'utf8').includes('glass'), 'replaced file kept')
  assert.equal(fs.readFileSync(path.join(B.data, 'secrets.json'), 'utf8'), '{"mine":1}', 'own secrets untouched')
  assert.ok(report.missing.length === 1 && report.missing[0] === path.join(B.home, 'work', 'site'), 'missing project listed with its new path')

  const newData = snapshotOf(B.data, /^(secrets\.json|restore-|backup-state)/)
  const mapped = path.join(B.home, 'work', 'site')
  for (const [rel, b64] of oldData) {
    // the engine folder of the project is renamed for this PC's path
    const relHere = rel.replace(claudeDirName(project), claudeDirName(mapped))
    assert.ok(newData.has(relHere), `missing ${relHere}`)
    if (/^(sessions|settings)\.json$/.test(rel)) {
      const text = Buffer.from(newData.get(relHere)!, 'base64').toString('utf8')
      assert.ok(text.includes(JSON.stringify(mapped).slice(1, -1)) && !text.includes(JSON.stringify(project).slice(1, -1)), `${rel} paths mapped`)
    } else assert.equal(newData.get(relHere), b64, `content of ${rel}`)
  }
  assert.ok(fs.readFileSync(path.join(B.data, 'restore-pack.joltypack')).length > 0, 'pack of skills staged for import')
  assert.deepEqual(fs.readFileSync(path.join(B.home, '.claude', 'projects', claudeDirName(mapped), `${sid}.jsonl`)), oldHomeChat)
  assert.ok(!fs.existsSync(path.join(B.home, '.claude', 'projects', claudeDirName(mapped), 'someone-else.jsonl')))
})

test('a tampered pack is refused', async () => {
  const C = pc('carol')
  const s3 = storeOf(folder, cfg)
  const k3 = (await keysFor('folder:c', s3, PASS, false))!
  const v = (await newestVersion(s3, k3))!
  const pack = Object.values(v.snap.blobs)[0][0]
  const file = path.join(vaultDir, pack)
  const buf = fs.readFileSync(file)
  buf[40] ^= 0xff
  fs.writeFileSync(file, buf)
  await assert.rejects(download(s3, k3, v.name, v.snap, path.join(C.data, STAGING)), /deteriorat/)
  assert.equal(applyPendingRestore(C.data, C.home), null, 'nothing applied from an incomplete download')
})
