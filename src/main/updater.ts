// Updates like the Claude and Codex desktop apps: checked on start, every hour and when the user
// comes back to Jolty, downloaded in the background, then "restart to update" in the title bar and
// above the composer, plus a Windows notification.
// Anything left pending installs when the app quits.
//
// Releases are public on GitHub, so the app reads them anonymously: no credential is stored or sent.
// electron-updater checks the SHA-512 in latest.yml.
import { app, Notification } from 'electron'
import electronUpdater from 'electron-updater'
import type { UpdateStatus } from '@shared/types'

const { autoUpdater } = electronUpdater

const EVERY = 3600e3
/** coming back to Jolty checks again, at most this often */
const ON_FOCUS = 30 * 60e3
let lastCheck = 0
/** Error text shown in the app, capped in length. */
function clean(msg?: string): string | undefined {
  return msg?.replace(/\b(gh[opsu]_|github_pat_)[A-Za-z0-9_]+/g, '[token]').slice(0, 300)
}

let emit: (s: UpdateStatus) => void = () => undefined
let focus: () => void = () => undefined
let status: UpdateStatus = { state: 'idle', current: app.getVersion() }

function set(next: Partial<UpdateStatus>): void {
  status = { ...status, ...next }
  emit(status)
}

export function current(): UpdateStatus {
  return status
}

export function init(onChange: (s: UpdateStatus) => void, onFocus: () => void): void {
  emit = onChange
  focus = onFocus
  // no updater log: nothing about the feed is written anywhere
  autoUpdater.logger = null
  autoUpdater.autoDownload = true
  autoUpdater.autoInstallOnAppQuit = true
  autoUpdater.on('checking-for-update', () => set({ state: 'checking', error: undefined }))
  autoUpdater.on('update-available', (i) => set({ state: 'downloading', version: i.version, percent: 0 }))
  autoUpdater.on('update-not-available', () => set({ state: 'latest', checkedAt: Date.now() }))
  autoUpdater.on('download-progress', (p) => set({ state: 'downloading', percent: Math.round(p.percent) }))
  autoUpdater.on('update-downloaded', (i) => {
    set({ state: 'ready', version: i.version, percent: 100, checkedAt: Date.now() })
    if (Notification.isSupported()) {
      const n = new Notification({ title: `Jolty ${i.version} e gata`, body: 'Repornește ca să actualizezi. Altfel se instalează când închizi aplicația.' })
      n.on('click', () => focus())
      n.show()
    }
  })
  autoUpdater.on('error', (err) => set({ state: 'error', error: clean(err?.message) || 'verificarea a eșuat', checkedAt: Date.now() }))
  if (!app.isPackaged || process.env.JOLTY_TEST) return
  setTimeout(() => void check(), 15000)
  setInterval(() => void check(), EVERY)
  app.on('browser-window-focus', () => {
    if (Date.now() - lastCheck > ON_FOCUS) void check()
  })
}

/** Development builds have no release to compare against, so they only say so. */
export async function check(): Promise<UpdateStatus> {
  if (!app.isPackaged) {
    set({ state: 'dev' })
    return status
  }
  if (status.state === 'downloading' || status.state === 'ready') return status
  lastCheck = Date.now()
  try {
    await autoUpdater.checkForUpdates()
  } catch (err) {
    set({ state: 'error', error: clean(err instanceof Error ? err.message : String(err)), checkedAt: Date.now() })
  }
  return status
}

/** Silent install and relaunch: the per-user installer needs no questions or elevation. */
export function install(): void {
  if (status.state === 'ready') autoUpdater.quitAndInstall(true, true)
}
