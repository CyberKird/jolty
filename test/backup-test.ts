// Backup to a Google Drive: the sign-in (loopback + PKCE), the encrypted incremental backup in the app folder, a full
// restore on another PC, the old single-file backup still restored through the import review, and that two accounts
// never see each other's backup. Google is a local server (JOLTY_GOOGLE_MOCK).
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { connect, decryptBackup, disconnect, encryptBackup, finishRestore, inspect, list, remote, report, restore, restoreAll, run, setAuto, setConfig, setPassword, status } from '../src/main/backup'
import { apply, backupKeys, buildPack, openPackBuffer } from '../src/main/share-pack'
import { config, pick } from '../src/main/backup/common'
import { applyPendingRestore } from '../src/main/backup/vault-apply'
import { runVault } from '../src/main/backup/vault-ops'
import { withTime } from '../src/main/use-time'
import { encodePack, FORMAT } from '../src/main/share-pack-format'
import { undoImport } from '../src/main/share-pack-apply'
import { A, B, startGoogleMock } from './mocks/google-mock.mjs'
import { estimateAiMs } from '../src/main/use-time'
import { loadSettings, saveSettings } from '../src/main/store'

const google = await startGoogleMock()
process.env.JOLTY_BACKUP_MOCK = google.url

const roots: string[] = []
/** A new empty home and data folder, like another PC. */
function pc(): { home: string; data: string } {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jolty-google-'))
  roots.push(tmp)
  const home = path.join(tmp, 'home')
  const data = path.join(tmp, 'data')
  fs.mkdirSync(home)
  fs.mkdirSync(data)
  process.env.HOME = home
  process.env.USERPROFILE = home
  process.env.JOLTY_DATA_DIR = data
  return { home, data }
}
/** Opening Google's page: the test is the browser, it follows the redirect back to the loopback port. */
const browser = async (url: string): Promise<void> => void (await fetch(url))
const sync = async (a: typeof A): Promise<void> => {
  google.state.next = a
  await connect('google', browser)
}
test.after(() => {
  google.server.close()
  for (const r of roots) fs.rmSync(r, { recursive: true, force: true })
})

const SECRET_NOTE = 'sk-ant-' + 'a'.repeat(40)
function personalize(home: string): void {
  fs.mkdirSync(path.join(home, '.claude', 'skills', 'mine', 'scripts'), { recursive: true })
  fs.writeFileSync(path.join(home, '.claude', 'skills', 'mine', 'SKILL.md'), '---\nname: mine\ndescription: test\n---\nMail me at ana.private@gmail.example\n')
  fs.writeFileSync(path.join(home, '.claude', 'skills', 'mine', 'scripts', '.env'), `KEY=${SECRET_NOTE}\n`)
  fs.mkdirSync(path.join(home, '.claude', 'commands'), { recursive: true })
  fs.writeFileSync(path.join(home, '.claude', 'commands', 'go.md'), 'go\n')
  fs.writeFileSync(path.join(home, '.claude', 'CLAUDE.md'), 'My rules, path C:\\Users\\ana\\work\n')
  fs.writeFileSync(
    path.join(home, '.claude.json'),
    JSON.stringify({
      userID: 'keep-me',
      projects: { x: 1 },
      mcpServers: { docs: { type: 'stdio', command: 'npx', args: ['-y', 'docs'], env: { TOKEN: 'tok-123' } }, remote: { type: 'http', url: 'https://mcp.example/x', headers: { Authorization: 'Bearer abc' } } }
    })
  )
  saveSettings({ mascotSize: 'small', lowPower: 'on', notifySound: false })
}

test('the backup is encrypted, wrong or altered data is refused', () => {
  const blob = encryptBackup(Buffer.from('secret text'), 'correct horse')
  assert.ok(!blob.includes('secret text'))
  assert.equal(decryptBackup(blob, 'correct horse').toString(), 'secret text')
  assert.throws(() => decryptBackup(blob, 'wrong password'), /Parola/)
  const bad = Buffer.from(blob)
  bad[bad.length - 1] ^= 1
  assert.throws(() => decryptBackup(bad, 'correct horse'))
  assert.throws(() => decryptBackup(Buffer.from('nope'), 'x'))
})

