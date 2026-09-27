// End-to-end check of both engines through Jolty's main-process API, against mock model servers.
// Run with: npm run test:engines   (needs the mocks from test/README.md running)
import { app } from 'electron'
import fs from 'fs'
import os from 'os'
import path from 'path'
import type { ChatEvent, ChatItem } from '../src/shared/types'
import { Jolty } from '../src/main/jolty'
import * as store from '../src/main/store'

const events: ChatEvent[] = []
let failures = 0

function check(cond: boolean, what: string): void {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${what}`)
  if (!cond) failures++
}

function waitFor(pred: () => boolean, ms: number, what: string): Promise<void> {
  const start = Date.now()
  return new Promise((resolve) => {
    const t = setInterval(() => {
      if (pred()) {
        clearInterval(t)
        resolve()
      } else if (Date.now() - start > ms) {
        clearInterval(t)
        console.log(`TIMEOUT waiting for ${what}`)
        failures++
        resolve()
      }
    }, 200)
  })
}

function idleCount(sessionId: string): number {
  return events.filter((e) => e.type === 'status' && e.sessionId === sessionId && e.status !== 'running').length
}

function show(items: ChatItem[]): void {
  for (const it of items) {
    const text = 'text' in it ? it.text : it.kind === 'tool' ? `${it.title} [${it.status}] -> ${(it.output || '').slice(0, 80)}` : ''
    console.log(`   ${it.kind.padEnd(9)} ${text.replace(/\n/g, ' ').slice(0, 140)}`)
  }
}

app.whenReady().then(async () => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'jolty-proj-'))
  fs.writeFileSync(path.join(project, 'README.md'), '# test project\n')
  const jolty = new Jolty((e) => {
    events.push(e)
    if (e.type === 'permission') {
      console.log(`   permission asked: ${e.request.toolName} ${e.request.title}`)
      setTimeout(() => jolty.respond(e.sessionId, e.request.id, 'allow'), 200)
    }
  })

  // ---------------- Claude Code via an Anthropic-compatible endpoint ----------------
  if (process.env.TEST_CLAUDE !== '0') {
    const p = jolty.createProfile({ name: 'Mock Anthropic', engine: 'claude', auth: 'endpoint', baseUrl: process.env.MOCK_ANTHROPIC || 'http://127.0.0.1:8766', models: ['mock-model'], secret: 'sk-mock' })
    const status = await jolty.status(p.id)
    check(status.loggedIn, 'claude endpoint profile has a key')
    const models = await jolty.models(p.id)
    check(models[0]?.id === 'mock-model', 'claude endpoint models come from the profile')

    const s = await jolty.startSession({ profileId: p.id, cwd: project, permissionMode: 'ask' })
    await jolty.sendMessage(s.id, 'Salut! RUN_TOOL')
    await waitFor(() => idleCount(s.id) >= 1, 120000, 'claude turn 1')
    let items = jolty.history(s.id)
    show(items)
    check(events.some((e) => e.type === 'permission' && e.sessionId === s.id), 'claude asked for permission before Bash')
    const tool = items.find((i) => i.kind === 'tool') as Extract<ChatItem, { kind: 'tool' }> | undefined
    check(tool?.status === 'done' && (tool.output || '').includes('jolty-tool-ok'), 'claude ran the Bash tool and captured its output')
    check(items.some((i) => i.kind === 'assistant' && i.text.includes('am vazut rezultatul')), 'claude answered after the tool result')
    check(events.some((e) => e.type === 'delta' && e.sessionId === s.id), 'claude streamed text deltas')

    await jolty.sendMessage(s.id, 'Inca o intrebare')
    await waitFor(() => idleCount(s.id) >= 2, 120000, 'claude turn 2')
    items = jolty.history(s.id)
    check(items.filter((i) => i.kind === 'user').length === 2, 'claude kept one session across two turns')
    const meta = jolty.sessions().find((x) => x.id === s.id)
    check(Boolean(meta?.engineSessionId), `claude session id saved (${meta?.engineSessionId})`)

    const usage = jolty.usageSummary().find((u) => u.profileId === p.id)
    check((usage?.last24h.turns || 0) >= 2 && (usage?.last24h.tokens || 0) > 0, `usage recorded for claude (${JSON.stringify(usage?.last24h)})`)

    // resume from disk in a brand-new Jolty session (what "open an existing Claude Code session" does)
    const ext = await jolty.externalSessions(p.id, project)
    console.log(`   external claude sessions: ${ext.length}`)
    await jolty.removeSession(s.id)
    const ext2 = await jolty.externalSessions(p.id, project)
    check(ext2.some((e) => e.engineSessionId === meta?.engineSessionId), 'the Claude Code session is listed as an existing session')
    if (meta?.engineSessionId) {
      const r = await jolty.startSession({ profileId: p.id, cwd: project, permissionMode: 'ask', resumeEngineSessionId: meta.engineSessionId })
      const hist = jolty.history(r.id)
      show(hist)
      check(hist.filter((i) => i.kind === 'user').length >= 2, 'resumed Claude session shows its history')
      await jolty.sendMessage(r.id, 'Continuam')
      await waitFor(() => idleCount(r.id) >= 1, 120000, 'claude resumed turn')
      check(jolty.history(r.id).filter((i) => i.kind === 'assistant').length >= 3, 'resumed Claude session answers')
    }
  }

  // ---------------- vision bridge + live code drafts ----------------
  if (process.env.TEST_CLAUDE !== '0') {
    const url = process.env.MOCK_ANTHROPIC || 'http://127.0.0.1:8766'
    const eyes = jolty.createProfile({ name: 'Ochi (mock)', engine: 'claude', auth: 'endpoint', baseUrl: url, models: ['mock-vision'], secret: 'sk-mock', vision: true })
    const blind = jolty.createProfile({ name: 'Fara vision (mock)', engine: 'claude', auth: 'endpoint', baseUrl: url, models: ['mock-blind'], secret: 'sk-mock', vision: false })
    store.saveSettings({ visionProfileId: eyes.id })
    const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
    const s = await jolty.startSession({ profileId: blind.id, cwd: project, permissionMode: 'autoEdit' })
    await jolty.sendMessage(s.id, 'Ce vezi in poza? RUN_WRITE', [{ id: 'img1', name: 'captura.png', mime: 'image/png', data: png }])
    await waitFor(() => idleCount(s.id) >= 1, 120000, 'vision bridge turn')
    const items = jolty.history(s.id)
    show(items)
    const user = items.find((i) => i.kind === 'user') as Extract<ChatItem, { kind: 'user' }> | undefined
    check(user?.images?.length === 1, 'the chat keeps the attached image for display')
    check(items.some((i) => i.kind === 'notice' && i.text.includes('le descrie')), 'Jolty says another profile is describing the image')
    const log = fs.readFileSync(process.env.MOCK_ANTHROPIC_LOG!, 'utf8').trim().split('\n').map((l) => JSON.parse(l))
    check(log.some((r) => r.model === 'mock-vision' && r.has_image), 'the vision profile received the image')
    check(log.some((r) => r.model === 'mock-blind' && r.desc_in_prompt && !r.has_image), 'the blind model received a text description instead of the image')
    const drafts = events.filter((e) => e.type === 'draft' && e.sessionId === s.id) as Extract<ChatEvent, { type: 'draft' }>[]
    check(drafts.length >= 3, `live code: ${drafts.length} partial updates while the file was written`)
    check(drafts.some((d) => !d.done && d.content.length > 0 && d.content.length < 800) && drafts.some((d) => d.done && d.content.includes('line 40')), 'live code grows until the full file')
    check(drafts[0]?.path === 'live_demo.txt', 'live code knows the file path')
    check(fs.existsSync(path.join(project, 'live_demo.txt')), 'the file was actually written to disk')
  }

  // ---------------- Codex via mock Responses API ----------------
  if (process.env.TEST_CODEX !== '0') {
    const p = jolty.createProfile({ name: 'Mock Codex', engine: 'codex', auth: 'subscription' })
    const dir = path.join(process.env.JOLTY_DATA_DIR!, 'profiles', p.id, 'codex')
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(
      path.join(dir, 'config.toml'),
      [
        'model = "mock-model"',
        'model_provider = "mock"',
        '[model_providers.mock]',
        'name = "Mock Responses"',
        `base_url = "${process.env.MOCK_RESPONSES || 'http://127.0.0.1:8767'}/v1"`,
        'wire_api = "responses"',
        'supports_websockets = false',
        'requires_openai_auth = false'
      ].join('\n') + '\n'
    )
    const models = await jolty.models(p.id)
    check(models.length > 0, `codex model list (${models.slice(0, 3).map((m) => m.id).join(', ')})`)
    const st = await jolty.status(p.id)
    console.log(`   codex status: ${JSON.stringify(st)}`)
    const s = await jolty.startSession({ profileId: p.id, cwd: project, permissionMode: 'ask', model: 'mock-model' })
    await jolty.sendMessage(s.id, 'Salut Codex RUN_TOOL')
    await waitFor(() => idleCount(s.id) >= 1, 120000, 'codex turn')
    const items = jolty.history(s.id)
    show(items)
    check(items.some((i) => i.kind === 'assistant' && i.text.includes('ok from mock responses')), 'codex answered')
    const ctool = items.find((i) => i.kind === 'tool') as Extract<ChatItem, { kind: 'tool' }> | undefined
    check(Boolean(ctool) && (ctool!.output || '').includes('jolty-codex-ok'), 'codex ran the shell command and captured its output')
    check(events.some((e) => e.type === 'permission' && e.sessionId === s.id), 'codex asked for approval before running the command')
    const cusage = jolty.usageSummary().find((u) => u.profileId === p.id)
    check((cusage?.last24h.tokens || 0) > 0, `usage recorded for codex (${JSON.stringify(cusage?.last24h)})`)
    const meta = jolty.sessions().find((x) => x.id === s.id)
    check(Boolean(meta?.engineSessionId), `codex thread id saved (${meta?.engineSessionId})`)
    const ext = await jolty.externalSessions(p.id, project)
    console.log(`   external codex threads: ${ext.length}`)
    const hist = await jolty.codex.history(jolty.profile(p.id), meta!.engineSessionId!)
    check(hist.some((i) => i.kind === 'assistant'), 'codex thread history can be read back')

    // handoff Codex -> Claude
    if (process.env.TEST_CLAUDE !== '0') {
      const claudeProfile = jolty.profiles().find((x) => x.name === 'Mock Anthropic')!
      const h = await jolty.handoff(s.id, claudeProfile.id)
      await waitFor(() => idleCount(h.id) >= 1, 120000, 'handoff turn')
      const hItems = jolty.history(h.id)
      check(hItems.some((i) => i.kind === 'user' && i.text.includes('Preia conversația')), 'handoff shows a short message to the user')
      const log = fs.readFileSync(process.env.MOCK_ANTHROPIC_LOG || '/dev/null', 'utf8')
      check(!process.env.MOCK_ANTHROPIC_LOG || log.includes('Preiei o conversa'), 'handoff sends the previous conversation to the other engine')
      check(hItems.some((i) => i.kind === 'assistant'), 'the other engine answers after the handoff')
    }
  }

  console.log(failures ? `\n${failures} FAILED` : '\nALL PASSED')
  await jolty.shutdown()
  app.exit(failures ? 1 : 0)
})
