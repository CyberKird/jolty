// The computer-use service behind the MCP endpoint: per chat it remembers what the model last saw (the screenshot
// that its coordinates refer to, the window in front), and every action goes through the same gate here:
// switched on, not stopped, user idle, same window as when it looked, not a forbidden window, approved.
import { noQuestions, type PermissionDecision, type PermissionMode } from '@shared/types'
import { tr } from '@shared/i18n'
import { stillThere, toPhysical, viewOf, type DisplayInfo, type View } from './geometry'
import type { HelperState, InputBackend, PlayResult, WinInfo } from './helper'
import { makeRng, readingPauseMs, type Humanness, type Rng } from './human'
import type { Capturer } from './capture'
import type { Overlay } from './overlay'
import { driftPlan, planEnd, type Ev } from './plan'
import { appKey, appLabel, classify, type WinFacts } from './policy'
import { fail, UserError, type ToolResult } from './result'
import { TOOLS } from './tools'

export { fail, text, UserError, type ToolResult } from './result'

export interface ComputerSettings {
  human: Humanness
  /** long text may go in through the clipboard */
  paste: boolean
  /** programs the user said yes to for good (exe names, lower case) */
  trusted: string[]
}

export interface AskInput {
  title: string
  detail?: string
  /** when set, "always" is offered and means this application */
  app?: string
}

export interface ComputerHost {
  settings(): ComputerSettings
  trust(key: string): void
  mode(sid: string): PermissionMode | undefined
  enabled(sid: string): boolean
  ask(sid: string, q: AskInput): Promise<PermissionDecision>
  notice(sid: string, text: string, level: 'info' | 'warn' | 'error'): void
  clipboard: { readText(): Promise<string>; writeText(t: string): Promise<void>; hasImage(): Promise<boolean> }
  /** the program that is Jolty itself, whose windows are never operated */
  self: { pid: number; exe: string }
}

export interface ServiceDeps {
  input: InputBackend
  capturer: Capturer
  overlay: Overlay
  host: ComputerHost
  rng?: Rng
  sleep?: (ms: number) => Promise<void>
  /** acting tools per turn */
  turnCap?: number
}

export interface Session {
  sid: string
  view?: View
  /** the window that was in front when the model last looked, or that the last action left in front */
  seenFg?: number
  lastShotAt: number
  lookedSinceAct: boolean
  acts: number
  trusted: Set<string>
  lock: Promise<unknown>
  capNoticed: boolean
  lastActEnd: number
  /** this turn's first move of the real mouse was announced */
  warned?: boolean
}

const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

export class ComputerService {
  private sessions = new Map<string, Session>()
  readonly input: InputBackend
  readonly capturer: Capturer
  readonly overlay: Overlay
  readonly host: ComputerHost
  readonly rng: Rng
  readonly sleep: (ms: number) => Promise<void>
  private turnCap: number
  /** set by the kill switch: every call fails until the chat turns the toggle on again */
  private killed = new Set<string>()

  constructor(d: ServiceDeps) {
    this.input = d.input
    this.capturer = d.capturer
    this.overlay = d.overlay
    this.host = d.host
    this.rng = d.rng ?? makeRng(Date.now() & 0xffffffff)
    this.sleep = d.sleep ?? defaultSleep
    this.turnCap = d.turnCap ?? 150
  }

  session(sid: string): Session {
    let s = this.sessions.get(sid)
    if (!s) this.sessions.set(sid, (s = { sid, lastShotAt: 0, lookedSinceAct: false, acts: 0, trusted: new Set(), lock: Promise.resolve(), capNoticed: false, lastActEnd: 0 }))
    return s
  }

  /** A new message from the user: the action budget starts over. */
  newTurn(sid: string): void {
    const s = this.sessions.get(sid)
    if (s) {
      s.acts = 0
      s.capNoticed = false
      s.warned = false
    }
  }

  /** The chat turned the toggle on or off. */
  setEnabled(sid: string, on: boolean): void {
    if (on) this.killed.delete(sid)
    else this.release(sid)
  }

  release(sid: string): void {
    this.sessions.delete(sid)
    this.killed.add(sid)
  }

  /** Kill switch: stop everything now. Returns the chats that had it on. */
  async killAll(): Promise<string[]> {
    const sids = [...this.sessions.keys()]
    for (const s of sids) this.killed.add(s)
    this.sessions.clear()
    await this.input.abort()
    this.overlay.idle()
    return sids
  }

  stopped(sid: string): boolean {
    return this.killed.has(sid)
  }