test('the AI time estimate counts turns that follow each other and skips long breaks', () => {
  const m = 60_000
  assert.equal(estimateAiMs([{ ts: 0 }, { ts: 5 * m }, { ts: 8 * m }, { ts: 60 * m }, { ts: 62 * m }]), 10 * m)
  assert.equal(estimateAiMs([]), 0)
})

/** A backup the way Jolty 0.31 and older made it: the whole pack in one encrypted file. */
async function legacyBackup(id: 'google' | 'folder', sub: string, password: string): Promise<void> {
  const p = pick(id)
  const { buf } = buildPack({ keys: backupKeys(), name: 'Jolty backup', author: 'old', note: sub }, true)
  await p.put(config(p), encryptBackup(withTime(buf), password))
}

/** Every object in one account's Drive app folder. */
const objects = (sub: string): Map<string, { data: Buffer }> => google.drive.get(sub) ?? new Map()

/** A full restore the way the page does it: what is there, download, restart (apply), then the pack outside the data folder. */
async function restoreHere(id: 'google' | 'folder', at: { home: string; data: string }, password?: string): Promise<void> {
  const info = await inspect(id, password)
  assert.ok(info.versions.length >= 1)
  await restoreAll(id, info.versions[0].name, password)
  assert.ok(applyPendingRestore(at.data, at.home))
  await finishRestore()
}

test('connect, back up incrementally, restore everything on another PC', async () => {
  const one = pc()
  assert.equal(status('google').configured, true, 'Jolty has a Google client of its own: nothing to fill in')
  setConfig('google', { clientId: 'cid', clientSecret: 'sec' })
  assert.equal(status('google').configured, true)
  assert.equal(list().find((e) => e.info.id === 'google')!.values.clientId, 'cid')
  assert.deepEqual(list().find((e) => e.info.id === 'google')!.saved, ['clientSecret'], 'the secret is saved but not sent to the page')
  assert.equal(status('google').connected, false)

  google.state.next = A
  const st = await connect('google', browser)
  assert.equal(st.connected, true)
  assert.equal(st.label, A.email)
  assert.equal(st.hasPassword, false)
  assert.equal(st.autoUpdate, true, 'a new connection updates by itself')
  assert.equal(setAuto('google', false).autoUpdate, false)
  assert.equal(setAuto('google', true).autoUpdate, true)
  await assert.rejects(run('google'), /parol/i)
  assert.throws(() => setPassword('google', 'short'))
  assert.equal(setPassword('google', 'correct horse battery').hasPassword, true)
  assert.equal(await remote('google'), null)

  personalize(one.home)
  fs.writeFileSync(path.join(one.data, 'use-time.json'), JSON.stringify({ since: 1000, appMs: 7000, aiMs: 5000, estimatedMs: 0 }))
  fs.mkdirSync(path.join(one.data, 'transcripts'), { recursive: true })
  fs.writeFileSync(path.join(one.data, 'transcripts', 's1.json'), JSON.stringify([{ role: 'user', text: 'hello from the old PC' }]))
  google.state.fail401 = 1 // one refused token on the way: the call is retried with a new one
  const r = await run('google')
  assert.ok(r.items >= 4, `items ${r.items}`)
  for (const [name, f] of objects(A.sub)) for (const plain of ['tok-123', 'ana.private', SECRET_NOTE, 'JOLTYPACK', 'CLAUDE.md', 'hello from']) assert.ok(!f.data.includes(plain), `${plain} leaked into Drive (${name})`)
  assert.ok((await remote('google'))!.bytes > 0)
  assert.equal(status('google').lastBackupItems, r.items)
  assert.ok(status('google').usedBytes! > 0)
  // nothing changed: nothing is added
  const count = objects(A.sub).size
  assert.equal((await run('google')).unchanged, true)
  assert.equal(objects(A.sub).size, count)

  // another PC: nothing here, same Google account
  const two = pc()
  fs.writeFileSync(path.join(two.home, '.claude.json'), JSON.stringify({ userID: 'other-pc', mcpServers: { docs: { command: 'old' } } }))
  setConfig('google', { clientId: 'cid', clientSecret: 'sec' })
  google.state.next = A
  await connect('google', browser)
  assert.equal(status('google').hasPassword, false)
  await assert.rejects(inspect('google'), /parol/i)
  await assert.rejects(inspect('google', 'wrong password'), /Parola/)
  // the password typed first: an automatic run must not put this empty PC over the backup
  setPassword('google', 'correct horse battery')
  const before = new Map([...objects(A.sub)].map(([n, f]) => [n, f.data.length]))
  assert.equal(await runVault('google', true), null)
  assert.equal(status('google').waitingFor?.host, os.hostname())
  assert.deepEqual(new Map([...objects(A.sub)].map(([n, f]) => [n, f.data.length])), before, 'nothing written')
  await restoreHere('google', two)
  assert.equal(status('google').waitingFor, undefined, 'restored: automatic runs may write again')
  assert.equal(status('google').hasPassword, true, 'a password typed on the new PC is kept')
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(two.data, 'use-time.json'), 'utf8')), { since: 1000, appMs: 7000, aiMs: 5000, estimatedMs: 0 })
  assert.equal(JSON.parse(fs.readFileSync(path.join(two.data, 'transcripts', 's1.json'), 'utf8'))[0].text, 'hello from the old PC')
  assert.equal(fs.readFileSync(path.join(two.home, '.claude', 'skills', 'mine', 'scripts', '.env'), 'utf8'), `KEY=${SECRET_NOTE}\n`)
  assert.equal(fs.readFileSync(path.join(two.home, '.claude', 'CLAUDE.md'), 'utf8'), 'My rules, path C:\\Users\\ana\\work\n')
  assert.equal(fs.readFileSync(path.join(two.home, '.claude', 'commands', 'go.md'), 'utf8'), 'go\n')
  const cfg = JSON.parse(fs.readFileSync(path.join(two.home, '.claude.json'), 'utf8'))
  assert.equal(cfg.userID, 'other-pc', 'the rest of ~/.claude.json is not touched')
  assert.deepEqual(cfg.mcpServers.docs, { type: 'stdio', command: 'npx', args: ['-y', 'docs'], env: { TOKEN: 'tok-123' } })
  const set = loadSettings()
  assert.equal(set.mascotSize, 'small')
  assert.equal(set.lowPower, 'on')
  assert.ok(report()!.personal! >= 3, 'skills, commands, instructions and MCP came back')
})

