// Gemini through the user's own signed-in gemini.google.com, driven in the Jolty browser: the subscription (Google AI
// Pro and the like) is used as it is, with no API key and no Gemini CLI. A chat here is a chat there: the page does the
// thinking, Jolty types, reads the answer as it grows and shows it like any other model. It has no tools of its own and
// no files of the project; when the chat has the browser or the PC switched on, it asks for those tools in plain text
// and Jolty runs them (gemini-tools.ts), so it can act like the other models.
import { randomUUID } from 'crypto'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { tr } from '@shared/i18n'
import type { AccountStatus, Attachment, ChatItem, ExternalSession, ModelOption, PermissionDecision, PermissionMode, Profile, RateLimitSnapshot, SessionMeta } from '@shared/types'
import type { EngineDriver, EngineHost, EngineSession } from './types'
import { claudeToolTitle, truncate } from './format'
import { callTool, imageFiles, listTools, MAX_STEPS, resultMessage, splitReply, toolsPrompt, type ToolCall, type ToolDefLite, type ToolOutcome, type ToolSet } from './gemini-tools'
import { ACCOUNT_SCRIPT, ATTACHED_SCRIPT, CLOSE_MENU_SCRIPT, MENU_SCRIPT, PAGE_LIB, SEND_SCRIPT, STOP_SCRIPT, UPLOAD_SCRIPT, pickScript, typeScript } from './gemini-page'

export const GEMINI_URL = 'https://gemini.google.com/app'
export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** The page as the session needs it: run a script in it, hand it files, close it. Tests bring their own. */
export interface GeminiPage {
  eval<T = unknown>(script: string): Promise<T>
  upload(trigger: string, files: string[]): Promise<void>
  dispose(): Promise<void>
}

/** The tool groups a chat can switch on (the browser, the PC) and the few things the loop needs from the app around it. */
export interface GeminiTools {
  /** the groups this chat has switched on */
  sets(meta: SessionMeta): ToolSet[]
  /** "site" asks once per site before acting on a page, "free" never asks */
  siteTrust(): string
  /** a new message of the user: groups that keep a budget per chat start it over */
  newTurn?(sid: string): void
  /** Stop: what is under way ends at once */
  interrupt?(sid: string): void
  /** tools in a row before the loop stops (tests lower it) */
  maxSteps?: number
}

export interface Catalog {
  at: number
  models: ModelOption[]
}

export interface GeminiBrowser {
  open(key: string, url: string): Promise<GeminiPage>
  /** whether the browser is connected right now; listing models never starts the browser by itself */
  connected(): boolean
  /** the last model list, kept between runs so the picker does not open a Gemini tab every time */
  catalog?: { read(): Catalog | undefined; write(c: Catalog): void }
}

interface PageState {
  responses: number
  busy: boolean
  stop: boolean
  markdown: string
  composer: boolean
  url: string
}

interface MenuRead {
  ok: boolean
  models?: { id: string; title: string; note: string; locked: boolean; selected?: boolean }[]
  levels?: { title: string; note: string; selected?: boolean }[]
  current?: string
}

/** Thinking levels have no ids of their own on the page, so they get the names the pickers already know, by position. */
export function effortIds(count: number): string[] {
  if (count < 2) return []
  if (count === 2) return ['low', 'high']
  if (count === 3) return ['low', 'medium', 'high']
  return ['minimal', 'low', 'medium', 'high', 'xhigh'].slice(-count)
}

/** The model menu as the picker's list: locked rows (upsells for a plan the user does not have) are left out. */
export function parseMenu(menu: MenuRead): ModelOption[] {
  if (!menu.ok) return []
  const efforts = effortIds(menu.levels?.length ?? 0)
  const models = (menu.models ?? []).filter((m) => !m.locked && m.title)
  const current = Math.max(0, models.findIndex((m) => m.selected))
  const level = menu.levels?.findIndex((l) => l.selected) ?? -1
  return models.map((m, i): ModelOption => ({
    id: m.title, label: m.title, description: m.note || undefined, isDefault: i === current, vision: true,
    ...(efforts.length ? { efforts, defaultEffort: efforts[level >= 0 ? level : Math.floor((efforts.length - 1) / 2)] } : {})
  }))
}

