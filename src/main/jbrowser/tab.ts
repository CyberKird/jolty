// One browser tab the model controls: DevTools Protocol access plus what the page has been saying
// (console, network, dialogs, file choosers) so tool results can report it.
import type { BrowserHub } from './hub'
import { BOOT_SCRIPT, PAGE_SCRIPT } from './page-script'

export interface ConsoleEntry {
  level: 'error' | 'warning' | 'info' | 'log' | 'debug'
  text: string
  at: number
}

export interface NetEntry {
  id: string
  method: string
  url: string
  type: string
  status?: number
  mime?: string
  failed?: string
  at: number
}

export interface Dialog {
  type: string
  message: string
  defaultPrompt?: string
}

export class NoTabError extends Error {
  constructor() {
    super('No tab is open. Use browser_navigate with a URL, or browser_tabs with action "new".')
  }
}

type Params = Record<string, unknown>
type LoadState = 'loading' | 'interactive' | 'complete'

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
// long-lived or decorative requests that say nothing about whether the page has settled
const QUIET_TYPES = new Set(['WebSocket', 'EventSource', 'Ping', 'Image', 'Font', 'Media', 'Other', 'Manifest', 'Prefetch', 'CSPViolationReport', 'Preflight'])

export class Tab {
  title = ''
  url = ''
  windowId = 0
  console: ConsoleEntry[] = []
  network: NetEntry[] = []
  dialog?: Dialog
  chooser?: { backendNodeId: number; mode: string }
  dragData?: Params
  state: LoadState = 'complete'
  dead = false
  lastUsed = Date.now()
  mainFrame = ''
  private inflight = new Map<string, number>()
  private quietSince = Date.now()
  private waiters: (() => void)[] = []
  private dialogWaiters: (() => void)[] = []
  private requestIndex = new Map<string, NetEntry>()

  constructor(
    readonly id: number,
    private hub: BrowserHub,
    private overlay: () => boolean
  ) {}

  send<T = Params>(method: string, params: Params = {}, timeoutMs = 30000): Promise<T> {
    const call = this.hub.cdp<T>(this.id, method, params, undefined, timeoutMs)
    // An alert opened by a click holds the click's own command until someone answers the dialog.
    // The tool must report the dialog instead of hanging, so input commands stop waiting once one opens.
    if (!method.startsWith('Input.')) return call
    call.catch(() => undefined)
    return Promise.race([call, new Promise<T>((resolve) => this.dialogWaiters.push(() => resolve({} as T)))])
  }