test('an old single-file backup still restores through the review, and can be undone', async () => {
  const one = pc()
  setConfig('google', { clientId: 'cid', clientSecret: 'sec' })
  await sync(A)
  setPassword('google', 'correct horse battery')
  personalize(one.home)
  google.drive.delete(A.sub)
  await legacyBackup('google', A.sub, 'correct horse battery')

  const two = pc()
  fs.writeFileSync(path.join(two.home, '.claude.json'), JSON.stringify({ userID: 'other-pc', mcpServers: { docs: { command: 'old' } } }))
  setConfig('google', { clientId: 'cid', clientSecret: 'sec' })
  await sync(A)
  const info = await inspect('google', 'correct horse battery')
  assert.ok(info.legacy && !info.versions.length, 'the page offers the old restore')
  await assert.rejects(restore('google'), /parol/i)
  await assert.rejects(restore('google', 'wrong password'), /Parola/)
  const preview = await restore('google', 'correct horse battery')
  assert.ok(preview.items.some((i) => i.key === 'mcp:docs' && i.state === 'different'))
  const done = await apply(preview.previewId, Object.fromEntries(preview.items.map((i) => [i.key, 'overwrite' as const])))
  assert.deepEqual(done.failed, [])
  assert.equal(fs.readFileSync(path.join(two.home, '.claude', 'CLAUDE.md'), 'utf8'), 'My rules, path C:\\Users\\ana\\work\n')
  await undoImport(done.importId)
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(two.home, '.claude.json'), 'utf8')).mcpServers, { docs: { command: 'old' } })
  assert.equal(fs.existsSync(path.join(two.home, '.claude', 'CLAUDE.md')), false)
})

