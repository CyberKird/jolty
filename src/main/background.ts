// Jolty in the system tray, like Claude Desktop: closing the window only hides it, so chats, scheduled tasks
// and parallel sessions keep running; Quit in the tray (or the updater, or Windows shutting down) really quits.
import { app, BrowserWindow, Menu, Notification, Tray } from 'electron'
import type { AppSettings, BackgroundState, ChatEvent } from '@shared/types'
import { keepsRunning, quickKeyOf } from '@shared/background'
import { tr } from '@shared/i18n'
import * as store from './store'

export interface BackgroundHost {
  window(): BrowserWindow | undefined
  /** asks the main window to open a chat (none: a new conversation) */
  focus(sessionId?: string): void
  quickEntry(): void
  /** the quick entry shortcut works right now */
  quickKeyBusy(): boolean
}

const HIDDEN_ARG = '--hidden'
let host: BackgroundHost
let tray: Tray | undefined
let iconPath = ''
/** set once the app really quits: the window may close for good */
let closing = false
const running = new Set<string>()
const waiting = new Set<string>()

const installed = (): boolean => app.isPackaged && !process.env.JOLTY_TEST
export const keepRunning = (): boolean => keepsRunning(store.loadSettings(), installed())

export function state(): BackgroundState {
  const s = store.loadSettings()
  const login = app.isPackaged ? app.getLoginItemSettings({ args: [HIDDEN_ARG] }).openAtLogin : false
  return {
    keepInBackground: keepsRunning(s, installed()),
    startWithWindows: login,
    canStartWithWindows: app.isPackaged && process.platform !== 'linux',
    quickKey: quickKeyOf(s),
    quickKeyBusy: host?.quickKeyBusy() ?? false,
    quickOpens: s.quickOpens ?? 'window'
  }
}

/** The main window back in front, wherever it was (hidden in the tray, minimized, behind other windows). */
export function reveal(): void {
  const win = host.window()
  if (!win || win.isDestroyed()) return
  if (win.isMinimized()) win.restore()
  win.show()
  win.focus()
}

/** Started by Windows at login: stay in the tray. */
export const startHidden = (): boolean => process.argv.includes(HIDDEN_ARG) && keepRunning()

/** From here on windows close for real (Quit, the updater's restart, Windows logging off). */
export function letClose(): void {
  closing = true
}

export function attach(win: BrowserWindow): void {
  win.on('close', (e) => {
    if (closing || !keepRunning()) return
    e.preventDefault()
    win.hide()
    const s = store.loadSettings()
    if (s.backgroundNoticeShown || !Notification.isSupported()) return
    store.saveSettings({ backgroundNoticeShown: true })
    const n = new Notification({ title: tr("Jolty rulează în continuare"), body: tr("Conversațiile și sarcinile merg mai departe. Îl găsești în bara de sistem; Ieșire din meniul lui îl închide de tot."), silent: true })
    n.on('click', reveal)
    n.show()
  })
  // Windows shutting down or logging off: no hiding, or the session end would wait on Jolty
  win.on('session-end', letClose)
}

export function init(h: BackgroundHost, icon: string): void {
  host = h
  iconPath = icon
  refresh()
}

/** Settings changed: tray on or off, login item written. */
export function apply(patch: Partial<AppSettings>): void {
  if ('startWithWindows' in patch && app.isPackaged) {
    app.setLoginItemSettings({ openAtLogin: patch.startWithWindows === true, args: [HIDDEN_ARG] })
  }
  refresh()
}

/** Keeps the tray's count of working and waiting chats. */
export function track(e: ChatEvent): void {
  if (e.type === 'status') {
    if (e.status === 'running') running.add(e.sessionId)
    else {
      running.delete(e.sessionId)
      waiting.delete(e.sessionId)
    }
  } else if (e.type === 'permission') waiting.add(e.sessionId)
  else if (e.type === 'permissionResolved') waiting.delete(e.sessionId)
  else return
  refresh()
}

function activity(): string {
  if (!running.size && !waiting.size) return tr("Nicio conversație nu lucrează")
  const parts = [running.size && tr("{n} lucrează", { n: running.size }), waiting.size && tr("{n} așteaptă răspunsul tău", { n: waiting.size })]
  return parts.filter(Boolean).join(' · ')
}

/** The tray icon exists only while background mode is on: without it the app behaves like a plain window. */
function refresh(): void {
  if (!host) return
  if (!keepRunning()) {
    tray?.destroy()
    tray = undefined
    return
  }
  if (!tray) {
    tray = new Tray(iconPath)
    // left click opens Jolty, right click shows the menu (Windows convention)
    tray.on('click', reveal)
  }
  const key = quickKeyOf(store.loadSettings())
  tray.setToolTip(`Jolty · ${activity()}`)
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: tr("Deschide Jolty"), click: reveal },
      {
        label: tr("Conversație nouă"),
        click: () => {
          reveal()
          host.focus()
        }
      },
      { label: tr("Intrare rapidă"), accelerator: key || undefined, registerAccelerator: false, click: () => host.quickEntry() },
      { type: 'separator' },
      { label: activity(), enabled: false },
      { type: 'separator' },
      { label: tr("Ieșire din Jolty"), click: () => app.quit() }
    ])
  )
}

export function destroy(): void {
  tray?.destroy()
  tray = undefined
}