  /** Turns on the protocol domains Jolty listens to and puts the page script on every new document. */
  async init(): Promise<void> {
    await this.send('Page.enable')
    await Promise.all([
      this.send('Runtime.enable'),
      this.send('Network.enable'),
      this.send('Log.enable'),
      this.send('Page.setLifecycleEventsEnabled', { enabled: true }),
      this.send('Page.setInterceptFileChooserDialog', { enabled: true }).catch(() => undefined),
      // a page behind other windows still believes it has focus, so it keeps painting and answering
      this.send('Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => undefined)
    ])
    await this.send('Page.addScriptToEvaluateOnNewDocument', { source: BOOT_SCRIPT, runImmediately: true }).catch(() => undefined)
    const tree = await this.send<{ frameTree: { frame: { id: string; url: string } } }>('Page.getFrameTree').catch(() => undefined)
    if (tree) {
      this.mainFrame = tree.frameTree.frame.id
      this.url = tree.frameTree.frame.url
    }
  }

  // ------------------------------------------------------------------ events
  onEvent(method: string, p: Params): void {
    switch (method) {
      case 'Page.frameNavigated': {
        const frame = p.frame as { id: string; url: string; parentId?: string }
        if (!frame.parentId) {
          this.mainFrame = frame.id
          this.url = frame.url
          this.state = 'loading'
          this.dialog = undefined
          this.chooser = undefined
          this.inflight.clear()
        }
        break
      }
      case 'Page.navigatedWithinDocument': {
        if ((p.frameId as string) === this.mainFrame) this.url = String(p.url)
        break
      }
      case 'Page.lifecycleEvent': {
        if ((p.frameId as string) !== this.mainFrame) break
        if (p.name === 'DOMContentLoaded' && this.state === 'loading') this.state = 'interactive'
        if (p.name === 'load') this.state = 'complete'
        if (this.state !== 'loading') this.wake()
        break
      }
      case 'Page.javascriptDialogOpening': {
        const d: Dialog = { type: String(p.type), message: String(p.message), defaultPrompt: p.defaultPrompt as string | undefined }
        // leaving the page is never blocked by this: the tool that navigated would hang
        if (d.type === 'beforeunload') void this.send('Page.handleJavaScriptDialog', { accept: true }).catch(() => undefined)
        else {
          this.dialog = d
          for (const w of this.dialogWaiters.splice(0)) w()
        }
        break
      }
      case 'Page.javascriptDialogClosed':
        this.dialog = undefined
        break
      case 'Input.dragIntercepted':
        this.dragData = p.data as Params
        break
      case 'Page.fileChooserOpened':
        this.chooser = { backendNodeId: p.backendNodeId as number, mode: String(p.mode || 'selectSingle') }
        break
      case 'Runtime.consoleAPICalled': {
        const type = String(p.type)
        const level = type === 'error' || type === 'assert' ? 'error' : type === 'warning' ? 'warning' : type === 'info' ? 'info' : type === 'debug' || type === 'trace' ? 'debug' : 'log'
        const args = (p.args as { value?: unknown; description?: string; type?: string }[]) || []
        const text = args.map((a) => (a.value !== undefined ? (typeof a.value === 'string' ? a.value : JSON.stringify(a.value)) : a.description || a.type || '')).join(' ')
        this.pushConsole(level, text)
        break
      }
      case 'Runtime.exceptionThrown': {
        const d = p.exceptionDetails as { text?: string; exception?: { description?: string }; url?: string; lineNumber?: number }
        this.pushConsole('error', `${d.exception?.description || d.text || 'Uncaught error'}${d.url ? ` (${d.url}:${(d.lineNumber ?? 0) + 1})` : ''}`)
        break
      }
      case 'Log.entryAdded': {
        const e = p.entry as { level: string; text: string; url?: string }
        this.pushConsole(e.level === 'error' ? 'error' : e.level === 'warning' ? 'warning' : e.level === 'info' ? 'info' : 'log', e.text + (e.url ? ` (${e.url})` : ''))
        break
      }
      case 'Network.requestWillBeSent': {
        const r = p.request as { url: string; method: string }
        const type = String(p.type || 'Other')
        // a new document in the main frame: the log is "since the page loaded"
        if (type === 'Document' && p.requestId === p.loaderId && (!this.mainFrame || p.frameId === this.mainFrame)) {
          this.network = []
          this.requestIndex.clear()
          this.console = []
        }
        const entry: NetEntry = { id: String(p.requestId), method: r.method, url: r.url, type, at: Date.now() }
        this.requestIndex.set(entry.id, entry)
        this.network.push(entry)
        if (this.network.length > 500) this.requestIndex.delete(this.network.shift()!.id)
        if (!QUIET_TYPES.has(type)) this.inflight.set(entry.id, Date.now())
        break
      }
      case 'Network.responseReceived': {
        const e = this.requestIndex.get(String(p.requestId))
        const r = p.response as { status: number; mimeType: string }
        if (e) {
          e.status = r.status
          e.mime = r.mimeType
        }
        break
      }
      case 'Network.loadingFinished':
        this.finish(String(p.requestId))
        break
      case 'Network.loadingFailed': {
        const e = this.requestIndex.get(String(p.requestId))
        if (e) e.failed = String(p.errorText || 'failed')
        this.finish(String(p.requestId))
        break
      }
    }
  }

  private pushConsole(level: ConsoleEntry['level'], text: string): void {
    this.console.push({ level, text: text.length > 2000 ? text.slice(0, 2000) + '…' : text, at: Date.now() })
    if (this.console.length > 300) this.console.shift()
  }

  private finish(id: string): void {
    this.inflight.delete(id)
    if (!this.inflight.size) this.quietSince = Date.now()
  }

  private wake(): void {
    for (const w of this.waiters.splice(0)) w()
  }

  // ------------------------------------------------------------------ waiting
  /** Waits until the main frame has loaded (or the time is up). */
  async waitLoad(timeoutMs = 20000): Promise<void> {
    const end = Date.now() + timeoutMs
    while (this.state !== 'complete' && !this.dialog && Date.now() < end) {
      await new Promise<void>((r) => {
        this.waiters.push(r)
        setTimeout(r, 250)
      })
    }
  }

  /** After an action: lets a navigation finish and the page's own requests quiet down. */
  async settle(maxMs = 3500): Promise<void> {
    await sleep(160)
    if (this.state === 'loading') await this.waitLoad(15000)
    const end = Date.now() + maxMs
    while (Date.now() < end) {
      if (this.dialog || (!this.inflight.size && Date.now() - this.quietSince >= 350)) return
      // a request that has hung for long does not hold the answer back
      for (const [id, at] of this.inflight) if (Date.now() - at > 5000) this.inflight.delete(id)
      await sleep(80)
    }
  }

  // ------------------------------------------------------------------ evaluating
  /** Runs an expression in the page and returns its value. */
  async eval<T = unknown>(expression: string, opts: { awaitPromise?: boolean } = {}): Promise<T> {
    let last: Error | undefined
    // right after a navigation the new document may not have a context yet
    for (let i = 0; i < 12; i++) {
      try {
        const r = await this.send<{ result: { value?: T }; exceptionDetails?: { text: string; exception?: { description?: string } } }>('Runtime.evaluate', {
          expression,
          returnByValue: true,
          awaitPromise: opts.awaitPromise !== false,
          allowUnsafeEvalBlockedByCSP: true,
          userGesture: true
        })
        if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text)
        return r.result.value as T
      } catch (e) {
        last = e as Error
        if (!/context|Cannot find|detached|Inspected target navigated|Target closed/i.test(last.message)) throw last
        await sleep(150)
      }
    }
    throw last!
  }

