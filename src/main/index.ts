import { app, BrowserWindow, clipboard, ClipboardItem, dialog, ipcMain, Menu, nativeImage, Notification, shell, type MenuItemConstructorOptions } from 'electron'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { fileURLToPath } from 'url'
import type { ChatEvent, MenuTarget } from '@shared/types'
import { activeBrowser, BROWSER_EXTENSION_URL, BROWSER_TOKEN_KEY, browsers } from './browser'
import { projectFiles, slashItems } from './composer'
import { Jolty } from './jolty'
import * as updater from './updater'
import * as local from './local'
import * as store from './store'
import * as system from './system'

/** Links from chats and pages open in the browser only when they are plain web links. */
function openWeb(url: unknown): void {
  try {
    if (typeof url === 'string' && ['http:', 'https:'].includes(new URL(url).protocol)) void shell.openExternal(url)
  } catch {
    // not a valid URL: ignore
  }
}

/** A link target from chat text as a Windows path: file:// URLs and /E:/... forms included. */
function localPath(href: string): string {
  try {
    if (/^file:/i.test(href)) return fileURLToPath(href)
    href = decodeURI(href)
  } catch {
    // malformed URL or escape: use the text as written
  }
  return path.normalize(href.replace(/^\/(?=[a-z]:)/i, ''))
}

declare const __JOLTY_VERSION__: string

// dev and test runs get their own id: Windows otherwise ties the real Jolty taskbar group to node_modules electron.exe
const APP_ID = app.isPackaged ? 'com.joltarise.jolty' : 'com.joltarise.jolty.dev'
let win: BrowserWindow | undefined
let jolty: Jolty

function send(e: ChatEvent): void {
  if (!win || win.isDestroyed()) return
  win.webContents.send('jolty:event', e)
  // a finished turn while the user is elsewhere: a Windows notification that brings Jolty back
  if (e.type === 'status' && e.status !== 'running' && !win.isFocused() && Notification.isSupported() && !process.env.JOLTY_TEST) {
    const title = jolty.sessions().find((s) => s.id === e.sessionId)?.title || 'Conversație'
    const n = new Notification({ title: e.status === 'error' ? 'Jolty: s-a oprit cu o eroare' : 'Jolty: gata', body: title, silent: false })
    n.on('click', () => {
      win?.show()
      win?.focus()
    })
    n.show()
  }
}

function createWindow(): void {
  const icon = app.isPackaged
    ? path.join(process.resourcesPath, 'icon.ico')
    : path.join(__dirname, '../../build/icon.ico')
  win = new BrowserWindow({
    width: 1320,
    height: 860,
    minWidth: 960,
    minHeight: 600,
    title: 'Jolty',
    icon,
    backgroundColor: '#020204',
    autoHideMenuBar: true,
    show: false,
    // our own dark title bar with the native Windows caption buttons on top of it
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#060709', symbolColor: '#a3a3a3', height: 36 },
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })
  if (process.platform === 'win32' && app.isPackaged) {
    win.setAppDetails({ appId: APP_ID, appIconPath: icon, relaunchCommand: process.execPath, relaunchDisplayName: 'Jolty' })
  }
  win.webContents.setWindowOpenHandler(({ url }) => {
    openWeb(url)
    return { action: 'deny' }
  })
  // shown once the first frame is painted: no white flash, no half-drawn layout
  // automated screenshot runs (JOLTY_TEST=1) open without taking focus from whatever the user is doing
  win.once('ready-to-show', () => (process.env.JOLTY_TEST ? win?.showInactive() : win?.show()))
  if (process.env.ELECTRON_RENDERER_URL) void win.loadURL(process.env.ELECTRON_RENDERER_URL)
  else void win.loadFile(path.join(__dirname, '../renderer/index.html'))
}

/** Registers `channel` so the renderer gets the value, or the error message as a rejection. */
function handle<A extends unknown[], R>(channel: string, fn: (...args: A) => R | Promise<R>): void {
  ipcMain.handle(channel, async (_e, ...args) => fn(...(args as A)))
}

