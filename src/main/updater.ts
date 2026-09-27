// Updates like the Claude and Codex desktop apps: checked on start and every few hours, downloaded
// in the background, then "restart to update" in the title bar plus a Windows notification.
// Anything left pending installs when the app quits.
//
// Releases live in the private repo, so nobody else can download them. The app carries no credential:
// on each check it borrows the GitHub CLI login already on this PC (`gh auth token`), keeps it in
// memory only and sends it only to GitHub over https. electron-updater checks the SHA-512 in latest.yml.
import { execFile } from 'child_process'
import { app, Notification } from 'electron'
import electronUpdater from 'electron-updater'
import type { UpdateStatus } from '@shared/types'

const { autoUpdater } = electronUpdater

const EVERY = 4 * 3600e3
const OWNER = 'CyberKird'
const REPO = 'jolty'

/** The local GitHub CLI token, or undefined when gh is missing or logged out. Never stored or logged. */
function ghToken(): Promise<string | undefined> {
  return new Promise((resolve) =>
    execFile('gh', ['auth', 'token', '--hostname', 'github.com'], { timeout: 8000, windowsHide: true }, (err, out) => {
      const t = String(out || '').trim()
      resolve(!err && /^[A-Za-z0-9_]{20,255}$/.test(t) ? t : undefined)
    })
  )
}

/** Error text shown in the app, with any token-looking string removed. */
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
  // no updater log: nothing about the feed (or its credential) is written anywhere
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
}

/** Development builds have no release to compare against, so they only say so. */
export async function check(): Promise<UpdateStatus> {
  if (!app.isPackaged) {
    set({ state: 'dev' })
    return status
  }
  if (status.state === 'downloading' || status.state === 'ready') return status
  const token = await ghToken()
  if (!token) {
    set({ state: 'error', error: 'Actualizările vin din repo-ul privat: conectează-te o dată cu GitHub CLI (gh auth login).', checkedAt: Date.now() })
    return status
  }
  try {
    autoUpdater.setFeedURL({ provider: 'github', owner: OWNER, repo: REPO, private: true, token, releaseType: 'release' })
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
