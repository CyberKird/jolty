// The browser service behind the MCP endpoint: which tabs each chat controls, the page state text
// models read after every action, the live picture for Jolty's panel, and the MCP message handling.
import type { BrowserHub } from './hub'
import { NoTabError, Tab } from './tab'
import { TOOLS, type ToolResult } from './tools'

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

export interface ServiceOptions {
  /** glow, cursor and bolt while a model drives a tab */
  overlay: () => boolean
  /** what to tell the model when no browser extension is connected */
  notConnected: () => string
  /** opens the browser when it is closed and waits for the extension to connect */
  ensureBrowser?: () => Promise<void>
  log?: (m: string) => void
}

export interface LiveFrame {
  frame?: string
  url?: string
  title?: string
}

interface Session {
  sid: string
  tabs: Tab[]
  current?: Tab
  /** tabs a page opened (links, popups) since the last tool result */
  fresh: Tab[]
  lock: Promise<unknown>
}

export const MAX_TABS = 12

export class BrowserService {
  private sessions = new Map<string, Session>()
  private byId = new Map<number, Tab>()
  private windowId = 0
  private liveTab?: Tab
  private liveListener?: (f: LiveFrame) => void

  constructor(
    readonly hub: BrowserHub,
    readonly opts: ServiceOptions
  ) {
    hub.on('event', (tabId: number, method: string, params: Record<string, unknown>, sessionId?: string) => {
      const tab = this.byId.get(tabId)
      if (!tab || sessionId) return
      if (method === 'Page.screencastFrame') return void this.onFrame(tab, params)
      tab.onEvent(method, params)
    })
    hub.on('detached', (tabId: number, reason: string) => {
      const tab = this.byId.get(tabId)
      if (!tab) return
      // the user pressed Cancel on the browser's "debugging" bar: that is a stop sign, not a glitch
      if (/cancel/i.test(reason)) this.forget(tab, 'The user stopped Jolty from controlling this tab (closed the browser\'s debugging bar). Ask before taking it over again.')
      else this.forget(tab)
    })
    hub.on('tabRemoved', (tabId: number) => {
      const tab = this.byId.get(tabId)
      if (tab) this.forget(tab)
    })
    hub.on('tabCreated', (info: { id: number; windowId: number; url: string; title: string }, openerTabId?: number) => void this.adopt(info, openerTabId))
    hub.on('status', (connected: boolean) => {
      if (!connected) {
        // the browser (or the extension) went away: its tabs are not ours to hold on to
        for (const t of [...this.byId.values()]) this.forget(t)
        this.windowId = 0
      }
    })
  }

  // ------------------------------------------------------------------ sessions and tabs
  private session(sid: string): Session {
    let s = this.sessions.get(sid)
    if (!s) this.sessions.set(sid, (s = { sid, tabs: [], fresh: [], lock: Promise.resolve() }))
    return s
  }

  private forget(tab: Tab, note?: string): void {
    tab.dead = true
    this.byId.delete(tab.id)
    for (const s of this.sessions.values()) {
      const i = s.tabs.indexOf(tab)
      if (i < 0) continue
      s.tabs.splice(i, 1)
      s.fresh = s.fresh.filter((t) => t !== tab)
      if (s.current === tab) s.current = s.tabs[Math.min(i, s.tabs.length - 1)]
      if (note) tab.title = note
    }
    if (this.liveTab === tab) void this.pickLive()
  }

  private async adopt(info: { id: number; windowId: number; url: string }, openerTabId?: number): Promise<void> {
    if (openerTabId === undefined) return
    const opener = this.byId.get(openerTabId)
    if (!opener || this.byId.has(info.id)) return
    const owner = [...this.sessions.values()].find((s) => s.tabs.includes(opener))
    if (!owner || owner.tabs.length >= MAX_TABS) return
    try {
      const tab = await this.attach(info.id, info.windowId)
      owner.tabs.push(tab)
      owner.fresh.push(tab)
    } catch (e) {
      this.opts.log?.('adopt: ' + (e as Error).message)
    }
  }

  private async attach(tabId: number, windowId: number): Promise<Tab> {
    const tab = new Tab(tabId, this.hub, this.opts.overlay)
    tab.windowId = windowId
    this.byId.set(tabId, tab)
    try {
      await tab.init()
    } catch (e) {
      this.byId.delete(tabId)
      throw e
    }
    return tab
  }