  // ------------------------------------------------------------------ the gate
  /** Checks that every tool call starts with. Returns the machine state for the checks that follow. */
  async begin(s: Session, kind: 'read' | 'act'): Promise<HelperState> {
    if (this.killed.has(s.sid) || !this.host.enabled(s.sid)) throw new UserError('Computer control is off for this chat (the user switched it off or pressed the kill key). Do not try again; tell the user.')
    const mode = this.host.mode(s.sid)
    if (kind === 'act') {
      if (mode === 'plan') throw new UserError('Plan mode: you can look (screenshot, windows, ui_tree) but not act. Describe the steps you would take.')
      if (s.acts >= this.turnCap) {
        if (!s.capNoticed) {
          s.capNoticed = true
          this.host.notice(s.sid, `Computer control stopped after ${this.turnCap} actions in one turn. Send a message to let it continue.`, 'warn')
        }
        throw new UserError(`Action limit reached (${this.turnCap} in one turn). Stop and tell the user what you did and what is left; they can send a message to continue.`)
      }
    }
    const st = await this.input.state()
    return st
  }

  /** The picture the model's coordinates refer to; a click needs one. */
  needView(s: Session): View {
    if (!s.view) throw new UserError('Take a screenshot first (computer_screenshot): coordinates refer to the latest screenshot.')
    if (!stillThere(this.capturer.displays(), s.view.display)) throw new UserError('The monitor layout changed since your last screenshot (a display was unplugged, moved or resized). Take a new screenshot; list the displays with computer_displays.')
    return s.view
  }

  /** Keys and clicks go to the window the model saw. If another one came to the front since, it has to look again. */
  checkFront(s: Session, st: HelperState): void {
    const fg = st.foreground
    if (s.seenFg === undefined) throw new UserError('Take a screenshot first (computer_screenshot) so you know which window is in front.')
    if ((fg?.hwnd ?? 0) !== s.seenFg) {
      throw new UserError(`The window in front changed since you last looked: now ${fg ? `"${fg.title}" (${fg.exe})` : 'nothing/another desktop'}. Take a new screenshot before acting.`)
    }
  }

  /** Forbidden windows are refused; the rest asks as the policy says. `what` is shown to the user. */
  async authorize(s: Session, win: WinInfo | null, st: HelperState, what: { title: string; detail?: string; always?: boolean }): Promise<void> {
    if (!win) throw new UserError('There is no window there to act on.')
    if (win.pid === this.host.self.pid || (win.path && win.path.toLowerCase() === this.host.self.exe.toLowerCase())) {
      throw new UserError('That is a Jolty window. The model never operates Jolty itself (it could approve its own requests). Work in another application.')
    }
    const facts: WinFacts = { exe: win.exe, title: win.title, cls: win.cls, path: win.path }
    const v = classify(facts, st.secure)
    if (v.kind === 'blocked') throw new UserError(v.reason)
    const mode = this.host.mode(s.sid)
    // Manual mode: the engine already asked for this very call
    if (mode === 'ask') return
    const settings = this.host.settings()
    const key = appKey(facts)
    const always = what.always || v.kind === 'always'
    // "No questions": nothing is asked; what stays off limits is refused by classify() above, not asked about
    if (noQuestions(mode)) return
    if (!always && (s.trusted.has(key) || settings.trusted.includes(key))) return
    this.overlay.paused(true)
    const answer = await this.host.ask(s.sid, { title: what.title, detail: what.detail, app: always ? undefined : appLabel(facts) })
    this.overlay.paused(false)
    if (answer === 'deny') throw new UserError('The user declined this action. Do not retry it; ask what they want instead.')
    if (answer === 'allowSession' && !always) {
      s.trusted.add(key)
      this.host.trust(key)
    }
  }

  /** For what belongs to no single application (starting a program, the clipboard): approved one by one. "No questions" skips it. */
  async confirmEach(s: Session, q: AskInput & { always?: boolean }): Promise<void> {
    const mode = this.host.mode(s.sid)
    if (mode === 'ask' || noQuestions(mode)) return
    this.overlay.paused(true)
    const answer = await this.host.ask(s.sid, { title: q.title, detail: q.detail })
    this.overlay.paused(false)
    if (answer === 'deny') throw new UserError('The user declined this action. Do not retry it; ask what they want instead.')
  }

  /** Tells the user on screen what is happening now, and outlines the window it happens in. */
  announce(label: string, win?: WinInfo | null): void {
    this.overlay.say(label, win && !win.minimized ? { x: win.x, y: win.y, w: win.w, h: win.h } : undefined)
  }

  /** Waits until the user's hands are off the mouse and keyboard. */
  async yieldToUser(s: Session): Promise<void> {
    let idle = await this.input.idleMs()
    if (idle >= 1500) return
    this.overlay.paused(true)
    const end = Date.now() + 15000
    while (idle < 1500 && Date.now() < end) {
      await this.sleep(300)
      idle = await this.input.idleMs()
    }
    this.overlay.paused(false)
    if (idle < 1500) throw new UserError('The user is using the mouse or keyboard right now, so Jolty paused. Wait a little (computer_wait), then take a screenshot and continue only if the screen is as expected.')
  }

