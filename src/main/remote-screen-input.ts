// The phone's touches as mouse and keyboard on the PC, through the same native helper that computer use drives.
// Input never waits behind pictures: it comes in on its own messages and goes straight to the helper, in order, with
// pointer moves merged (only the newest waits its turn). A button held by a phone whose link went quiet is let go.
import type { DisplayInfo } from './computer/geometry'
import { parseCombo, type Ev } from './computer/plan'
import type { ScreenInput } from './remote-screen'

const BUTTONS = new Set(['l', 'r', 'm'])
/** a button held this long with no word from the phone is let go: its link is gone or stuck */
export const HELD_TIMEOUT = 8000

const num = (v: unknown, lo: number, hi: number): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : undefined)

export class ScreenInputs {
  private chain: Promise<unknown> = Promise.resolve()
  private pendingMove?: { x: number; y: number }
  /** the PC's input was used: only then is there anything to let go of */
  private touched = false
  private held = new Set<'l' | 'r' | 'm'>()
  private lastWord = 0
  private watchdog?: NodeJS.Timeout

  constructor(private input: () => Promise<ScreenInput>) {}

  private point(d: DisplayInfo | undefined, m: Record<string, unknown>): { x: number; y: number } | undefined {
    const nx = num(m.x, 0, 1)
    const ny = num(m.y, 0, 1)
    if (!d || nx === undefined || ny === undefined) return undefined
    return { x: Math.round(d.x + nx * (d.w - 1)), y: Math.round(d.y + ny * (d.h - 1)) }
  }

  private play(events: Ev[]): void {
    this.chain = this.chain.then(async () => (await this.input()).play(events)).catch(() => undefined)
  }

  /** One input message from a phone looking at display `d`. */
  act(d: DisplayInfo | undefined, m: Record<string, unknown>): void {
    const op = m.op
    this.touched = true
    this.lastWord = Date.now()
    const button = typeof m.button === 'string' && BUTTONS.has(m.button) ? (m.button as 'l' | 'r' | 'm') : 'l'
    switch (op) {
      case 'move': {
        const p = this.point(d, m)
        if (!p) return
        // moves arrive faster than the helper takes them: only the newest one waits its turn
        const queued = this.pendingMove
        this.pendingMove = p
        if (queued) return
        this.chain = this.chain
          .then(async () => {
            const at = this.pendingMove
            this.pendingMove = undefined
            if (at) await (await this.input()).play([['m', 0, at.x, at.y]])
          })
          .catch(() => undefined)
        return
      }
      case 'down':
      case 'up': {
        const p = this.point(d, m)
        if (op === 'down') this.held.add(button)
        else this.held.delete(button)
        this.guard()
        this.play([...(p ? ([['m', 0, p.x, p.y]] as Ev[]) : []), ['b', p ? 6 : 0, button, op === 'down' ? 1 : 0]])
        return
      }
      case 'click': {
        const p = this.point(d, m)
        const count = Math.min(3, Math.max(1, Math.round(num(m.count, 1, 3) ?? 1)))
        const evs: Ev[] = p ? [['m', 0, p.x, p.y]] : []
        let t = p ? 8 : 0
        for (let i = 0; i < count; i++) {
          evs.push(['b', t, button, 1], ['b', t + 28, button, 0])
          t += 90
        }
        this.play(evs)
        return
      }
      case 'wheel': {
        const n = Math.round(num(m.notches, -40, 40) ?? 0)
        if (!n) return
        const evs: Ev[] = []
        for (let i = 0; i < Math.abs(n); i++) evs.push(['w', i * 6, n < 0 ? 120 : -120, m.horizontal === true ? 1 : 0])
        this.play(evs)
        return
      }
      case 'text': {
        const text = typeof m.text === 'string' ? m.text.slice(0, 2000) : ''
        if (!text) return
        const evs: Ev[] = []
        let t = 0
        for (const ch of text) {
          if (ch === '\n') evs.push(['k', t, 0x0d, 1, 0], ['k', t + 8, 0x0d, 0, 0])
          else if (ch === '\t') evs.push(['k', t, 0x09, 1, 0], ['k', t + 8, 0x09, 0, 0])
          else evs.push(['c', t, ch.codePointAt(0) as number, 8])
          t += 14
        }
        this.play(evs)
        return
      }
      case 'key': {
        let vks: number[]
        try {
          vks = parseCombo(typeof m.combo === 'string' ? m.combo : '')
        } catch {
          return
        }
        this.keys(vks)
        return
      }
    }
  }

  /** Any message from the phone (acks too) shows its link is alive. */
  alive(): void {
    this.lastWord = Date.now()
  }

  private keys(vks: number[]): void {
    const mods = new Set([0x10, 0x11, 0x12, 0x5b])
    const ext = new Set([0x21, 0x22, 0x23, 0x24, 0x25, 0x26, 0x27, 0x28, 0x2c, 0x2d, 0x2e, 0x5b, 0x5d, 0x90])
    const evs: Ev[] = []
    let t = 0
    for (const k of vks.filter((x) => mods.has(x))) (evs.push(['k', t, k, 1, ext.has(k) ? 1 : 0]), (t += 8))
    for (const k of vks.filter((x) => !mods.has(x))) (evs.push(['k', t, k, 1, ext.has(k) ? 1 : 0], ['k', t + 14, k, 0, ext.has(k) ? 1 : 0]), (t += 28))
    for (const k of vks.filter((x) => mods.has(x)).reverse()) (evs.push(['k', t, k, 0, ext.has(k) ? 1 : 0]), (t += 8))
    this.play(evs)
  }

  /** While a button is held, a quiet link lets it go. */
  private guard(): void {
    if (!this.held.size) {
      if (this.watchdog) clearInterval(this.watchdog)
      this.watchdog = undefined
      return
    }
    this.watchdog ??= setInterval(() => {
      if (this.held.size && Date.now() - this.lastWord > HELD_TIMEOUT) this.letGo()
    }, 1000)
  }

  private letGo(): void {
    const evs: Ev[] = [...this.held].map((b) => ['b', 0, b, 0] as Ev)
    this.held.clear()
    this.guard()
    this.play(evs)
  }

  /** Buttons held down by a phone that vanished must not stay down on the PC. */
  release(): void {
    this.held.clear()
    this.guard()
    if (!this.touched) return
    this.touched = false
    this.pendingMove = undefined
    this.play([['b', 0, 'l', 0], ['b', 0, 'r', 0], ['b', 0, 'm', 0], ...[0x11, 0x10, 0x12, 0x5b].map((k) => ['k', 0, k, 0, k === 0x5b ? 1 : 0] as Ev)])
  }
}