test('two accounts never see each other, and disconnecting forgets the account here', async () => {
  const x = pc()
  google.drive.clear()
  setConfig('google', { clientId: 'cid', clientSecret: 'sec' })
  await sync(A)
  setPassword('google', 'password for ana')
  personalize(x.home)
  await run('google')
  const ana = new Map([...objects(A.sub)].map(([n, f]) => [n, Buffer.from(f.data)]))

  await disconnect('google')
  assert.equal(status('google').connected, false)
  assert.equal(status('google').hasPassword, false)
  assert.ok(!fs.readFileSync(path.join(x.data, 'secrets.json'), 'utf8').includes('backup:google:refresh'))
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(x.data, 'backup-accounts.json'), 'utf8')), {})
  await assert.rejects(run('google'), /conectat/i)

  await sync(B)
  assert.equal(status('google').label, B.email)
  assert.equal(status('google').hasPassword, false, "Ana's password does not follow to Bob")
  assert.equal(await remote('google'), null, "Bob's Drive is empty")
  await assert.rejects(inspect('google', 'password for ana'), /niciun backup/i)
  setPassword('google', 'password for bob')
  fs.rmSync(path.join(x.home, '.claude', 'CLAUDE.md'))
  await run('google')
  for (const [n, d] of ana) assert.deepEqual(objects(A.sub).get(n)!.data, d, "Bob's backup left Ana's files alone")
  assert.ok([...objects(B.sub).keys()].every((n) => !ana.has(n) || n === 'jolty2-key' || n === 'jolty2-head'))

  // Ana's old single file in Bob's Drive (a copied file): refused although the password is right
  google.drive.get(B.sub)!.clear()
  await sync(A)
  setPassword('google', 'password for ana')
  google.drive.delete(A.sub)
  await legacyBackup('google', A.sub, 'password for ana')
  const anaFile = objects(A.sub).get('jolty-backup.enc')!
  await sync(B)
  objects(B.sub).set('jolty-backup.enc', { ...anaFile })
  await assert.rejects(restore('google', 'password for ana'), /altui cont/i)
})

test('a pack from someone else cannot bring MCP servers; a backup can', () => {
  const entry = { key: 'mcp:evil', part: 'mcp' as const, name: 'evil', label: 'evil', modifiedAt: 0, files: [{ path: 'item.json', data: Buffer.from(JSON.stringify({ name: 'evil', config: { command: 'calc' } })), modifiedAt: 0 }] }
  const buf = encodePack({ format: FORMAT, app: '0.0.1', name: 'x', createdAt: 1 }, [entry])
  pc()
  assert.deepEqual(openPackBuffer(buf).items, [])
  assert.ok(openPackBuffer(buf).warnings.includes('unknown-parts'))
  assert.equal(openPackBuffer(buf, true).items.length, 1)
})

test('a folder works as a storage too (iCloud Drive, OneDrive or a USB drive are just folders): backup, restore elsewhere', async () => {
  const one = pc()
  const shared = fs.mkdtempSync(path.join(os.tmpdir(), 'jolty-shared-'))
  roots.push(shared)
  personalize(one.home)
  assert.equal(status('folder').configured, false)
  setConfig('folder', { path: shared })
  assert.equal((await connect('folder')).connected, true)
  assert.equal(status('google').connected, false, 'each storage has its own account')
  setPassword('folder', 'long enough password')
  await run('folder')
  const names = fs.readdirSync(shared)
  assert.ok(names.includes('jolty2-key') && names.includes('jolty2-head'))
  for (const n of names) assert.ok(!fs.readFileSync(path.join(shared, n)).includes('tok-123'), n)

  const two = pc()
  setConfig('folder', { path: shared })
  await connect('folder')
  await restoreHere('folder', two, 'long enough password')
  assert.equal(fs.readFileSync(path.join(two.home, '.claude', 'skills', 'mine', 'scripts', '.env'), 'utf8'), `KEY=${SECRET_NOTE}\n`)
})
