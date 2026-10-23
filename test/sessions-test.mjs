// Drives the built Jolty app on the mock model: a lead chat starts a session of its own through the app's MCP tool
// (own git worktree and branch), the session writes a file there, the lead waits for it, and the ledger is shared.
// Needs: python test/mocks/mock_anthropic.py 8766, JOLTY_DATA_DIR and HOME pointing at empty folders.
import { _electron as electron } from 'playwright-core'
import { execFileSync } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'

const out = process.env.SHOTS || path.resolve('shots')
const data = process.env.JOLTY_DATA_DIR
fs.mkdirSync(out, { recursive: true })
fs.mkdirSync(data, { recursive: true })
const project = fs.mkdtempSync(path.join(os.tmpdir(), 'jolty-sessions-'))
const git = (...a) => execFileSync('git', ['-C', project, '-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { encoding: 'utf8' }).trim()
git('init', '-q')
fs.writeFileSync(path.join(project, 'README.md'), '# Sessions\n')
git('add', '.')
git('commit', '-q', '-m', 'first')
fs.writeFileSync(
  path.join(data, 'profiles.json'),
  JSON.stringify([{ id: 'mock', name: 'DeepSeek (test)', engine: 'claude', auth: 'endpoint', isDefaultDir: true, baseUrl: process.env.MOCK_ANTHROPIC || 'http://127.0.0.1:8766', models: ['mock-model'], vision: false, color: '#e0a23b' }])
)
fs.writeFileSync(path.join(data, 'secrets.json'), JSON.stringify({ mock: { enc: false, value: 'sk-mock' } }))
fs.writeFileSync(path.join(data, 'settings.json'), JSON.stringify({ lastCwd: project, lastProfileId: 'mock' }))

const app = await electron.launch({
  executablePath: path.resolve('node_modules/.bin/electron'),
  args: ['--no-sandbox', path.resolve('out/main/index.js')],
  env: { ...process.env, JOLTY_DATA_DIR: data, HOME: process.env.HOME, JOLTY_TEST: '1' }
})
const win = await app.firstWindow()
await win.setViewportSize({ width: 1500, height: 920 })
const errors = []
const fails = []
win.on('pageerror', (e) => errors.push(String(e)))
win.on('console', (m) => m.type() === 'error' && errors.push(m.text()))
const check = (ok, what) => {
  console.log(ok ? 'ok  ' : 'FAIL', what)
  if (!ok) fails.push(what)
}
const shot = async (name) => {
  await win.waitForTimeout(400)
  await win.screenshot({ path: path.join(out, `${name}.png`) })
}
const send = async (text) => {
  await win.fill('.composer textarea', text)
  await win.keyboard.press('Enter')
}
// approves whatever the lead asks until its turn ends
const settle = async () => {
  for (let i = 0; i < 40; i++) {
    if (await win.locator('.permission .btn.primary').count()) await win.locator('.permission .btn.primary').first().click()
    if (!(await win.locator('.composer .btn.stop, .composer button[title*="Oprește"]').count()) && (await win.locator('.msg-assistant').count())) {
      const last = await win.locator('.msg-assistant').last().innerText()
      if (/^Gata/.test(last.trim())) return last
    }
    await win.waitForTimeout(1000)
  }
  return ''
}

await win.waitForSelector('.composer textarea', { timeout: 60000 })
const args = JSON.stringify({ title: 'Parte unu', brief: 'Scrie fisierul. RUN_WRITE WRITE_NAME=kid.txt WRITE_LINES=3' })
// the title (the first 60 characters) is quoted in the brief the session gets: keep the trigger out of it
await send(`Imparte treaba pe parti mici, fiecare cu propriul ei folder de lucru. RUN_MCP=mcp__jolty__start_session MCP_ARGS=${args}`)

// the started session appears in the Live list with its branch, and writes its file in its own worktree
// starting a session asks for approval (it is not a read-only tool)
await win.waitForSelector('.permission .btn.primary', { timeout: 60000 })
check(/start_session/.test(await win.locator('.permission').first().innerText()), 'starting a session asks the user first')
await win.locator('.permission .btn.primary').first().click()
await win.waitForSelector('.live-item .live-branch', { timeout: 60000 })
check(true, 'the started session is listed with a branch icon')
const lead = await win.locator('.live-item:not(:has(.live-branch)) .live-title').first().innerText().catch(() => '')
const wtRoot = path.join(data, 'worktrees')
let tree = ''
for (let i = 0; i < 40 && !tree; i++) {
  const found = fs.existsSync(wtRoot) ? fs.readdirSync(wtRoot, { recursive: true }).map(String).filter((f) => f.endsWith('kid.txt')) : []
  if (found.length) tree = path.join(wtRoot, found[0])
  else await win.waitForTimeout(1000)
}
check(Boolean(tree), `the session wrote kid.txt in a worktree under the data folder (${tree ? path.relative(data, tree) : 'not found'})`)
check(!fs.existsSync(path.join(project, 'kid.txt')), 'and not in the project folder')
const branches = git('branch', '--list', 'jolty/*')
check(/jolty\/parte-unu/.test(branches), `the branch exists in the repo: ${branches.replace(/\s+/g, ' ')}`)
await shot('sessions-1-started')
await settle()
void lead

// the lead waits for it and reads its answer; the ledger is written and read
await send('Asteapta. RUN_MCP=mcp__jolty__wait_for_sessions MCP_ARGS={}')
await win.waitForFunction(() => /Parte unu/.test(document.body.innerText) && document.querySelectorAll('.msg-assistant').length >= 2, null, { timeout: 120000 })
const body = await win.locator('.messages').innerText()
check(/branch jolty\/parte-unu|Parte unu/.test(body), 'wait_for_sessions reports the started session')
await settle()
await send('Notez. RUN_MCP=mcp__jolty__ledger_write MCP_ARGS={"text":"decis: foloseste worktree"}')
await settle()
await send('Citesc. RUN_MCP=mcp__jolty__ledger_read MCP_ARGS={}')
await win.waitForFunction(() => /decis: foloseste worktree/.test(document.body.innerText), null, { timeout: 60000 })
check(true, 'the ledger keeps what a session wrote')
const ledgers = fs.existsSync(data) ? fs.readdirSync(data, { recursive: true }).map(String).filter((f) => /ledger/i.test(f)) : []
check(ledgers.length > 0, `the ledger lives in the data folder (${ledgers[0]})`)
check(fs.readdirSync(project).filter((f) => !f.startsWith('.git')).join() === 'README.md', 'nothing was added to the project folder')
await shot('sessions-2-lead')

// the worktree has changes, so it stays after the session is removed
const kid = win.locator('.session-item:has(.live-branch), .session-item:has(svg.lucide-git-branch)').first()
check((await kid.count()) > 0, 'the started session is in the conversation list with a branch icon')
check(errors.length === 0, errors.length ? `renderer errors: ${errors.join(' | ')}` : 'no renderer errors')
await app.close()
if (fails.length) {
  console.log('FAILED:', fails.join('; '))
  process.exit(1)
}
console.log('sessions ok')