/** Gemini does not report tokens: about four characters make one, enough for the usage page to move. */
const roughTokens = (s: string): number => Math.ceil(s.length / 4)

const EXT: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif', 'application/pdf': 'pdf' }

/** Attachments as files on disk (the page takes files, not bytes), in a folder of their own. */
function writeFiles(items: Attachment[]): { dir: string; files: string[] } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jolty-gemini-'))
  try {
    const files = items.map((a, i) => {
      const ext = path.extname(a.name || '') || (EXT[a.mime] ? '.' + EXT[a.mime] : '')
      const file = path.join(dir, `file-${i + 1}${ext}`)
      if (a.data) fs.writeFileSync(file, Buffer.from(a.data, 'base64'))
      else if (a.path) fs.copyFileSync(a.path, file)
      else throw new Error('attachment without data')
      return file
    })
    return { dir, files }
  } catch (e) {
    fs.rmSync(dir, { recursive: true, force: true })
    throw e
  }
}

const LOGIN_MESSAGE = (): string => tr("Nu ești conectat la Google în browserul Jolty. Deschide gemini.google.com acolo, conectează-te cu abonamentul tău și încearcă din nou.")

export class GeminiWebSession implements EngineSession {
  private key: string
  private page?: GeminiPage
  private opening?: Promise<GeminiPage>
  private busy = false
  private cancelled = false
  private closed = false
  /** the model and level the page is on, so a message only touches the menu when the chat's choice changed */
  private applied: { model?: string; effort?: string } = {}
  /** tool groups the model has been told about, so the instructions go once */
  private announced = new Set<string>()
  private defs = new Map<string, ToolDefLite[]>()
  /** the site the browser tools are on now, and the ones the user said yes to for this chat */
  private site?: string
  private trusted = new Set<string>()
  private pending = new Map<string, { resolve: (d: PermissionDecision) => void; site?: string }>()

  constructor(readonly meta: SessionMeta, private profile: Profile, private host: EngineHost, private browser: GeminiBrowser, private tools?: GeminiTools) {
    this.key = `gemini-web-${meta.id}`
  }

  private async tab(): Promise<GeminiPage> {
    if (this.closed) throw new Error(tr("Conversația Gemini este închisă."))
    if (this.page) return this.page
    this.opening ??= this.browser.open(this.key, this.meta.engineSessionId || GEMINI_URL).then(async (page) => {
      this.page = page
      this.applied = {}
      return page
    }).finally(() => {
      this.opening = undefined
    })
    return this.opening
  }

  /** The page is ready when the message box is there; a sign-in page instead means the login is gone. */
  private async ready(page: GeminiPage): Promise<void> {
    await page.eval(PAGE_LIB)
    for (let i = 0; i < 50; i++) {
      const a = await page.eval<{ composer: boolean; signIn: boolean }>(ACCOUNT_SCRIPT)
      if (a.composer) return
      if (a.signIn && i > 4) break
      await sleep(200)
    }
    throw new Error(LOGIN_MESSAGE())
  }

  /** Model and thinking level of the chat, put on the page before the message. */
  private async choose(page: GeminiPage): Promise<void> {
    const { model, effort } = this.meta
    if (!model && !effort) return
    if (model === this.applied.model && effort === this.applied.effort) return
    const menu = await page.eval<MenuRead>(MENU_SCRIPT)
    if (menu.ok) {
      if (model && model !== this.applied.model) {
        const row = menu.models?.find((m) => m.title === model && !m.locked)
        if (row) {
          await page.eval(pickScript('model', row.id))
          // choosing a model closes the menu: opening it again shows the levels of the new model
          await sleep(400)
          if (effort) await page.eval(MENU_SCRIPT)
        }
      }
      if (effort && effort !== this.applied.effort) {
        const again = await page.eval<MenuRead>(MENU_SCRIPT)
        const index = effortIds(again.levels?.length ?? 0).indexOf(effort)
        if (index >= 0) await page.eval(pickScript('level', index))
      }
    }
    await page.eval(CLOSE_MENU_SCRIPT)
    this.applied = { model, effort }
  }

