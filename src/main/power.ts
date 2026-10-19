// "Turn the PC off when the work is done", with the actions and timers of ShutdownTimer: armed from the
// composer with a plan (shutdown, restart, sleep, hibernate, log off or lock; once the work is done, after
// some minutes or at a time of day). "Done" waits until Jolty has seen work, then until every chat has been
// quiet for a while (or an account ran out of usage); a timer just waits for its time. Then comes a
// countdown the user can cancel. For shutdown and restart on Windows the countdown is Windows' own timer,
// so it also runs if Jolty itself dies; the app only shows it and cancels it with `shutdown /a`.
// While armed the PC is also kept from going to sleep, or the work would stop half way through the night.
import { execFile } from 'child_process'
import os from 'os'
import type { ChatEvent, PowerAction, PowerPlan, PowerState, RateLimitSnapshot } from '@shared/types'
import { tr } from '@shared/i18n'
import { ACTION_WHAT, DEFAULT_PLAN, DESTRUCTIVE, dueAt, sanitizePlan } from '@shared/power'

export const GRACE_MS = 30_000
export const COUNTDOWN_S = 60
/** the warning before a harmless action (sleep, hibernate, lock) */
const SHORT_COUNTDOWN_S = 15

type Reason = NonNullable<PowerState['reason']>

export interface PowerHost {
  emit(e: ChatEvent): void
  /** how many chats are working right now */
  busy(): number
  /** a system notice (the user may be away from the window) */
  notify(title: string, body: string): void
  /**
   * Does `action` after `seconds`; returns a function that cancels it. `fired` runs once Jolty itself carried
   * the action out (sleep, lock…; Windows' own timer does shutdown and restart), with the error if it failed.
   */
  shutdown(seconds: number, message: string, action: PowerAction, force: boolean, fired: (error?: string) => void): () => void
  /** keeps the machine from going to sleep while on */
  keepAwake(on: boolean): void
}

const USAGE_ERROR = /rate.?limit|usage limit|limit reached|quota|limite|too many requests|429|out of (usage|credits)/i

export class PowerGuard {
  armed = false
  private plan: PowerPlan = DEFAULT_PLAN
  private due?: number
  private dueTimer?: NodeJS.Timeout
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

  /** `plan` says what happens and when (it comes over IPC, so it is checked here); without one the last plan stays. */
  arm(on: boolean, plan?: unknown): void {
    if (on === this.armed && !this.counting && plan === undefined) return
    this.cancelCountdown()
    clearTimeout(this.idleTimer)
    clearTimeout(this.dueTimer)
    if (plan !== undefined) this.plan = sanitizePlan(plan)
    this.armed = on
    this.due = undefined
    this.host.keepAwake(on)
    // armed while a chat is already working (the usual way: start the long task, then arm and go to bed):
    // that chat's "running" came before the arm, so count it as seen or its end never starts the countdown
    this.seenWork = on && this.host.busy() > 0
    this.usageHit = false
    this.lastError = ''
    const when = this.plan.when
    if (on && when.kind !== 'done') {
      this.due = dueAt(when, Date.now())
      this.dueTimer = setTimeout(() => this.begin('timer'), this.due - Date.now())
    }
    this.emitState()
  }

  /** Cancel from the banner: stops a running countdown and disarms. */
  cancel(): void {
    this.arm(false)
  }

  state(): PowerState {
    return {
      armed: this.armed,
      plan: this.plan,
      ...(this.armed && this.due ? { due: this.due } : {}),
      ...(this.counting ? { seconds: this.counting.left, reason: this.counting.reason } : {})
    }
  }

  /** From the engines' status events. */
  onStatus(status: 'idle' | 'running' | 'error', error?: string): void {
    if (!this.watching()) return
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
    if (!this.watching()) return
    if (s.windows.some((w) => w.usedPercent >= 99)) {
      this.usageHit = true
      this.check()
    }
  }