function registerIpc(): void {
  handle('profiles:list', () => jolty.profiles())
  handle('profiles:create', (input) => jolty.createProfile(input as never))
  handle('profiles:update', (id: string, patch) => jolty.updateProfile(id, patch as never))
  handle('profiles:remove', (id: string) => jolty.removeProfile(id))
  handle('profiles:status', (id: string) => jolty.status(id))
  handle('profiles:login', (id: string) => jolty.login(id))
  handle('profiles:logout', (id: string) => jolty.logout(id))
  handle('profiles:models', (id: string) => jolty.models(id))

  handle('sessions:list', () => jolty.sessions())
  handle('sessions:external', (profileId: string, cwd?: string) => jolty.externalSessions(profileId, cwd))
  handle('sessions:start', (input) => jolty.startSession(input as never))
  handle('sessions:history', (id: string) => jolty.loadHistory(id))
  handle('sessions:importAll', () => jolty.importAll())
  handle('sessions:send', (id: string, text: string, attachments) => jolty.sendMessage(id, text, (attachments as never) || []))
  handle('sessions:interrupt', (id: string) => jolty.interrupt(id))
  handle('sessions:setModel', (id: string, model: string) => jolty.setModel(id, model))
  handle('sessions:setEffort', (id: string, effort: string) => jolty.setEffort(id, effort))
  handle('sessions:setPermissionMode', (id: string, mode) => jolty.setPermissionMode(id, mode as never))
  handle('sessions:compact', (id: string) => jolty.compact(id))
  handle('sessions:rewind', (id: string, itemId: string, dryRun?: boolean) => jolty.rewind(id, String(itemId), dryRun === true))
  handle('sessions:setBrowser', (id: string, on: boolean) => jolty.setBrowser(id, on === true))
  handle('browser:hasToken', () => Boolean(store.getSecret(BROWSER_TOKEN_KEY)))
  handle('browser:info', () => browsers())
  handle('updates:status', () => updater.current())
  handle('updates:check', () => updater.check())
  handle('updates:install', () => updater.install())
  handle('composer:slash', (cwd?: string) => slashItems(typeof cwd === 'string' ? cwd : undefined))
  handle('composer:files', (cwd: string) => (typeof cwd === 'string' && fs.existsSync(cwd) ? projectFiles(cwd) : []))
  handle('browser:setToken', (token: string) => store.setSecret(BROWSER_TOKEN_KEY, typeof token === 'string' && token.trim() ? token.trim() : undefined))
  handle('browser:openExtensionPage', () => openWeb(BROWSER_EXTENSION_URL))
  handle('sessions:respond', (id: string, requestId: string, decision) => jolty.respond(id, requestId, decision as never))
  handle('sessions:handoff', (id: string, target: string, model?: string, effort?: string) =>
    jolty.handoff(id, target, typeof model === 'string' ? model : undefined, typeof effort === 'string' ? effort : undefined)
  )
  handle('sessions:remove', (id: string) => jolty.removeSession(id))

  handle('usage:summary', () => jolty.usageSummary())
  handle('usage:balance', (id: string) => jolty.balance(id))
  handle('usage:refreshLimits', (id: string) => jolty.refreshLimits(id))

  handle('local:hardware', () => local.hardware())
  handle('local:status', () => local.status())
  handle('local:catalog', () => local.catalog())
  handle('local:pull', (tag: string) => jolty.pullLocal(tag))
  handle('local:remove', (tag: string) => local.remove(tag))
  handle('local:createProfile', (tag: string) => jolty.createLocalProfile(tag))
  handle('local:installOllama', () => local.installOllama())

  handle('system:check', () => system.check())
  handle('system:fix', (id: string) => system.fix(id, (p) => shell.openPath(p)))

  handle('codexImport:detect', (id: string, cwd?: string) => jolty.codex.importDetect(jolty.profile(id), cwd))
  handle('codexImport:run', (id: string, cwd?: string, types?: string[]) => jolty.codex.importRun(jolty.profile(id), cwd, types))

  handle('app:settings', () => store.loadSettings())
  handle('app:saveSettings', (patch) => store.saveSettings(patch as never))
  handle('app:pickFolder', async () => {
    const r = await dialog.showOpenDialog(win!, { properties: ['openDirectory'] })
    return r.canceled ? undefined : r.filePaths[0]
  })
  handle('app:openExternal', (url: string) => openWeb(url))
  handle('app:openPath', async (p: string) => {
    await shell.openPath(p)
  })
  handle('app:revealPath', (p: string) => shell.showItemInFolder(localPath(p)))
  handle('app:contextMenu', (t: MenuTarget) => {
    const items: MenuItemConstructorOptions[] = []
    const href = typeof t?.href === 'string' ? t.href : ''
    const img = typeof t?.image === 'string' ? /^data:image\/(png|jpeg|gif|webp);base64,([A-Za-z0-9+/=]+)$/.exec(t.image) : null
    if (img) {
      const ext = img[1] === 'jpeg' ? 'jpg' : img[1]
      const bytes = Buffer.from(img[2], 'base64')
      const base = (path.parse(String(t.imageName || 'imagine')).name || 'imagine').replace(/[<>:"/\\|?*]/g, '_')
      items.push({ label: 'Copiază imaginea', click: () => void clipboard.write([new ClipboardItem({ 'image/png': new Blob([new Uint8Array(nativeImage.createFromBuffer(bytes).toPNG())],{ type: 'image/png' }) })]) })
      items.push({
        label: 'Salvează imaginea...',
        click: () => {
          if (!win) return
          void dialog.showSaveDialog(win, { defaultPath: `${base}.${ext}`, filters: [{ name: 'Imagine', extensions: [ext] }] }).then((r) => {
            if (!r.canceled && r.filePath) fs.writeFileSync(r.filePath, bytes)
          })
        }
      })
      items.push({
        label: 'Deschide imaginea',
        click: () => {
          const dir = path.join(os.tmpdir(), 'jolty-images')
          fs.mkdirSync(dir, { recursive: true })
          const file = path.join(dir, `${base}-${Date.now()}.${ext}`)
          fs.writeFileSync(file, bytes)
          void shell.openPath(file)
        }
      })
    } else if (/^https?:\/\//i.test(href)) {
      const b = activeBrowser()
      items.push({ label: b ? `Deschide în ${b.name}` : 'Deschide în browser', click: () => (b ? b.open(href) : openWeb(href)) })
      items.push({ label: 'Copiază linkul', click: () => clipboard.writeText(href) })
    } else if (href && !href.startsWith('#')) {
      const p = localPath(href)
      items.push({ label: 'Deschide', click: () => void shell.openPath(p) })
      items.push({ label: 'Arată în Explorer', click: () => shell.showItemInFolder(p) })
      items.push({ label: 'Copiază calea', click: () => clipboard.writeText(p) })
    }
    if (t?.selection) {
      if (items.length) items.push({ type: 'separator' })
      items.push({ label: 'Copiază selecția', click: () => clipboard.writeText(t.selection!) })
    }
    if (t?.text || t?.markdown) {
      if (items.length) items.push({ type: 'separator' })
      if (t.text) items.push({ label: 'Copiază mesajul', click: () => clipboard.writeText(t.text!) })
      if (t.markdown) items.push({ label: 'Copiază mesajul ca Markdown', click: () => clipboard.writeText(t.markdown!) })
    }
    if (items.length && win) Menu.buildFromTemplate(items).popup({ window: win })
  })
  handle('app:version', () => __JOLTY_VERSION__)
}

// One Jolty at a time: two instances would write the same profile and conversation files
if (!app.requestSingleInstanceLock()) {
  app.exit(0)
} else {
  app.setAppUserModelId(APP_ID)
  app.on('second-instance', () => {
    if (!win || win.isDestroyed()) return
    if (win.isMinimized()) win.restore()
    win.focus()
  })
  app.whenReady().then(() => {
    jolty = new Jolty(send)
    registerIpc()
    createWindow()
    updater.init(
      (status) => send({ type: 'update', status }),
      () => {
        win?.show()
        win?.focus()
      }
    )
    // model lists refreshed in the background, so a newly released model is announced without opening the picker
    const scanModels = (): void => {
      for (const p of jolty.profiles()) if (p.engine === 'claude' && p.auth === 'subscription') void jolty.models(p.id).catch(() => undefined)
    }
    if (!process.env.JOLTY_TEST) {
      setTimeout(scanModels, 30000)
      setInterval(scanModels, 4 * 3600e3)
    }
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })
}

let quitting = false
app.on('before-quit', (e) => {
  if (quitting || !jolty) return
  e.preventDefault()
  quitting = true
  void jolty.shutdown().finally(() => app.quit())
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