  private async attach(page: GeminiPage, items: Attachment[]): Promise<() => void> {
    const { dir, files } = writeFiles(items)
    try {
      await page.upload(UPLOAD_SCRIPT, files)
      // sending before the page has read the files would send the message without them
      for (let i = 0; i < 1200; i++) {
        const a = await page.eval<{ count: number; loading: number }>(ATTACHED_SCRIPT)
        if (a.count >= items.length && a.loading === 0) break
        await sleep(250)
      }
    } catch (e) {
      fs.rmSync(dir, { recursive: true, force: true })
      throw new Error(tr("Nu am putut atașa fișierele în Gemini: {why}", { why: e instanceof Error ? e.message : String(e) }))
    }
    return () => fs.rmSync(dir, { recursive: true, force: true })
  }

  /** The tool groups switched on for this chat, with the tools each one offers. */
  private async activeSets(): Promise<{ set: ToolSet; defs: ToolDefLite[] }[]> {
    const out: { set: ToolSet; defs: ToolDefLite[] }[] = []
    for (const set of this.tools?.sets(this.meta) ?? []) {
      let defs = this.defs.get(set.server)
      if (!defs) {
        defs = (await listTools(set, this.meta.id)).filter((d) => set.expose(d.name))
        if (defs.length) this.defs.set(set.server, defs)
      }
      if (defs.length) out.push({ set, defs })
    }
    return out
  }

  async send(text: string, images: Attachment[] = []): Promise<void> {
    for (let i = 0; this.cancelled && this.busy && i < 80; i++) await sleep(100)
    if (this.busy) throw new Error(tr("Gemini lucrează deja în această conversație."))
    this.busy = true
    this.cancelled = false
    this.host.emit({ type: 'status', sessionId: this.meta.id, status: 'running' })
    try {
      const page = await this.tab()
      await this.ready(page)
      await this.choose(page)
      this.tools?.newTurn?.(this.meta.id)
      const sets = await this.activeSets()
      const owner = (name: string): ToolSet | undefined => sets.find(({ set, defs }) => set.expose(name) && defs.some((d) => d.name === name))?.set
      const fresh = sets.filter(({ set }) => !this.announced.has(set.server))
      let message = fresh.length ? `${toolsPrompt(fresh)}\n\n${text}` : text
      for (const { set } of fresh) this.announced.add(set.server)
      let files = images
      let said = ''
      for (let step = 0; ; step++) {
        const raw = await this.exchange(page, message, files, sets.length ? owner : undefined)
        said += raw
        if (this.cancelled) return
        const call = sets.length ? splitReply(raw, (n) => Boolean(owner(n))).call : undefined
        if (!call) break
        if (step >= (this.tools?.maxSteps ?? MAX_STEPS)) {
          this.host.emit({ type: 'item', sessionId: this.meta.id, item: { kind: 'notice', id: randomUUID(), level: 'warn', text: tr("Gemini a folosit {n} unelte la rând. M-am oprit; scrie «continuă» dacă vrei să meargă mai departe.", { n: this.tools?.maxSteps ?? MAX_STEPS }) } })
          break
        }
        const outcome = await this.runTool(owner(call.tool)!, call)
        if (this.cancelled) return
        message = resultMessage(call.tool, outcome)
        files = imageFiles(outcome.images, 'tool')
      }
      this.host.recordUsage({
        profileId: this.profile.id, engine: 'gemini', model: this.meta.model || 'Gemini',
        inputTokens: roughTokens(text), outputTokens: roughTokens(said), cacheReadTokens: 0, cacheWriteTokens: 0, ts: Date.now()
      })
      this.host.emit({ type: 'status', sessionId: this.meta.id, status: 'idle' })
    } catch (err) {
      if (this.cancelled) return
      const error = err instanceof Error ? err.message : String(err)
      if (!this.closed) this.host.emit({ type: 'status', sessionId: this.meta.id, status: 'error', error })
      throw err
    } finally {
      this.busy = false
      if (this.cancelled && !this.closed) this.host.emit({ type: 'status', sessionId: this.meta.id, status: 'idle' })
    }
  }