  /** A new tab in the window Jolty keeps for the model, so the user's own tabs stay untouched. */
  async openTab(sid: string, url = `http://127.0.0.1:${this.hub.port}/jolty-blank`): Promise<Tab> {
    const s = this.session(sid)
    if (s.tabs.length >= MAX_TABS) throw new Error(`This chat already controls ${MAX_TABS} tabs. Close one first (browser_tabs, action "close").`)
    let info: { id: number; windowId: number }
    try {
      info = await this.hub.request('tabs.create', { url, ...(this.windowId ? { windowId: this.windowId } : { newWindow: true }) })
    } catch (e) {
      // the window was closed: start a new one
      if (!this.windowId) throw e
      this.windowId = 0
      info = await this.hub.request('tabs.create', { url, newWindow: true })
    }
    this.windowId = info.windowId
    const tab = await this.attach(info.id, info.windowId)
    s.tabs.push(tab)
    s.current = tab
    void this.pickLive()
    return tab
  }

  /** The tab the user is looking at: only on request, and only ordinary web pages. */
  async takeCurrent(sid: string): Promise<Tab> {
    const s = this.session(sid)
    const info = await this.hub.request<{ id: number; windowId: number; url: string } | null>('tabs.current')
    if (!info) throw new Error('No browser tab is open.')
    if (!/^https?:\/\//i.test(info.url)) throw new Error('The tab in front is not an ordinary web page, so Jolty will not take it over.')
    const known = this.byId.get(info.id)
    if (known) {
      if (!s.tabs.includes(known)) s.tabs.push(known)
      s.current = known
      return known
    }
    const tab = await this.attach(info.id, info.windowId)
    s.tabs.push(tab)
    s.current = tab
    void this.pickLive()
    return tab
  }

  async closeTab(sid: string, tab: Tab): Promise<void> {
    await this.hub.request('tabs.close', { tabId: tab.id }).catch(() => undefined)
    this.forget(tab)
    void sid
  }

  select(sid: string, tab: Tab): void {
    this.session(sid).current = tab
    void this.hub.request('tabs.update', { tabId: tab.id, active: true }).catch(() => undefined)
    void this.pickLive()
  }

  tabsOf(sid: string): Tab[] {
    return this.session(sid).tabs
  }

  currentOf(sid: string): Tab | undefined {
    return this.session(sid).current
  }

  /** The chat is over (or turned the browser off): let go of its tabs, leaving them open for the user. */
  async release(sid: string): Promise<void> {
    const s = this.sessions.get(sid)
    if (!s) return
    this.sessions.delete(sid)
    for (const t of s.tabs) {
      this.byId.delete(t.id)
      t.dead = true
      await this.hub.request('debugger.detach', { tabId: t.id }).catch(() => undefined)
    }
    void this.pickLive()
  }

  // ------------------------------------------------------------------ what the model reads
  /** The page state block every tool ends with: where we are, what is blocking, what is on the page. */
  async state(sid: string, tab: Tab, opts: { snapshot?: boolean; ref?: string; budget?: number } = {}): Promise<string> {
    const out: string[] = []
    const s = this.session(sid)
    if (s.fresh.length) {
      const fresh = s.fresh.splice(0)
      for (const t of fresh) await t.waitLoad(8000).catch(() => undefined)
      s.current = fresh[fresh.length - 1]
      out.push(`### New tab\nA page opened ${fresh.length === 1 ? 'a new tab' : fresh.length + ' new tabs'}; you are now on the newest one. Use browser_tabs to switch back.`)
      tab = s.current
    }
    if (tab.dialog) {
      out.push(`### Modal state\n- A JavaScript ${tab.dialog.type} dialog is open: ${JSON.stringify(tab.dialog.message)}. Answer it with browser_handle_dialog before anything else.`)
      return out.join('\n\n')
    }
    let url = tab.url
    let title = tab.title
    let body = ''
    let scroll = ''
    if (opts.snapshot !== false) {
      type Snap = { url: string; title: string; text: string; scroll: { y: number; height: number; view: number }; error?: string; loading?: boolean }
      if (tab.state === 'loading') await tab.waitLoad(10000)
      let snap = await tab.P<Snap>('snapshot', { ref: opts.ref, budget: opts.budget })
      // a click or Enter may have started a navigation: the new document has no body for a moment
      for (let i = 0; snap.loading && i < 25; i++) {
        await sleep(200)
        snap = await tab.P<Snap>('snapshot', { ref: opts.ref, budget: opts.budget })
      }
      if (snap.loading) throw new Error('The page is still loading: try again in a moment.')
      if (snap.error) throw new Error(snap.error)
      url = snap.url
      title = snap.title.replace(/^⚡ /, '')
      tab.url = url
      tab.title = title
      body = snap.text
      const more = snap.scroll.height - snap.scroll.y - snap.scroll.view
      scroll = `- Scroll: ${snap.scroll.y}px of ${snap.scroll.height}px${more > 40 ? ` (${Math.round(more)}px more below)` : ''}`
    } else {
      title = (await tab.eval<string>('document.title').catch(() => title)).replace(/^⚡ /, '')
      tab.title = title
    }
    const head = ['### Page state', `- Page URL: ${url}`, `- Page Title: ${title}`]
    if (scroll) head.push(scroll)
    if (tab.chooser) head.push('- A file chooser is open: use browser_file_upload to answer it.')
    const errors = tab.console.filter((c) => c.level === 'error' && c.at > Date.now() - 4000)
    if (errors.length) head.push(`- ${errors.length} console error${errors.length > 1 ? 's' : ''} just now (browser_console_messages shows them)`)
    out.push(head.join('\n'))
    const all = s.tabs.filter((t) => !t.dead)
    if (all.length > 1) out.push('### Open tabs\n' + all.map((t, i) => `- ${i}:${t === tab ? ' (current)' : ''} [${t.title || 'untitled'}](${t.url})`).join('\n'))
    if (opts.snapshot !== false) out.push('### Snapshot\n```yaml\n' + (body || '- (the page has no readable content yet)') + '\n```')
    return out.join('\n\n')
  }

  // ------------------------------------------------------------------ live picture
  setLive(listener: ((f: LiveFrame) => void) | undefined): void {
    const had = this.liveListener
    this.liveListener = listener
    if (listener && !had) void this.pickLive()
    if (!listener) void this.stopLive()
  }

  private async stopLive(): Promise<void> {
    const t = this.liveTab
    this.liveTab = undefined
    if (t && !t.dead) await t.send('Page.stopScreencast').catch(() => undefined)
  }

  /** Streams the tab the model used last. */
  private async pickLive(): Promise<void> {
    if (!this.liveListener) return
    const best = [...this.byId.values()].filter((t) => !t.dead).sort((a, b) => b.lastUsed - a.lastUsed)[0]
    if (best === this.liveTab) return
    await this.stopLive()
    if (!best) {
      this.liveListener({})
      return
    }
    this.liveTab = best
    await best.send('Page.startScreencast', { format: 'jpeg', quality: 60, maxWidth: 1280, maxHeight: 900 }).catch(() => undefined)
  }

  private onFrame(tab: Tab, p: Record<string, unknown>): void {
    // the browser sends the next frame only after this one is acknowledged
    void tab.send('Page.screencastFrameAck', { sessionId: p.sessionId }).catch(() => undefined)
    if (tab === this.liveTab) this.liveListener?.({ frame: String(p.data), url: tab.url, title: tab.title })
  }

  /** Called by tools so the live picture follows the model from tab to tab. */
  touched(tab: Tab): void {
    tab.lastUsed = Date.now()
    if (this.liveListener && this.liveTab !== tab) void this.pickLive()
  }

  // ------------------------------------------------------------------ MCP
  async handle(sid: string, msg: Record<string, unknown>): Promise<Record<string, unknown> | undefined> {
    const id = msg.id
    const method = String(msg.method || '')
    const reply = (result: unknown): Record<string, unknown> => ({ jsonrpc: '2.0', id, result })
    if (id === undefined || id === null) return undefined // notifications (initialized, cancelled, ...)
    if (method === 'initialize') {
      const params = (msg.params || {}) as { protocolVersion?: string }
      return reply({ protocolVersion: params.protocolVersion || '2025-03-26', capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'jolty-browser', version: '1.0.0' } })
    }
    if (method === 'ping') return reply({})
    if (method === 'tools/list') {
      return reply({ tools: TOOLS.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema, ...(t.annotations ? { annotations: t.annotations } : {}) })) })
    }
    if (method === 'tools/call') {
      const params = (msg.params || {}) as { name?: string; arguments?: Record<string, unknown> }
      return reply(await this.call(sid, String(params.name || ''), params.arguments || {}))
    }
    return { jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } }
  }

  /** Runs one tool call; calls of the same chat go one after another. */
  call(sid: string, name: string, args: Record<string, unknown>): Promise<ToolResult> {
    const s = this.session(sid)
    const run = s.lock.then(() => this.run(sid, name, args))
    s.lock = run.catch(() => undefined)
    return run
  }

  private async run(sid: string, name: string, args: Record<string, unknown>): Promise<ToolResult> {
    const def = TOOLS.find((t) => t.name === name)
    const fail = (text: string): ToolResult => ({ content: [{ type: 'text', text }], isError: true })
    if (!def) return fail(`Unknown tool ${name}`)
    if (!this.hub.connected) await this.opts.ensureBrowser?.()
    if (!this.hub.connected) return fail(this.opts.notConnected())
    try {
      return await Promise.race([
        def.run(this, sid, args),
        sleep(90000).then(() => {
          throw new Error(`${name} took more than 90 seconds`)
        })
      ])
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      this.opts.log?.(`${name}: ${msg}`)
      // a failed action still shows where the model is, so it can recover
      let where = ''
      const tab = this.currentOf(sid)
      if (tab && !tab.dead && !(e instanceof NoTabError)) {
        where = await this.state(sid, tab, { snapshot: false }).catch(() => '')
      }
      return fail(`### Error\n${msg}${where ? '\n\n' + where : ''}`)
    }
  }
}