  /** Calls a function of the page script: `P("target", id)` runs `__joltyP.target(id)`. */
  async P<T = unknown>(fn: string, ...args: unknown[]): Promise<T> {
    const call = `(() => { const P = window.__joltyP; if (!P) return { __missing: true }; return P.${fn}(...${JSON.stringify(args)}) })()`
    let r = await this.eval<T | { __missing: true }>(call)
    if (r && typeof r === 'object' && (r as { __missing?: boolean }).__missing) {
      await this.eval(PAGE_SCRIPT)
      r = await this.eval<T | { __missing: true }>(call)
      if (r && typeof r === 'object' && (r as { __missing?: boolean }).__missing) {
        const why = await this.eval<string>('window.__joltyError || ""').catch(() => '')
        throw new Error('Jolty could not run its script in this page' + (why ? ': ' + why : ' (the page blocks it)'))
      }
    }
    return r as T
  }

  /** The glow, bolt and cursor. `rect` = [x, y, width, height, click] puts the cursor on a target first. */
  async touch(rect?: number[]): Promise<void> {
    this.lastUsed = Date.now()
    if (!this.overlay()) return
    await this.P('draw', rect || null).catch(() => undefined)
  }

  // ------------------------------------------------------------------ input
  async mouse(type: 'mouseMoved' | 'mousePressed' | 'mouseReleased' | 'mouseWheel', x: number, y: number, extra: Params = {}): Promise<void> {
    await this.send('Input.dispatchMouseEvent', { type, x, y, ...extra })
  }

  async click(x: number, y: number, opts: { button?: 'left' | 'right' | 'middle'; count?: number; modifiers?: number } = {}): Promise<void> {
    const button = opts.button || 'left'
    const count = opts.count || 1
    const modifiers = opts.modifiers || 0
    await this.mouse('mouseMoved', x, y, { modifiers })
    for (let i = 1; i <= count; i++) {
      await this.mouse('mousePressed', x, y, { button, clickCount: i, modifiers })
      await this.mouse('mouseReleased', x, y, { button, clickCount: i, modifiers })
    }
  }

  async insertText(text: string): Promise<void> {
    await this.send('Input.insertText', { text })
  }

  async key(events: Params[]): Promise<void> {
    for (const e of events) await this.send('Input.dispatchKeyEvent', e)
  }
}