  /** One message to the page and the answer to it (the raw markdown, tool block included). */
  private async exchange(page: GeminiPage, text: string, files: Attachment[], owner?: (name: string) => ToolSet | undefined): Promise<string> {
    let cleanup: (() => void) | undefined
    try {
      if (files.length) cleanup = await this.attach(page, files)
      const before = (await page.eval<PageState>('window.__joltyGemini.state()')).responses
      const typed = await page.eval<{ ok: boolean; why?: string }>(typeScript(text))
      if (!typed.ok) throw new Error(typed.why || 'no message box')
      let sent = false
      for (let i = 0; i < 60 && !sent; i++) {
        await sleep(i ? 150 : 300)
        sent = (await page.eval<{ ok: boolean }>(SEND_SCRIPT)).ok
      }
      if (!sent) throw new Error(tr("Gemini nu a primit mesajul (butonul de trimitere nu s-a activat)."))
      return await this.follow(page, before, owner)
    } finally {
      cleanup?.()
    }
  }

  /** Runs one tool the model asked for: shown in the chat like any tool, asked first when the mode and the tool call for it. */
  private async runTool(set: ToolSet, call: ToolCall): Promise<ToolOutcome> {
    const id = randomUUID()
    const name = `mcp__${set.server}__${call.tool}`
    const base = { kind: 'tool' as const, id, name, title: claudeToolTitle(name, call.args), input: call.args }
    this.host.emit({ type: 'item', sessionId: this.meta.id, item: { ...base, status: 'running' } })
    if (!(await this.allowed(set, call, base.title))) {
      this.host.emit({ type: 'item', sessionId: this.meta.id, item: { ...base, status: 'error', output: tr("Refuzat.") } })
      return { text: 'The user did not allow this action. Do not try it again; tell the user what you wanted to do and ask.', images: [], error: true }
    }
    const out = await callTool(set, this.meta.id, call)
    const host = /Page URL:\s*https?:\/\/([^\s/:?#]+)/i.exec(out.text)?.[1]?.toLowerCase()
    if (host) this.site = host
    this.host.emit({
      type: 'item', sessionId: this.meta.id,
      item: { ...base, status: out.error ? 'error' : 'done', output: truncate(out.text), ...(out.images.length ? { images: out.images.map((im) => `data:${im.mime};base64,${im.data}`) } : {}) }
    })
    return out
  }

  /** Same rules as for Claude: looking is free outside Manual mode, acting on a page is asked once per site, the rest one by one. */
  private async allowed(set: ToolSet, call: ToolCall, title: string): Promise<boolean> {
    const kind = set.kind(call.tool)
    if (kind === 'blocked') return false
    const mode = this.meta.permissionMode
    if (mode !== 'ask') {
      if (kind === 'read' || kind === 'self' || mode === 'full') return true
      if (kind === 'act') {
        if (this.tools?.siteTrust() === 'free') return true
        if (this.site && this.trusted.has(this.site)) return true
      }
    }
    const site = kind === 'act' ? this.site : undefined
    const id = randomUUID()
    this.host.emit({
      type: 'permission', sessionId: this.meta.id,
      request: { id, toolName: `mcp__${set.server}__${call.tool}`, title, detail: truncate(JSON.stringify(call.args, null, 2), 4000), canAllowForSession: Boolean(site), sessionLabel: site ? tr("Mereu pe {site}", { site }) : undefined }
    })
    const decision = await new Promise<PermissionDecision>((resolve) => this.pending.set(id, { resolve, site }))
    return decision !== 'deny'
  }

  /** Reads the new answer while it grows, shows it (without the tool block), and returns the final markdown. */
  private async follow(page: GeminiPage, before: number, owner?: (name: string) => ToolSet | undefined): Promise<string> {
    const id = randomUUID()
    const started = Date.now()
    let shown = ''
    let raw = ''
    let changed = Date.now()
    let last: PageState | undefined
    for (;;) {
      if (this.cancelled || this.closed) return raw
      const st = await page.eval<PageState>('window.__joltyGemini.state()')
      last = st
      if (st.responses > before) {
        raw = st.markdown
        const visible = owner ? splitReply(raw, (n) => Boolean(owner(n))).text : raw
        if (visible !== shown) {
          if (visible.startsWith(shown) && visible.length > shown.length) this.host.emit({ type: 'delta', sessionId: this.meta.id, itemId: id, kind: 'assistant', delta: visible.slice(shown.length) })
          // a rewrite of earlier text is not streamed: the final item below replaces what was shown
          shown = visible
          changed = Date.now()
        }
        if (!st.busy && !st.stop && Date.now() - changed > 900) break
      } else if (Date.now() - started > 90000) {
        throw new Error(tr("Gemini nu a răspuns în 90 de secunde. Verifică fereastra browserului Jolty."))
      }
      await sleep(250)
    }
    if (shown) this.host.emit({ type: 'item', sessionId: this.meta.id, item: { kind: 'assistant', id, text: shown } as ChatItem })
    // the address of the chat on gemini.google.com is what brings the conversation back after a restart
    if (last && /\/app\/[0-9a-f]+/i.test(last.url) && this.meta.engineSessionId !== last.url) {
      this.meta.engineSessionId = last.url
      this.host.emit({ type: 'meta', sessionId: this.meta.id, meta: this.meta })
    }
    return raw
  }

  private denyAll(): void {
    for (const [id, p] of this.pending) {
      this.pending.delete(id)
      this.host.emit({ type: 'permissionResolved', sessionId: this.meta.id, requestId: id })
      p.resolve('deny')
    }
  }

  async interrupt(): Promise<void> {
    this.cancelled = true
    this.denyAll()
    this.tools?.interrupt?.(this.meta.id)
    if (this.page) await this.page.eval(STOP_SCRIPT).catch(() => undefined)
  }

  async setModel(model: string): Promise<void> {
    if (this.busy) throw new Error(tr("Oprește răspunsul Gemini înainte să schimbi modelul."))
    this.meta.model = model || undefined
  }

  async setEffort(effort: string): Promise<void> {
    this.meta.effort = effort || undefined
  }

  async setPermissionMode(mode: PermissionMode): Promise<void> {
    this.meta.permissionMode = mode
  }

  async setBrowser(): Promise<void> {
    // the switch lives in meta.browser: each message looks at it
  }

  async setComputer(): Promise<void> {
    // same for meta.computer
  }

  async compact(): Promise<void> {
    throw new Error(tr("Gemini își gestionează singur contextul conversației."))
  }

  async rewind(): Promise<never> {
    throw new Error(tr("Gemini nu lucrează pe fișierele proiectului, deci nu are ce să dea înapoi."))
  }

  respond(requestId: string, decision: PermissionDecision): void {
    const p = this.pending.get(requestId)
    if (!p) return
    this.pending.delete(requestId)
    this.host.emit({ type: 'permissionResolved', sessionId: this.meta.id, requestId })
    if (decision === 'allowSession' && p.site) this.trusted.add(p.site)
    p.resolve(decision)
  }

  async close(): Promise<void> {
    this.closed = true
    await this.interrupt()
    const page = this.page
    this.page = undefined
    await page?.dispose()
  }
}

export class GeminiWebDriver implements EngineDriver {
  private sessions = new Set<EngineSession>()
  private catalog?: Catalog
  constructor(private browser: GeminiBrowser, private tools?: GeminiTools) {}

  createSession(profile: Profile, meta: SessionMeta, host: EngineHost): EngineSession {
    const session = new GeminiWebSession(meta, profile, host, this.browser, this.tools)
    this.sessions.add(session)
    return session
  }

  /** Opens gemini.google.com for a moment, in a tab of its own. */
  private async look<T>(run: (page: GeminiPage) => Promise<T>): Promise<T> {
    const page = await this.browser.open(`gemini-web-probe-${randomUUID().slice(0, 8)}`, GEMINI_URL)
    try {
      await page.eval(PAGE_LIB)
      for (let i = 0; i < 40; i++) {
        const a = await page.eval<{ composer: boolean; signIn: boolean }>(ACCOUNT_SCRIPT)
        if (a.composer || (a.signIn && i > 4)) break
        await sleep(200)
      }
      return await run(page)
    } finally {
      await page.dispose()
    }
  }

  async status(profile: Profile): Promise<AccountStatus> {
    try {
      return await this.look(async (page) => {
        const a = await page.eval<{ composer: boolean; email: string }>(ACCOUNT_SCRIPT)
        return a.composer
          ? { profileId: profile.id, loggedIn: true, email: a.email || undefined, detail: tr("Abonamentul tău Gemini din browserul Jolty") }
          : { profileId: profile.id, loggedIn: false, error: LOGIN_MESSAGE() }
      })
    } catch (e) {
      return { profileId: profile.id, loggedIn: false, error: e instanceof Error ? e.message : String(e) }
    }
  }

  /** Sign-in happens on Google's own page in the Jolty browser window; this opens it and waits for the answer. */
  async login(profile: Profile): Promise<AccountStatus> {
    const page = await this.browser.open(`gemini-web-login-${randomUUID().slice(0, 8)}`, GEMINI_URL)
    try {
      const end = Date.now() + 5 * 60_000
      while (Date.now() < end) {
        const a = await page.eval<{ composer: boolean }>(ACCOUNT_SCRIPT).catch(() => ({ composer: false }))
        if (a.composer) return this.status(profile)
        await sleep(2000)
      }
    } finally {
      await page.dispose()
    }
    return { profileId: profile.id, loggedIn: false, error: LOGIN_MESSAGE() }
  }

  async logout(): Promise<AccountStatus> {
    throw new Error(tr("Deconectarea se face din contul tău Google, în browser."))
  }

  async models(): Promise<ModelOption[]> {
    const cached = this.catalog ?? this.browser.catalog?.read()
    if (cached && Date.now() - cached.at < 12 * 3600_000) return cached.models
    // the picker asks for every account when it opens: that must not wake the browser up, so without it the old list (or none) is the answer
    if (!this.browser.connected()) return cached?.models ?? []
    try {
      const models = await this.look(async (page) => {
        const menu = await page.eval<MenuRead>(MENU_SCRIPT)
        await page.eval(CLOSE_MENU_SCRIPT)
        return parseMenu(menu)
      })
      if (!models.length) throw new Error(LOGIN_MESSAGE())
      this.catalog = { at: Date.now(), models }
      this.browser.catalog?.write(this.catalog)
      return models
    } catch (e) {
      if (cached) return cached.models
      throw e
    }
  }

  async externalSessions(): Promise<ExternalSession[]> {
    return []
  }

  async describe(): Promise<string> {
    throw new Error(tr("Alege un profil cu vedere verificată pentru descrierea imaginilor."))
  }

  async history(): Promise<ChatItem[]> {
    return []
  }

  async limits(): Promise<RateLimitSnapshot | undefined> {
    return undefined
  }

  async shutdown(): Promise<void> {
    await Promise.all([...this.sessions].map((s) => s.close().catch(() => undefined)))
    this.sessions.clear()
    this.catalog = undefined
  }
}
