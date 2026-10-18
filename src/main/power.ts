// "Turn the PC off when the work is done": armed from the composer, it waits until Jolty has seen work,
// then until every chat has been quiet for a while (or an account ran out of usage), and then starts a
// 60 second countdown the user can cancel. On Windows the countdown is Windows' own shutdown timer, so
// it also runs if Jolty itself dies; the app only shows it and cancels it with `shutdown /a`.
// While armed the PC is also kept from going to sleep, or the work would stop half way through the night.
import { execFile } from 'child_process'
import type { ChatEvent, RateLimitSnapshot } from '@shared/types'
import { tr } from '@shared/i18n'

export const GRACE_MS = 30_000
export const COUNTDOWN_S = 60

type Reason = 'done' | 'usage' | 'error'

export interface PowerHost {
  emit(e: ChatEvent): void
  /** how many chats are working right now */
  busy(): number
  /** a system notice (the user may be away from the window) */
  notify(title: string, body: string): void
  /** shuts the machine down after `seconds`; returns a function that cancels it */
  shutdown(seconds: number, message: string): () => void
  /** keeps the machine from going to sleep while on */
  keepAwake(on: boolean): void
}

const USAGE_ERROR = /rate.?limit|usage limit|limit reached|quota|limite|too many requests|429|out of (usage|credits)/i

export class PowerGuard {
  armed = false
  private seenWork = false
  private usageHit = false
  private idleTimer?: NodeJS.Timeout
  private counting?: { left: number; timer: NodeJS.Timeout; cancel: () => void; reason: Reason }
  private lastError = ''

  constructor(
    private host: PowerHost,
    private grace = GRACE_MS,
    private countdown = COUNTDOWN_S
  ) {}

  arm(on: boolean): void {
    if (on === this.armed && !this.counting) return
    this.cancelCountdown()
    clearTimeout(this.idleTimer)
    this.armed = on
    this.host.keepAwake(on)
    // armed while a chat is already working (the usual way: start the long task, then arm and go to bed):
    // that chat's "running" came before the arm, so count it as seen or its end never starts the countdown
    this.seenWork = on && this.host.busy() > 0
    this.usageHit = false
    this.lastError = ''
    this.emitState()
  }

  /** Cancel from the banner: stops a running countdown and disarms. */
  cancel(): void {
    this.arm(false)
  }

  state(): { armed: boolean; seconds?: number; reason?: Reason } {
    return { armed: this.armed, ...(this.counting ? { seconds: this.counting.left, reason: this.counting.reason } : {}) }
  }

  /** From the engines' status events. */
  onStatus(status: 'idle' | 'running' | 'error', error?: string): void {
    if (!this.armed) return
    if (status === 'running') {
      this.seenWork = true
      clearTimeout(this.idleTimer)
      // someone is working again (the user came back, or a queued message went out): the plan is off
      if (this.counting) this.arm(false)
      return
    }
    if (status === 'error') this.lastError = error || 'error'
    if (status === 'error' && error && USAGE_ERROR.test(error)) this.usageHit = true
    this.check()
  }

  /** From the usage meter: a window at its limit means the work cannot go on. */
  onLimits(s: RateLimitSnapshot): void {
    if (!this.armed) return
    if (s.windows.some((w) => w.usedPercent >= 99)) {
      this.usageHit = true
      this.check()
    }
  }

  private check(): void {
    if (!this.seenWork || this.counting || this.host.busy() > 0) return
    clearTimeout(this.idleTimer)
    // quiet for a while: a queued message or a follow-up turn would have started by now
    this.idleTimer = setTimeout(() => {
      if (!this.armed || this.host.busy() > 0) return
      this.begin(this.usageHit ? 'usage' : this.lastError ? 'error' : 'done')
    }, this.grace)
  }

  private begin(reason: Reason): void {
    const why = reasonText(reason)
    const cancel = this.host.shutdown(this.countdown, tr("Jolty oprește PC-ul: {why}", { why }))
    const timer = setInterval(() => {
      if (!this.counting) return
      this.counting.left = Math.max(0, this.counting.left - 1)
      this.emitState()
      if (!this.counting.left) clearInterval(timer)
    }, 1000)
    this.counting = { left: this.countdown, timer, cancel, reason }
    this.host.notify(tr("PC-ul se oprește în {s} secunde", { s: this.countdown }), why)
    this.emitState()
  }

  private cancelCountdown(): void {
    if (!this.counting) return
    clearInterval(this.counting.timer)
    this.counting.cancel()
    this.counting = undefined
  }

  private emitState(): void {
    const st = this.state()
    this.host.emit({ type: 'power', armed: st.armed, seconds: st.seconds, reason: st.reason })
  }
}

export function reasonText(reason: Reason): string {
  return reason === 'usage'
    ? tr("a rămas fără usage")
    : reason === 'error'
      ? tr("lucrul s-a oprit cu o eroare")
      : tr("lucrul s-a terminat")
}

/** The real thing for this machine; returns the function that cancels it. */
export function systemShutdown(seconds: number, message: string): () => void {
  if (process.platform === 'win32') {
    // Windows keeps the timer itself. /f closes programs that would otherwise hold the shutdown back all night
    execFile('shutdown.exe', ['/s', '/f', '/t', String(seconds), '/c', message], { windowsHide: true }, () => undefined)
    return () => execFile('shutdown.exe', ['/a'], { windowsHide: true }, () => undefined)
  }
  const timer = setTimeout(() => {
    if (process.platform === 'darwin') execFile('osascript', ['-e', 'tell application "System Events" to shut down'], () => undefined)
    else execFile('shutdown', ['-h', 'now'], () => undefined)
  }, seconds * 1000)
  return () => clearTimeout(timer)
}
