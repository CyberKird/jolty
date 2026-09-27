import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron'
import path from 'path'
import type { ChatEvent } from '@shared/types'
import { Jolty } from './jolty'
import * as local from './local'
import * as store from './store'
import * as system from './system'

declare const __JOLTY_VERSION__: string

let win: BrowserWindow | undefined
let jolty: Jolty

function send(e: ChatEvent): void {
  if (win && !win.isDestroyed()) win.webContents.send('jolty:event', e)
}

function createWindow(): void {
  win = new BrowserWindow({
    width: 1320,
    height: 860,
    minWidth: 960,
    minHeight: 600,
    title: 'Jolty',
    backgroundColor: '#15161a',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })
  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })
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
  handle('sessions:history', (id: string) => jolty.history(id))
  handle('sessions:send', (id: string, text: string, attachments) => jolty.sendMessage(id, text, (attachments as never) || []))
  handle('sessions:interrupt', (id: string) => jolty.interrupt(id))
  handle('sessions:setModel', (id: string, model: string) => jolty.setModel(id, model))
  handle('sessions:setEffort', (id: string, effort: string) => jolty.setEffort(id, effort))
  handle('sessions:setPermissionMode', (id: string, mode) => jolty.setPermissionMode(id, mode as never))
  handle('sessions:respond', (id: string, requestId: string, decision) => jolty.respond(id, requestId, decision as never))
  handle('sessions:handoff', (id: string, target: string) => jolty.handoff(id, target))
  handle('sessions:remove', (id: string) => jolty.removeSession(id))

  handle('usage:summary', () => jolty.usageSummary())
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
  handle('app:openExternal', (url: string) => shell.openExternal(url))
  handle('app:openPath', async (p: string) => {
    await shell.openPath(p)
  })
  handle('app:version', () => __JOLTY_VERSION__)
}

app.whenReady().then(() => {
  jolty = new Jolty(send)
  registerIpc()
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

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