  /** The look-before-you-act pause of a person, once per screenshot, with the hand resting. */
  async readingPause(s: Session, at: { x: number; y: number }): Promise<void> {
    if (!s.lookedSinceAct) return
    s.lookedSinceAct = false
    const mode = this.host.settings().human
    const ms = readingPauseMs(mode, this.rng)
    if (ms < 120) return
    if (mode === 'max' && ms >= 350) {
      const drift = driftPlan(at, ms, this.rng)
      if (drift.length) {
        await this.input.play(drift, {}).catch(() => undefined)
        const rest = ms - planEnd(drift)
        if (rest > 20) await this.sleep(rest)
        return
      }
    }
    await this.sleep(ms)
  }

  /** Plays events; turns the helper's stop reasons into messages the model can act on. */
  async perform(s: Session, events: Ev[], opts: { guard?: number } = {}): Promise<PlayResult> {
    await this.yieldToUser(s)
    // the real mouse and keyboard are about to move: say so on screen and give the user a moment to let go
    if (!s.warned) {
      s.warned = true
      this.overlay.active(this.displayOf(s))
      this.announce(tr("Jolty preia mouse-ul și tastatura în 3 secunde"))
      await this.sleep(3000)
      await this.yieldToUser(s)
    }
    this.overlay.active(this.displayOf(s))
    const res = await this.input.play(events, opts)
    s.lastActEnd = Date.now()
    if (res.reason === 'user') {
      this.overlay.paused(true)
      throw new UserError(`The user moved the mouse or pressed a key, so Jolty stopped after ${res.done} of ${res.total} steps and gave control back. Wait a few seconds, take a screenshot, and continue only if the screen is as expected.`)
    }
    if (res.reason === 'abort') throw new UserError('Stopped by the user (kill key). Do not continue; tell the user.')
    if (res.reason === 'foreground') throw new UserError(`The window in front changed while typing (${res.done} of ${res.total} key steps done). Take a screenshot to see what happened.`)
    return res
  }

  private displayOf(s: Session): DisplayInfo {
    return s.view?.display ?? this.capturer.displays().find((d) => d.primary) ?? this.capturer.displays()[0]
  }

  /** Counts an action and remembers that the model has not looked since. */
  acted(s: Session): void {
    s.acts++
    s.lookedSinceAct = false
  }

  /** What is in front now, for the end of an action's answer; the window becomes the one the model "saw". */
  async afterAction(s: Session, settleMs = 140): Promise<string> {
    await this.sleep(settleMs)
    const st = await this.input.state()
    s.seenFg = st.foreground?.hwnd ?? 0
    return st.foreground ? `Window in front: "${st.foreground.title}" (${st.foreground.exe}). Take a screenshot to see the result.` : 'No window is in front. Take a screenshot to see the result.'
  }

  /** A picture coordinate to the desktop, for the latest screenshot. */
  physical(s: Session, x: number, y: number): { x: number; y: number } {
    const v = this.needView(s)
    if (typeof x !== 'number' || typeof y !== 'number' || !Number.isFinite(x) || !Number.isFinite(y)) throw new UserError('"x" and "y" are required numbers (pixels of the latest screenshot).')
    if (x < 0 || y < 0 || x >= v.width || y >= v.height) throw new UserError(`(${x}, ${y}) is outside the latest screenshot (${v.width}x${v.height}). Coordinates are pixels of that image.`)
    return toPhysical(v, x, y)
  }

  setView(s: Session, v: View): void {
    s.view = v
    s.lastShotAt = Date.now()
    s.lookedSinceAct = true
  }

  ensureView(s: Session): View {
    if (s.view) return s.view
    const d = this.capturer.displays().find((x) => x.primary) ?? this.capturer.displays()[0]
    return viewOf(d)
  }

  // ------------------------------------------------------------------ MCP
  async handle(sid: string, msg: Record<string, unknown>): Promise<Record<string, unknown> | undefined> {
    const id = msg.id
    const method = String(msg.method || '')
    const reply = (result: unknown): Record<string, unknown> => ({ jsonrpc: '2.0', id, result })
    if (id === undefined || id === null) return undefined
    if (method === 'initialize') {
      const params = (msg.params || {}) as { protocolVersion?: string }
      return reply({ protocolVersion: params.protocolVersion || '2025-03-26', capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'jolty-computer', version: '1.0.0' } })
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

  /** One tool call at a time per chat. */
  call(sid: string, name: string, args: Record<string, unknown>): Promise<ToolResult> {
    const s = this.session(sid)
    const run = s.lock.then(() => this.run(s, name, args))
    s.lock = run.catch(() => undefined)
    return run
  }

  private async run(s: Session, name: string, args: Record<string, unknown>): Promise<ToolResult> {
    const def = TOOLS.find((t) => t.name === name)
    if (!def) return fail(`Unknown tool ${name}`)
    if (!this.host.enabled(s.sid) || this.killed.has(s.sid)) return fail('Computer control is off for this chat. Do not try again; tell the user.')
    try {
      return await Promise.race([
        def.run(this, s, args),
        this.sleep(110000).then(() => {
          throw new UserError(`${name} took more than 110 seconds`)
        })
      ])
    } catch (e) {
      if (e instanceof UserError) return fail(e.message)
      return fail(`${name} failed: ${e instanceof Error ? e.message : String(e)}`)
    }
  }
}