  /** Only a "when the work is done" plan follows the chats; a timer fires at its time whatever they do. */
  private watching(): boolean {
    return this.armed && this.plan.when.kind === 'done'
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
    if (this.counting) return
    const { action, force } = this.plan
    const why = reasonText(reason)
    const what = ACTION_WHAT[action]()
    const seconds = DESTRUCTIVE.includes(action) ? this.countdown : Math.min(SHORT_COUNTDOWN_S, this.countdown)
    const cancel = this.host.shutdown(seconds, tr("{what} în {s} s: {why}", { what, s: seconds, why }), action, force, (error) => {
      // Jolty did it itself (sleep, lock…): the plan is spent, and the PC may sleep again
      if (error) this.host.notify(tr("Acțiunea nu a reușit"), error)
      this.arm(false)
    })
    const timer = setInterval(() => {
      if (!this.counting) return
      this.counting.left = Math.max(0, this.counting.left - 1)
      this.emitState()
      if (!this.counting.left) clearInterval(timer)
    }, 1000)
    this.counting = { left: seconds, timer, cancel, reason }
    this.host.notify(tr("{what} în {s} secunde", { what, s: seconds }), why)
    this.emitState()
  }

  private cancelCountdown(): void {
    if (!this.counting) return
    clearInterval(this.counting.timer)
    this.counting.cancel()
    this.counting = undefined
  }

  private emitState(): void {
    this.host.emit({ type: 'power', ...this.state() })
  }
}

export function reasonText(reason: Reason): string {
  return reason === 'usage'
    ? tr("a rămas fără usage")
    : reason === 'error'
      ? tr("lucrul s-a oprit cu o eroare")
      : reason === 'timer'
        ? tr("timerul a expirat")
        : tr("lucrul s-a terminat")
}

/** What Jolty runs itself for each action (Windows has no timer for these): [command, ...args]. */
function command(action: PowerAction, force: boolean): string[] {
  const f = force ? ['/f'] : []
  if (process.platform === 'win32') {
    return {
      shutdown: ['shutdown.exe', '/s', ...f, '/t', '0'],
      restart: ['shutdown.exe', '/r', ...f, '/t', '0'],
      // the same call ShutdownTimer makes; rundll32 powrprof would hibernate instead when hibernation is on
      sleep: ['powershell.exe', '-NoProfile', '-NonInteractive', '-Command', "Add-Type -AssemblyName System.Windows.Forms; [void][System.Windows.Forms.Application]::SetSuspendState('Suspend', $false, $false)"],
      hibernate: ['shutdown.exe', '/h'],
      logoff: ['shutdown.exe', '/l', ...f],
      lock: ['rundll32.exe', 'user32.dll,LockWorkStation']
    }[action]
  }
  if (process.platform === 'darwin') {
    const ev = (e: string): string[] => ['osascript', '-e', `tell application "System Events" to ${e}`]
    return { shutdown: ev('shut down'), restart: ev('restart'), sleep: ['pmset', 'sleepnow'], hibernate: ['pmset', 'sleepnow'], logoff: ev('log out'), lock: ['pmset', 'displaysleepnow'] }[action]
  }
  return {
    shutdown: ['systemctl', 'poweroff'],
    restart: ['systemctl', 'reboot'],
    sleep: ['systemctl', 'suspend'],
    hibernate: ['systemctl', 'hibernate'],
    logoff: ['loginctl', 'terminate-user', os.userInfo().username],
    lock: ['loginctl', 'lock-session']
  }[action]
}

/** The real thing for this machine; returns the function that cancels it. */
export function systemShutdown(seconds: number, message: string, action: PowerAction, force: boolean, fired: (error?: string) => void): () => void {
  if (process.platform === 'win32' && (action === 'shutdown' || action === 'restart')) {
    // Windows keeps the timer itself. /f closes programs that would otherwise hold the shutdown back all night
    execFile('shutdown.exe', [action === 'shutdown' ? '/s' : '/r', ...(force ? ['/f'] : []), '/t', String(seconds), '/c', message], { windowsHide: true }, () => undefined)
    return () => execFile('shutdown.exe', ['/a'], { windowsHide: true }, () => undefined)
  }
  const timer = setTimeout(() => {
    const [cmd, ...args] = command(action, force)
    execFile(cmd, args, { windowsHide: true }, (err) => fired(err ? (err.message || String(err)).split('\n')[0] : undefined))
  }, seconds * 1000)
  return () => clearTimeout(timer)
}
