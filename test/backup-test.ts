// Backup to a Google Drive: the sign-in (loopback + PKCE), the encrypted file in the app folder, restore through the
// import review, and that two accounts never see each other's backup. Google is a local server (JOLTY_GOOGLE_MOCK).
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { connect, decryptBackup, disconnect, encryptBackup, list, remote, restore, run, setConfig, setPassword, status } from '../src/main/backup'
import { apply, openPackBuffer } from '../src/main/share-pack'
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

test('connect, back up everything, restore on another PC, undo', async () => {
  const one = pc()
  assert.equal(status('google').configured, false)
  await assert.rejects(connect('google', browser))
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
  await assert.rejects(run('google'), /parol/i)
  assert.throws(() => setPassword('google', 'short'))
  assert.equal(setPassword('google', 'correct horse battery').hasPassword, true)
  assert.equal(await remote('google'), null)

  personalize(one.home)
  google.state.fail401 = 1 // one refused token on the way: the call is retried with a new one
  const r = await run('google')
  assert.ok(r.items >= 6, `items ${r.items}`)
  const stored = google.drive.get(A.sub)!.data
  for (const plain of ['tok-123', 'ana.private', SECRET_NOTE, 'JOLTYPACK', 'CLAUDE.md']) assert.ok(!stored.includes(plain), `${plain} leaked into Drive`)
  assert.equal((await remote('google'))?.bytes, stored.length)
  assert.equal(status('google').lastBackupItems, r.items)
  // a second backup replaces the file instead of adding one
  await run('google')
  assert.equal(google.drive.size, 1)

  // another PC: nothing here, same Google account
  const two = pc()
  fs.writeFileSync(path.join(two.home, '.claude.json'), JSON.stringify({ userID: 'other-pc', mcpServers: { docs: { command: 'old' } } }))
  assert.equal(status('google').connected, false)
  setConfig('google', { clientId: 'cid', clientSecret: 'sec' })
  google.state.next = A
  await connect('google', browser)
  assert.equal(status('google').hasPassword, false)
  await assert.rejects(restore('google'), /parol/i)
  await assert.rejects(restore('google', 'wrong password'), /Parola/)
  assert.equal(fs.existsSync(path.join(two.home, '.claude', 'CLAUDE.md')), false)

  const preview = await restore('google', 'correct horse battery')
  assert.equal(status('google').hasPassword, true, 'a password typed on the new PC is kept')
  assert.ok(preview.items.some((i) => i.key === 'mcp:docs' && i.state === 'different'))
  assert.ok(preview.items.some((i) => i.key === 'mcp:remote' && i.state === 'new'))
  const decisions = Object.fromEntries(preview.items.map((i) => [i.key, 'overwrite' as const]))
  const done = await apply(preview.previewId, decisions)
  assert.deepEqual(done.failed, [])

  // exactly what was there, secrets and personal text included
  assert.equal(fs.readFileSync(path.join(two.home, '.claude', 'skills', 'mine', 'SKILL.md'), 'utf8'), fs.readFileSync(path.join(one.home, '.claude', 'skills', 'mine', 'SKILL.md'), 'utf8'))
  assert.equal(fs.readFileSync(path.join(two.home, '.claude', 'skills', 'mine', 'scripts', '.env'), 'utf8'), `KEY=${SECRET_NOTE}\n`)
  assert.equal(fs.readFileSync(path.join(two.home, '.claude', 'CLAUDE.md'), 'utf8'), 'My rules, path C:\\Users\\ana\\work\n')
  assert.equal(fs.readFileSync(path.join(two.home, '.claude', 'commands', 'go.md'), 'utf8'), 'go\n')
  const cfg = JSON.parse(fs.readFileSync(path.join(two.home, '.claude.json'), 'utf8'))
  assert.equal(cfg.userID, 'other-pc', 'the rest of ~/.claude.json is not touched')
  assert.deepEqual(cfg.mcpServers.docs, { type: 'stdio', command: 'npx', args: ['-y', 'docs'], env: { TOKEN: 'tok-123' } })
  assert.equal(cfg.mcpServers.remote.headers.Authorization, 'Bearer abc')
  const set = loadSettings()
  assert.equal(set.mascotSize, 'small')
  assert.equal(set.lowPower, 'on')
  assert.equal(set.notifySound, false)

  await undoImport(done.importId)
  const back = JSON.parse(fs.readFileSync(path.join(two.home, '.claude.json'), 'utf8'))
  assert.deepEqual(back.mcpServers, { docs: { command: 'old' } })
  assert.equal(fs.existsSync(path.join(two.home, '.claude', 'CLAUDE.md')), false)
})

test('two accounts never see each other, and disconnecting forgets the account here', async () => {
  const x = pc()
  setConfig('google', { clientId: 'cid', clientSecret: 'sec' })
  await sync(A)
  setPassword('google', 'password for ana')
  personalize(x.home)
  await run('google')
  const anaBlob = Buffer.from(google.drive.get(A.sub)!.data)

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
  await assert.rejects(restore('google', 'password for ana'), /niciun backup/i)
  setPassword('google', 'password for bob')
  fs.rmSync(path.join(x.home, '.claude', 'CLAUDE.md'))
  await run('google')
  assert.deepEqual(google.drive.get(A.sub)!.data, anaBlob, "Bob's backup left Ana's file alone")
  assert.notDeepEqual(google.drive.get(B.sub)!.data, anaBlob)

  // Ana's file in Bob's Drive (a copied file): refused although the password is right
  google.drive.set(B.sub, { ...google.drive.get(B.sub)!, data: anaBlob })
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
  assert.ok(fs.readdirSync(shared).includes('jolty-backup.enc'))
  assert.ok(!fs.readFileSync(path.join(shared, 'jolty-backup.enc')).includes('tok-123'))

  const two = pc()
  setConfig('folder', { path: shared })
  await connect('folder')
  const preview = await restore('folder', 'long enough password')
  assert.ok(preview.items.some((i) => i.key === 'mcp:docs'))
  const done = await apply(preview.previewId, Object.fromEntries(preview.items.map((i) => [i.key, 'overwrite' as const])))
  assert.deepEqual(done.failed, [])
  assert.equal(fs.readFileSync(path.join(two.home, '.claude', 'skills', 'mine', 'scripts', '.env'), 'utf8'), `KEY=${SECRET_NOTE}\n`)
})
