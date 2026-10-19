// Updates like the Claude and Codex desktop apps: checked on start, every hour and when the user
// comes back to Jolty, downloaded in the background, then "restart to update" in the title bar and
// above the composer, plus a Windows notification.
// Anything left pending installs when the app quits. Checks go on after a download, and the restart
// button checks once more, so a release that came out in the meantime is installed in the same restart
// instead of one update after another.
//
// Releases are public on GitHub, so the app reads them anonymously: no credential is stored or sent.
// electron-updater checks the SHA-512 in latest.yml.
import { app, Notification } from 'electron'
import electronUpdater from 'electron-updater'
import type { UpdateStatus } from '@shared/types'
import { tr } from '@shared/i18n'

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
/** version already downloaded and waiting for a restart */
let downloaded: string | undefined
/** the restart button was pressed: no "ready" notification for a version fetched on the way out */
let installing = false

function set(next: Partial<UpdateStatus>): void {
  status = { ...status, ...next }
  emit(status)
}

/** A failed check or download never hides an update that is already downloaded. */
function fail(error?: string): void {
  if (downloaded) set({ state: 'ready', version: downloaded, percent: 100 })
  else set({ state: 'error', error: clean(error) || tr("verificarea a eșuat"), checkedAt: Date.now() })
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
  // while an update waits, a new check keeps the restart button; only a newer release starts a download
  autoUpdater.on('checking-for-update', () => !downloaded && set({ state: 'checking', error: undefined }))
  autoUpdater.on('update-available', (i) => i.version !== downloaded && set({ state: 'downloading', version: i.version, percent: 0 }))
  autoUpdater.on('update-not-available', () => !downloaded && set({ state: 'latest', checkedAt: Date.now() }))
  autoUpdater.on('download-progress', (p) => set({ state: 'downloading', percent: Math.round(p.percent) }))
  autoUpdater.on('update-downloaded', (i) => {
    const fresh = i.version !== downloaded
    downloaded = i.version
    set({ state: 'ready', version: i.version, percent: 100, checkedAt: Date.now() })
    if (fresh && !installing && Notification.isSupported()) {
      const n = new Notification({ title: tr("Jolty {version} e gata", { version: i.version }), body: tr("Repornește ca să actualizezi. Altfel se instalează când închizi aplicația.") })
      n.on('click', () => focus())
      n.show()
    }
  })
  autoUpdater.on('error', (err) => fail(err?.message))
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
  if (status.state === 'downloading') return status
  lastCheck = Date.now()
  try {
    await autoUpdater.checkForUpdates()
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err))
  }
  return status
}

/**
 * Silent install and relaunch: the per-user installer needs no questions or elevation.
 * One last check first: a release newer than the downloaded one is fetched and installed instead.
 */
export async function install(): Promise<void> {
  if (status.state !== 'ready') return
  installing = true
  try {
    const r = await autoUpdater.checkForUpdates()
    // the same version resolves at once from the download cache
    if (r?.isUpdateAvailable) await r.downloadPromise
  } catch {
    // offline or GitHub unreachable: install what is already downloaded
  }
  if (downloaded) autoUpdater.quitAndInstall(true, true)
}
