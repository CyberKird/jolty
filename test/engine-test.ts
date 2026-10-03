// End-to-end check of both engines through Jolty's main-process API, against mock model servers.
// Run with: npm run test:engines   (needs the mocks from test/README.md running)
import { app } from 'electron'
import fs from 'fs'
import http from 'http'
import os from 'os'
import path from 'path'
import type { ChatEvent, ChatItem, Profile } from '../src/shared/types'
import { endpointCost, fetchBalance, hasBalance } from '../src/main/balance'
import { browserServer, pageHost } from '../src/main/browser'
import { endpointEfforts } from '../src/main/engines/thinking'
import { noThinkingUrl } from '../src/main/thinking-proxy'
import { assess, delegatePick, recommend } from '../src/shared/complexity'
import { modelScore } from '../src/shared/scores'
import { secretHint } from '../src/shared/secrets'
import { TaskBoard } from '../src/main/engines/tasks'
import { syncSettings } from '../src/main/runtime'
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

  // ---------------- provider balance and real cost (fetch mocked, no real keys) ----------------
  {
    const ep = (baseUrl: string, extra = {}) => ({ id: 'x', name: 'x', engine: 'claude' as const, auth: 'endpoint' as const, isDefaultDir: true, baseUrl, color: '', ...extra })
    const real = globalThis.fetch
    const seen: string[] = []
    const reply = (body: unknown) => async (url: string | URL | Request, init?: RequestInit) => {
      seen.push(`${url} ${(init?.headers as Record<string, string>)?.Authorization}`)
      return new Response(JSON.stringify(body), { status: 200 })
    }
    globalThis.fetch = reply({ is_available: true, balance_infos: [{ currency: 'CNY', total_balance: '30.00' }, { currency: 'USD', total_balance: '4.20' }] }) as typeof fetch
    const ds = await fetchBalance(ep('https://api.deepseek.com/anthropic'), 'sk-ds')
    check(ds?.amount === 4.2 && ds.currency === 'USD' && seen[0] === 'https://api.deepseek.com/user/balance Bearer sk-ds', 'DeepSeek balance read from its official endpoint (USD preferred)')
    globalThis.fetch = reply({ code: 0, data: { available_balance: 12.5, voucher_balance: 0, cash_balance: 12.5 }, status: true }) as typeof fetch
    const kimi = await fetchBalance(ep('https://api.moonshot.cn/anthropic'), 'sk-k')
    check(kimi?.amount === 12.5 && kimi.currency === 'CNY' && seen[1].startsWith('https://api.moonshot.cn/v1/users/me/balance'), 'Kimi balance from the same host, CNY on .cn')
    globalThis.fetch = reply({ data: { limit_remaining: null, usage: 3 } }) as typeof fetch
    const or = await fetchBalance(ep('https://openrouter.ai/api'), 'sk-or')
    check(or?.amount === undefined && Boolean(or?.note), 'OpenRouter key without a limit says so instead of inventing a balance')
    check(!hasBalance(ep('http://api.deepseek.com/anthropic')) && !hasBalance(ep('https://evil.example/api.deepseek.com')), 'no balance call for plain http or look-alike hosts')
    let mimoUrl = ''
    let mimoCookie = ''
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      mimoUrl = String(url)
      mimoCookie = (init?.headers as Record<string, string>)?.Cookie ?? ''
      return new Response(JSON.stringify({ code: 0, data: { balance: '8.50', currency: 'CNY', cashBalance: '5', giftBalance: '3.50' } }), { status: 200 })
    }) as typeof fetch
    const mimo = await fetchBalance(ep('https://api.xiaomimimo.com/anthropic'), undefined, 'api-platform_serviceToken=x; userId=y')
    check(mimo?.amount === 8.5 && mimo.currency === 'CNY' && mimoUrl === 'https://platform.xiaomimimo.com/api/v1/balance' && mimoCookie === 'api-platform_serviceToken=x; userId=y', 'MiMo balance from the console with the cookie, not the API key')
    check((await fetchBalance(ep('https://api.xiaomimimo.com/anthropic'), undefined, undefined)) === undefined, 'MiMo without a cookie does not call or invent a balance')
    globalThis.fetch = real
    const u = { profileId: 'x', engine: 'claude' as const, model: 'm', inputTokens: 1e6, outputTokens: 5e5, cacheReadTokens: 2e6, cacheWriteTokens: 0, ts: 0 }
    check(endpointCost(u, ep('https://api.deepseek.com/anthropic', { price: { input: 0.3, output: 1.2, cacheRead: 0.03 } })) === 0.3 + 0.6 + 0.06, 'real cost from the provider prices')
    check(endpointCost(u, ep('https://api.deepseek.com/anthropic')) === undefined && endpointCost(u, ep('http://127.0.0.1:11434', { local: true })) === 0, 'no price = no invented cost; local models cost nothing')
  }

  // ---------------- second Claude account: plugins, marketplaces and hooks follow the main account ----------------
  {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'jolty-settings-'))
    const mainFile = path.join(d, 'main.json')
    const own = path.join(d, 'own.json')
    fs.writeFileSync(mainFile, JSON.stringify({ enabledPlugins: { 'a@m': true, 'b@m': true }, hooks: { Stop: [{ hooks: [] }] }, env: { ANTHROPIC_BASE_URL: 'x' } }))
    fs.writeFileSync(own, JSON.stringify({ enabledPlugins: { 'a@m': false, 'mine@m': true }, model: 'opus' }))
    syncSettings(mainFile, own)
    const r = JSON.parse(fs.readFileSync(own, 'utf8'))
    check(r.enabledPlugins['a@m'] === true && r.enabledPlugins['b@m'] === true && r.enabledPlugins['mine@m'] === true && Boolean(r.hooks?.Stop), 'settings sync: main plugins and hooks arrive, profile-only plugins stay')
    check(r.model === 'opus' && !r.env, 'settings sync: the profile keeps its own settings, env (endpoints, keys) is never copied')
    fs.writeFileSync(own, '{broken')
    check(!syncSettings(mainFile, own) && fs.readFileSync(own, 'utf8') === '{broken', 'settings sync: an unreadable profile file is left alone')
  }

  // ---------------- task list: TaskCreate / TaskUpdate / TaskList and the older TodoWrite ----------------
  {
    const b = new TaskBoard()
    b.created({ subject: 'Citesc proiectul', activeForm: 'Citesc proiectul' }, { task: { id: '1', subject: 'Citesc proiectul' } }, '')
    b.created({ subject: 'Scriu testele', activeForm: 'Scriu testele acum' }, undefined, 'Task #2 created successfully: Scriu testele')
    b.created({ subject: 'Build' }, { task: { id: '3', subject: 'Build' } }, '')
    b.updated({ taskId: '1', status: 'completed' })
    b.updated({ taskId: '2', status: 'in_progress' })
    b.updated({ taskId: '3', status: 'deleted' })
    const st = b.steps()
    check(st.length === 2 && st[0].status === 'done' && st[1].status === 'active' && st[1].text === 'Scriu testele acum', 'tasks: created by id (structured or from the text), updated, deleted')
    b.listed({ tasks: [{ id: '2', subject: 'Scriu testele', status: 'completed', blockedBy: [] }] })
    check(b.steps().length === 1 && b.steps()[0].status === 'done', 'tasks: TaskList result replaces the list')
    b.todos([{ content: 'A', activeForm: 'Fac A', status: 'in_progress' }, { content: 'B', status: 'pending' }])
    check(b.steps()[0].text === 'Fac A' && b.steps()[1].status === 'pending', 'tasks: TodoWrite from older Claude Code still works')
  }

  // ---------------- model recommendation: quiet when the pick fits, across accounts ----------------
  {
    const E = ['low', 'medium', 'high', 'xhigh', 'max']
    const prof = (id: string, engine: 'claude' | 'codex', auth: 'subscription' | 'endpoint') => ({ id, name: id, engine, auth, isDefaultDir: true, color: '' })
    const claude = {
      profile: prof('claude', 'claude', 'subscription'),
      models: [
        { id: 'default', label: 'Default (recommended)', description: 'Opus 5.5 · Best for everyday, complex tasks', isDefault: true, efforts: E },
        { id: 'fable', label: 'Fable', description: 'Fable 5.1 · Most capable for your hardest tasks · $10/$50 per Mtok', efforts: E },
        { id: 'opus', label: 'Opus', description: 'Opus 5.5 · Best for everyday, complex tasks', efforts: E },
        { id: 'sonnet', label: 'Sonnet', description: 'Sonnet 5 · Efficient for routine tasks', efforts: E },
        { id: 'haiku', label: 'Haiku', description: 'Haiku 4.5 · Fastest for quick answers', efforts: [] }
      ]
    }
    const codex = {
      profile: prof('codex', 'codex', 'subscription'),
      models: [
        { id: 'gpt-6-astra', label: 'GPT-6-Astra', description: 'Frontier intelligence for the most demanding work.', isDefault: true, efforts: E },
        { id: 'gpt-6-sol', label: 'GPT-6-Sol', description: 'Workhorse model for coding and everyday work.', efforts: E }
      ]
    }
    const ds = { profile: prof('ds', 'claude', 'endpoint'), models: [{ id: 'deepseek-chat', label: 'deepseek-chat', isDefault: true }] }
    const groups = [claude, codex, ds]
    const hard = assess('Refactorizează tot proiectul să folosească TypeScript, optimizează netcode-ul pentru multiplayer și adaugă teste complete')!
    const small = assess('redenumește variabila x în playerSpeed')!
    check(hard.level === 4 && small.level === 1, `assessment levels (hard ${hard.level}, small ${small.level})`)
    const r1 = recommend(hard, groups, { profileId: 'ds' }, {})
    check(r1.kind === 'weak' && r1.target?.profileId === 'claude' && r1.target.model.id === 'opus' && r1.target.effort === 'xhigh', `hard task on DeepSeek -> Opus xhigh on the Claude plan (${r1.target?.profileId}/${r1.target?.model.id}/${r1.target?.effort})`)
    check(recommend(hard, groups, { profileId: 'claude', modelId: 'opus' }, {}).kind === 'none', 'Opus on auto effort for a hard task: silent')
    const full = { claude: { profileId: 'claude', windows: [{ label: '7 zile', usedPercent: 97 }], updatedAt: 0 } }
    const r3 = recommend(hard, groups, { profileId: 'claude', modelId: 'opus' }, full)
    check(r3.target?.profileId === 'codex' && r3.target.model.id === 'gpt-6-astra', `Claude at 97% -> the top Codex model instead (${r3.kind} ${r3.target?.model.id})`)
    const r4 = recommend(small, groups, { profileId: 'claude', modelId: 'opus' }, {})
    check(r4.kind === 'overkill' && r4.target?.model.id === 'haiku' && r4.target.profileId === 'claude', 'a rename on Opus: quiet hint to Haiku on the same account')
    check(recommend(small, groups, { profileId: 'claude', modelId: 'sonnet' }, {}).kind === 'none', 'a rename on Sonnet: silent')
    const r6 = recommend(hard, groups, { profileId: 'claude', modelId: 'opus', effort: 'low' }, {})
    check(r6.kind === 'weak' && r6.target?.model.id === 'opus' && r6.target.effort === 'xhigh', 'Opus on low for a hard task -> raise the effort, same model')
    const r7 = recommend(hard, [ds, { ...claude, error: 'not logged in' }], { profileId: 'ds' }, {})
    check(r7.kind === 'weak' && !r7.target, 'no connected model is strong enough: says so, suggests nothing it cannot run')

    // ---------------- auto-delegation of mechanical work to a cheap model ----------------
    const cheap: Profile = { ...prof('ds', 'claude', 'endpoint'), hasSecret: true }
    const sub = prof('claude', 'claude', 'subscription') as Profile
    const local: Profile = { id: 'ollama', name: 'ollama', engine: 'claude', auth: 'endpoint', isDefaultDir: true, color: '', local: true }
    const list = [sub, cheap]
    const mechanical = 'Refactorizează tot serviciul de facturare ca să folosească tipuri TypeScript peste tot și scrie teste pentru fiecare rută în parte acum'
    check(delegatePick(mechanical, list, 'claude')?.id === 'ds', 'a long mechanical task on a subscription goes to the cheap endpoint')
    check(delegatePick(mechanical, list, 'ds') === undefined, 'already on the cheap endpoint: no hop')
    check(delegatePick('refactorizează', list, 'claude') === undefined, 'below the size floor: stays where it is')
    check(delegatePick('scrie teste pentru modulul de plată folosind cheia sk-abc123 și token-ul de auth pentru toate mediile', list, 'claude') === undefined, 'looks like it holds a secret: never routed to a third-party endpoint')
    check(delegatePick('explică-mi de ce interfața se mișcă greu când derulez lista lungă de sesiuni din bara laterală', list, 'claude') === undefined, 'no mechanical verb: no delegation')
    check(delegatePick(mechanical, [sub, local], 'claude')?.id === 'ollama', 'falls back to a local model when no endpoint key is set')

    const opus = modelScore(sub, { id: 'opus', label: 'Opus 5.5' })
    check(opus?.iq === 54 && opus.speed === 'mediu', 'Opus 5.5 scores 54 and is medium speed')
    check(modelScore(sub, { id: 'sonnet', label: 'Sonnet 5.5' })?.speed === 'rapid', 'Sonnet 5.5 is fast')
    check(modelScore(sub, { id: 'gpt-6.1-sol', label: 'GPT-6.1-Sol' })?.iq === 50, 'GPT-6.1 Sol is not mistaken for GPT-6 Sol')
    check(modelScore(sub, { id: 'xiaomi:mimo-v2.5-tts', label: 'mimo-v2.5-tts' }) === undefined, 'a speech model gets no intelligence score')
    check(secretHint('foloseste cheia sk-ant-api03-abcdefghijklmnop1234 pentru test') === 'o cheie API', 'secret hint: an API key is noticed')
    check(secretHint('password: hunter2x') === 'o parolă', 'secret hint: a password is noticed')
    check(secretHint('scrie teste pentru modulul de plată și refactorizează serviciul') === undefined, 'secret hint: ordinary text is left alone')
    const gemma = modelScore(local, { id: 'gemma4-jolty', label: 'gemma4-jolty' })
    check(gemma?.iq === 15 && gemma.speed === undefined, 'a local model has a score but no speed (that is the PC)')
  }

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
    // undo from a message: the file the model wrote goes away; the context indicator gets numbers
    {
      const proj2 = fs.mkdtempSync(path.join(os.tmpdir(), 'jolty-rewind-'))
      const rw = jolty.createProfile({ name: 'Rewind (mock)', engine: 'claude', auth: 'endpoint', baseUrl: url, models: ['mock-model'], secret: 'sk-mock' })
      fs.writeFileSync(path.join(proj2, 'live_demo.txt'), 'original\n')
      const r = await jolty.startSession({ profileId: rw.id, cwd: proj2, permissionMode: 'full' })
      await jolty.sendMessage(r.id, `Scrie fisierul RUN_WRITE WRITE_TO=${path.join(proj2, 'live_demo.txt')}`)
      await waitFor(() => idleCount(r.id) >= 1, 120000, 'rewind write turn')
      const file = path.join(proj2, 'live_demo.txt')
      check(fs.readFileSync(file, 'utf8').includes('jolty live code'), 'rewind: the model overwrote the file')
      check(events.some((e) => e.type === 'context' && e.sessionId === r.id && e.used > 0), 'context indicator: used tokens reported after the turn')
      const userItem = jolty.history(r.id).find((i) => i.kind === 'user')!
      const dry = await jolty.rewind(r.id, userItem.id, true).catch((e: Error) => ({ error: e.message, files: [] as string[] }))
      check(dry.files.length === 1 && fs.readFileSync(file, 'utf8').includes('jolty live code'), 'rewind preview: finds the file and changes nothing')
      const res = await jolty.rewind(r.id, userItem.id).catch((e: Error) => ({ error: e.message, files: [] as string[] }))
      console.log(`   rewind: ${JSON.stringify(res)} -> ${JSON.stringify(fs.readFileSync(file, 'utf8').slice(0, 30))}`)
      check(fs.readFileSync(file, 'utf8') === 'original\n' && res.files.length === 1, 'rewind: the file is back to its content before that message')
    }
    // the safety nets: with every question off a few commands never run; secret files still ask in the modes that are otherwise free
    {
      const proj3 = fs.mkdtempSync(path.join(os.tmpdir(), 'jolty-net-'))
      const net = jolty.createProfile({ name: 'Net (mock)', engine: 'claude', auth: 'endpoint', baseUrl: url, models: ['mock-model'], secret: 'sk-mock' })
      const asked = (id: string): number => events.filter((e) => e.type === 'permission' && e.sessionId === id).length
      const free = await jolty.startSession({ profileId: net.id, cwd: proj3, permissionMode: 'full' })
      await jolty.sendMessage(free.id, 'RUN_TOOL BASH_CMD=reg delete HKCU\Software\JoltyNeverRun /f')
      await waitFor(() => idleCount(free.id) >= 1, 120000, 'never-run turn')
      const blocked = jolty.history(free.id).find((i) => i.kind === 'tool') as Extract<ChatItem, { kind: 'tool' }> | undefined
      show(jolty.history(free.id))
      check(blocked?.status === 'error' && /Permission to use Bash/i.test(blocked.output || ''), 'full mode: reg delete is refused by the never-run list')
      const edits = await jolty.startSession({ profileId: net.id, cwd: proj3, permissionMode: 'autoEdit' })
      await jolty.sendMessage(edits.id, `RUN_WRITE WRITE_TO=${path.join(proj3, 'notes.txt')}`)
      await waitFor(() => idleCount(edits.id) >= 1, 120000, 'plain write turn')
      check(asked(edits.id) === 0, 'accept-edits mode: a normal file is written without asking')
      await jolty.sendMessage(edits.id, `Din nou RUN_WRITE WRITE_TO=${path.join(proj3, '.env')}`)
      await waitFor(() => idleCount(edits.id) >= 2, 120000, 'secret write turn')
      check(asked(edits.id) === 1, 'accept-edits mode: a .env file still asks first')
    }
    check(pageHost('### Page\n- Page URL: https://Shop.Example.com:8443/cart?x=1') === 'shop.example.com', 'browser: the site comes from the tool result')
    check(pageHost('- Page URL: chrome-extension://abc/connect.html') === undefined, 'browser: non-web pages are never a trusted site')
    // the three ways to connect: the extension opens a tab (default), the user picks one, or a separate Jolty window runs with no extension at all
    check(browserServer().args.includes('--extension'), 'browser: the extension is used by default')
    store.saveSettings({ browserMode: 'own' })
    check(!browserServer().args.includes('--extension'), 'browser: the separate Jolty window needs no extension')
    store.saveSettings({ browserMode: 'pick' })
    check(browserServer().args.includes('--extension') && !browserServer().env.PLAYWRIGHT_MCP_EXTENSION_TOKEN, 'browser: picking a tab by hand sends no saved token')
    store.saveSettings({ browserMode: undefined })
    // thinking level on an endpoint: what the picker offers is what the provider documents, and it reaches the request
    check(endpointEfforts({ baseUrl: 'https://api.deepseek.com/anthropic' } as Profile).efforts?.join() === 'off,low,high,max', 'thinking: DeepSeek offers off, low, high, max')
    check(endpointEfforts({ baseUrl: 'https://api.xiaomimimo.com/anthropic' } as Profile).efforts?.join() === 'off,on', 'thinking: MiMo offers on/off only')
    check(!endpointEfforts({ baseUrl: 'https://example.org/anthropic' } as Profile).efforts, 'thinking: an unknown provider gets no control')
    {
      // the relay: thinking disabled, output_config gone, the key and the path pass through
      const seen: { url?: string; auth?: string; body?: Record<string, unknown> } = {}
      const up = http.createServer((rq, rs) => {
        const parts: Buffer[] = []
        rq.on('data', (c: Buffer) => parts.push(c))
        rq.on('end', () => {
          seen.url = rq.url
          seen.auth = String(rq.headers.authorization || '')
          seen.body = JSON.parse(Buffer.concat(parts).toString() || '{}')
          rs.writeHead(200, { 'content-type': 'application/json' })
          rs.end('{"ok":true}')
        })
      })
      await new Promise<void>((r) => up.listen(0, '127.0.0.1', () => r()))
      const relay = await noThinkingUrl(`http://127.0.0.1:${(up.address() as { port: number }).port}/anthropic`)
      const resp = await fetch(`${relay}/v1/messages`, { method: 'POST', headers: { authorization: 'Bearer k', 'content-type': 'application/json' }, body: JSON.stringify({ model: 'm', thinking: { type: 'adaptive' }, output_config: { effort: 'medium' } }) })
      check((await resp.text()) === '{"ok":true}' && seen.url === '/anthropic/v1/messages' && seen.auth === 'Bearer k', 'relay: path under the provider URL, key and response pass through')
      check((seen.body?.thinking as { type?: string })?.type === 'disabled' && seen.body?.output_config === undefined, 'relay: thinking disabled and output_config dropped')
      up.close()
    }
    if (process.env.MOCK_ANTHROPIC_LOG) {
      const th = jolty.createProfile({ name: 'Thinking (mock)', engine: 'claude', auth: 'endpoint', baseUrl: url, models: ['mock-model'], secret: 'sk-mock' })
      const asked = async (effort: string): Promise<{ thinking?: { type?: string }; output_config?: { effort?: string } }> => {
        const t = await jolty.startSession({ profileId: th.id, cwd: project, permissionMode: 'ask', model: 'mock-model', effort })
        const before = idleCount(t.id)
        await jolty.sendMessage(t.id, `Salut ${effort}`)
        await waitFor(() => idleCount(t.id) > before, 120000, `thinking turn ${effort}`)
        return fs.readFileSync(process.env.MOCK_ANTHROPIC_LOG!, 'utf8').trim().split('\n').map((l) => JSON.parse(l)).filter((r) => r.path.endsWith('/messages') && r.stream).pop()
      }
      check((await asked('off')).thinking?.type === 'disabled', 'thinking: off reaches the endpoint as thinking disabled')
      const max = await asked('max')
      console.log(`   thinking max -> ${JSON.stringify({ thinking: max.thinking, output_config: max.output_config })}`)
      check(max.output_config?.effort === 'max', 'thinking: max reaches the endpoint as output_config.effort')
    }
    // Jolty in the browser: Playwright MCP reaches the model with the safety rule, the unsafe tool does not
    if (process.env.MOCK_ANTHROPIC_LOG) {
      const web = jolty.createProfile({ name: 'Browser (mock)', engine: 'claude', auth: 'endpoint', baseUrl: url, models: ['mock-model'], secret: 'sk-mock' })
      const b = await jolty.startSession({ profileId: web.id, cwd: project, permissionMode: 'ask', browser: true })
      await jolty.sendMessage(b.id, 'Salut din browser')
      await waitFor(() => idleCount(b.id) >= 1, 120000, 'browser turn')
      const req = fs.readFileSync(process.env.MOCK_ANTHROPIC_LOG, 'utf8').trim().split('\n').map((l) => JSON.parse(l)).filter((r) => r.path.endsWith('/messages')).pop()
      check(req?.browser_tools === true, 'browser session: the Playwright tools reach the model')
      check(req?.unsafe_tool === false, 'browser session: browser_run_code_unsafe is blocked')
      check(req?.browser_rule === true, 'browser session: page content is data, ask before acting')
    }
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
    check(log.some((r) => r.model === 'mock-blind' && r.n_tools > 0 && r.dash_rule), 'claude conversations carry the no-dash writing rule')
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
    {
      // Jolty in the browser on Codex: the thread starts with the Playwright MCP server and it comes up
      const b = await jolty.startSession({ profileId: p.id, cwd: project, permissionMode: 'ask', model: 'mock-model', browser: true })
      await jolty.sendMessage(b.id, 'Salut din browser')
      await waitFor(() => idleCount(b.id) >= 1, 120000, 'codex browser turn')
      check(jolty.history(b.id).some((i) => i.kind === 'assistant'), 'codex answers with the browser server attached')
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const rpc = await (jolty.codex as any).server(jolty.profile(p.id)).get()
      const meta = jolty.sessions().find((x) => x.id === b.id)!
      const st = await rpc.request('mcpServerStatus/list', { threadId: meta.engineSessionId, detail: 'toolsAndAuthOnly' }).catch((e: Error) => ({ error: e.message }))
      const mine = (st?.data || []).find((x: { name: string }) => x.name === 'jolty-browser')
      const tools = Object.keys(mine?.tools || {})
      console.log(`   codex jolty-browser: ${tools.length} tools${st?.error ? ` (${st.error})` : ''}`)
      check(tools.includes('browser_navigate') && !tools.includes('browser_run_code_unsafe'), 'codex sees the browser tools, without the unsafe one')
    }
    {
      // project mode: no questions, inside the project folder (workspace-write sandbox, approval never).
      // The mock home has no Windows sandbox set up, so only the absence of questions is checked here.
      const q = await jolty.startSession({ profileId: p.id, cwd: project, permissionMode: 'project', model: 'mock-model' })
      await jolty.sendMessage(q.id, 'Salut Codex RUN_TOOL')
      await waitFor(() => idleCount(q.id) >= 1, 120000, 'codex project-mode turn')
      check(!events.some((e) => e.type === 'permission' && e.sessionId === q.id), 'codex project mode: no approval is asked')
    }
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
    if (process.env.MOCK_RESPONSES_LOG) {
      const rlog = fs.readFileSync(process.env.MOCK_RESPONSES_LOG, 'utf8').trim().split('\n').map((l) => JSON.parse(l))
      check(rlog.some((r) => r.dash_rule), 'codex conversations carry the no-dash writing rule')
    }

    // handoff Codex -> Claude
    if (process.env.TEST_CLAUDE !== '0') {
      const claudeProfile = jolty.profiles().find((x) => x.name === 'Mock Anthropic')!
      const h = await jolty.handoff(s.id, claudeProfile.id)
      await waitFor(() => idleCount(h.id) >= 1, 120000, 'handoff turn')
      const hItems = jolty.history(h.id)
      check(hItems.some((i) => i.kind === 'user' && i.text.includes('Preia conversația')), 'handoff shows a short message to the user')
      const log = fs.readFileSync(process.env.MOCK_ANTHROPIC_LOG || '/dev/null', 'utf8')
      check(!process.env.MOCK_ANTHROPIC_LOG || log.includes('"handoff": true'), 'handoff sends the previous conversation to the other engine')
      check(hItems.some((i) => i.kind === 'assistant'), 'the other engine answers after the handoff')
    }
  }

  console.log(failures ? `\n${failures} FAILED` : '\nALL PASSED')
  await jolty.shutdown()
  app.exit(failures ? 1 : 0)
})
