// Automatic backup: every connected storage with "Update automatically" on gets a run some time after the data
// folder changes. Never on every keystroke: a run waits until changes pause for a while (or have gone on for a
// long time), at most one every MIN_GAP (longer on battery), not while offline, one storage at a time, and a run
// with nothing changed sends nothing. A failure waits longer each time (up to an hour). A run is also tried at
// start and on quit (bounded in time).
import fs from 'fs'
// a namespace import: the test stub of electron has neither, and both are read inside try
import * as electron from 'electron'
import { dataDir, loadBackupAccounts } from '../store'
import { getSecret } from '../store'
import { passKey } from './common'
import { PROVIDERS } from './providers'
import { restoreProgress, runVault } from './vault-ops'

const MIN = 60_000
export const AUTO = {
  /** at most one run per storage this often while things change */
  gap: 10 * MIN,
  /** on battery */
  batteryGap: 60 * MIN,
  /** changes have paused this long: a good moment */
  quiet: 2 * MIN,
  /** changes keep coming: run anyway once they have gone on this long */
  longest: 15 * MIN,
  /** first check after the app starts */
  startDelay: 2 * MIN,
  tick: MIN,
  maxBackoff: 60 * MIN,
  quitBudget: 20_000
}

/** Paths in the data folder whose change is worth a backup (see vault-scope.ts); everything else (caches) is noise. */
const WATCHED = /^(settings\.json|profiles\.json|sessions\.json|schedules\.json|use-time\.json|usage\.jsonl|skill-sources\.json|skill-status\.json|(transcripts|ledgers|references|trash|profiles)[\\/])/

interface State {
  lastRunAt: number
  fails: number
  nextAt: number
  kicked: boolean
}

const states = new Map<string, State>()
let firstChangeAt = 0
let lastChangeAt = 0
let lastBackedUpChange = -1
let timer: ReturnType<typeof setInterval> | undefined
let watcher: fs.FSWatcher | undefined
let onChange: () => void = () => undefined
let stopped = false

const stateOf = (id: string): State => {
  let s = states.get(id)
  if (!s) states.set(id, (s = { lastRunAt: 0, fails: 0, nextAt: 0, kicked: false }))
  return s
}

/** The storages automatic runs are for: connected, with a password here, and the switch on. */
export function candidates(): string[] {
  const all = loadBackupAccounts()
  return PROVIDERS.filter((p) => {
    const m = all[p.id]
    return m && m.autoUpdate !== false && !!getSecret(passKey(p.id, m.sub))
  }).map((p) => p.id)
}

export function markChanged(at = Date.now()): void {
  if (!firstChangeAt || firstChangeAt <= lastBackedUpChange) firstChangeAt = at
  lastChangeAt = at
}

/** Runs soon whatever the pause (a storage just connected, its password just chosen). */
export function kick(id: string): void {
  // automatic runs are off in this process (tests): a run happens only when asked
  if (!timer) return
  const s = stateOf(id)
  s.kicked = true
  s.nextAt = 0
  setTimeout(() => void tick(), 1500)
}

function online(): boolean {
  try {
    return electron.net.isOnline()
  } catch {
    return true
  }
}

function onBattery(): boolean {
  try {
    return electron.powerMonitor.isOnBatteryPower()
  } catch {
    return false
  }
}

/** Whether storage `id` should run now. Exported for the tests. */
export function due(s: State, now: number, battery: boolean): boolean {
  if (s.kicked) return true
  if (now < s.nextAt) return false
  if (lastChangeAt <= s.lastRunAt) return false
  if (now - s.lastRunAt < (battery ? AUTO.batteryGap : AUTO.gap)) return false
  return now - lastChangeAt >= AUTO.quiet || now - firstChangeAt >= AUTO.longest
}

let ticking = false
export async function tick(signal?: AbortSignal): Promise<void> {
  if (ticking || stopped) return
  ticking = true
  try {
    // a restore waits for the restart: this PC's state before it must not become the newest version
    if (!online() || restoreProgress()?.phase === 'ready') return
    const now = Date.now()
    for (const id of candidates()) {
      const s = stateOf(id)
      if (!due(s, now, onBattery())) continue
      const seen = lastChangeAt
      s.kicked = false
      try {
        await runVault(id, true, signal)
        s.lastRunAt = Date.now()
        s.fails = 0
        s.nextAt = 0
        lastBackedUpChange = seen
      } catch {
        s.fails++
        s.nextAt = Date.now() + Math.min(AUTO.maxBackoff, MIN * 2 ** Math.min(s.fails, 6))
      }
      onChange()
      if (signal?.aborted) return
    }
  } finally {
    ticking = false
  }
}

/** Starts watching and the timer; `changed` tells the page to redraw the backup status. */
export function startAuto(changed: () => void): void {
  onChange = changed
  try {
    watcher = fs.watch(dataDir(), { recursive: true }, (_e, file) => {
      if (file && WATCHED.test(String(file))) markChanged()
    })
    watcher.on('error', () => undefined)
  } catch {
    // no recursive watch here: the start and quit runs still happen, and changes are found by size and time
  }
  // whatever changed while Jolty was closed is picked up by the first run
  markChanged(Date.now() - AUTO.longest)
  setTimeout(() => {
    for (const id of candidates()) stateOf(id).kicked = true
    void tick()
  }, AUTO.startDelay)
  timer = setInterval(() => void tick(), AUTO.tick)
}

/** On quit: one last run for what changed since the last one, cut off after quitBudget. */
export async function finalRun(): Promise<void> {
  stopped = true
  if (timer) clearInterval(timer)
  watcher?.close()
  if (lastChangeAt <= lastBackedUpChange || !candidates().length) return
  const ctl = new AbortController()
  const cut = setTimeout(() => ctl.abort(), AUTO.quitBudget)
  stopped = false
  for (const id of candidates()) stateOf(id).kicked = true
  try {
    await tick(ctl.signal)
  } finally {
    stopped = true
    clearTimeout(cut)
  }
}
