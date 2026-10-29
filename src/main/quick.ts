// Quick entry, like Claude Desktop's: a global shortcut opens a small box over whatever the user is doing,
// Enter starts a new chat (in the main window, or in the background with a notification), Esc closes it.
// Works while the main window is hidden in the tray. The PC-control kill key (computer/native.ts) is left alone.
import { BrowserWindow, globalShortcut, ipcMain, Notification, screen, type IpcMainInvokeEvent } from 'electron'
import fs from 'fs'
import path from 'path'
import type { BackgroundState, SessionMeta } from '@shared/types'
import { parseHotkey, quickKeyOf } from '@shared/background'
import { tr } from '@shared/i18n'
import * as store from './store'

export interface QuickHost {
  start(input: { profileId: string; cwd: string; text: string }): Promise<SessionMeta>
  reveal(): void
  focus(sessionId?: string): void
  isMain(e: IpcMainInvokeEvent): boolean
  state(): BackgroundState
}

const WIDTH = 640
const HEIGHT = 200
let host: QuickHost
let win: BrowserWindow | undefined
let registered = ''
let busy = false

const HOTKEY_ERRORS: Record<string, () => string> = {
  'two-keys': () => tr("Scurtătura are o singură tastă pe lângă Ctrl, Alt, Shift sau Win."),
  'unknown-key': () => tr("Tasta aceasta nu poate fi folosită într-o scurtătură."),
  'no-key': () => tr("Scurtătura are nevoie de o tastă pe lângă Ctrl, Alt, Shift sau Win."),
  'no-modifier': () => tr("Scurtătura are nevoie de Ctrl, Alt sau Win, altfel ar prinde tastele obișnuite."),
  reserved: () => tr("Combinația e deja a lui Windows sau a lui Jolty (Ctrl+Alt+Esc oprește controlul PC-ului).")
}

function create(): BrowserWindow {
  const w = new BrowserWindow({
    width: WIDTH,
    height: HEIGHT,
    show: false,
    frame: false,
    transparent: true,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    title: tr("Jolty: intrare rapidă"),
    backgroundColor: '#00000000',
    webPreferences: { preload: path.join(__dirname, '../preload/index.js'), contextIsolation: true, nodeIntegration: false, sandbox: true }
  })
  // above full-screen windows too, like the Windows search box
  w.setAlwaysOnTop(true, 'pop-up-menu')
  w.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  w.webContents.on('will-navigate', (e) => e.preventDefault())
  // the page's <title> would rename it "Jolty", like the main window
  w.on('page-title-updated', (e) => e.preventDefault())
  // clicking anywhere else puts it away, like Claude's quick entry
  w.on('blur', () => w.hide())
  w.on('closed', () => (win = undefined))
  if (process.env.ELECTRON_RENDERER_URL) void w.loadURL(`${process.env.ELECTRON_RENDERER_URL}#quick`)
  else void w.loadFile(path.join(__dirname, '../renderer/index.html'), { hash: 'quick' })
  return w
}

/** Shows the box on the display the mouse is on, a third of the way down, and focuses it. */
export function open(): void {
  win ??= create()
  const area = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea
  win.setBounds({ x: Math.round(area.x + (area.width - WIDTH) / 2), y: Math.round(area.y + area.height * 0.28), width: WIDTH, height: HEIGHT })
  const w = win
  const show = (): void => {
    w.show()
    w.focus()
    w.webContents.send('quick:shown')
  }
  if (w.webContents.isLoading()) w.webContents.once('did-finish-load', show)
  else show()
}

const toggle = (): void => (win?.isVisible() ? win.hide() : open())

/** Registers the saved shortcut; false when another program already holds it. */
function register(key: string): boolean {
  if (registered) globalShortcut.unregister(registered)
  registered = ''
  if (!key) return true
  try {
    if (!globalShortcut.register(key, toggle)) return false
  } catch {
    return false
  }
  registered = key
  return true
}

export const keyBusy = (): boolean => busy

export function init(h: QuickHost): void {
  host = h
  busy = !register(quickKeyOf(store.loadSettings()))
  const fromQuick = (e: IpcMainInvokeEvent): boolean => Boolean(win && !win.isDestroyed() && e.sender === win.webContents)

  ipcMain.handle('background:state', (e) => {
    if (!host.isMain(e) && !fromQuick(e)) throw new Error('not allowed')
    return host.state()
  })
  ipcMain.handle('background:setQuickKey', (e, input: unknown) => {
    if (!host.isMain(e)) throw new Error('not allowed')
    let key = ''
    if (typeof input === 'string' && input.trim()) {
      const parsed = parseHotkey(input)
      if ('error' in parsed) throw new Error(HOTKEY_ERRORS[parsed.error]())
      key = parsed.key
    }
    const previous = registered
    if (!register(key)) {
      // the old one keeps working: a taken combination never leaves the user without a shortcut
      register(previous)
      throw new Error(tr("{key} e folosită deja de alt program. Alege altă combinație.", { key }))
    }
    busy = false
    store.saveSettings({ quickKey: key })
    return host.state()
  })
  ipcMain.handle('quick:close', (e) => {
    if (fromQuick(e)) win?.hide()
  })
  ipcMain.handle('quick:submit', async (e, input: unknown) => {
    if (!fromQuick(e)) throw new Error('not allowed')
    const { text, profileId, cwd } = (input || {}) as Record<string, unknown>
    if (typeof text !== 'string' || !text.trim() || text.length > 100_000) throw new Error(tr("Scrie ce vrei să facă."))
    if (typeof profileId !== 'string' || !store.loadProfiles().some((p) => p.id === profileId)) throw new Error(tr("Profilul nu mai există."))
    if (typeof cwd !== 'string' || !fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) throw new Error(tr("Folderul proiectului nu există: {cwd}", { cwd: String(cwd) }))
    const meta = await host.start({ profileId, cwd, text })
    win?.hide()
    if ((store.loadSettings().quickOpens ?? 'window') === 'window') {
      host.reveal()
      host.focus(meta.id)
    } else if (Notification.isSupported()) {
      const n = new Notification({ title: tr("Jolty: conversație pornită"), body: text.trim().slice(0, 120), silent: true })
      n.on('click', () => {
        host.reveal()
        host.focus(meta.id)
      })
      n.show()
    }
  })
}

export function stop(): void {
  if (registered) globalShortcut.unregister(registered)
  registered = ''
  win?.destroy()
}
