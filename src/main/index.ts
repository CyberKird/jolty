// first: every module after this one builds its texts in the chosen language
import './lang'
import { app, BrowserWindow, clipboard, ClipboardItem, dialog, globalShortcut, ipcMain, nativeImage, Notification, session, shell } from 'electron'
import { execFile } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { fileURLToPath } from 'url'
import type { ChatEvent } from '@shared/types'
import { activeBrowser, BROWSER_EXTENSION_URL, BROWSER_TOKEN_KEY, browsers, cleanToken } from './browser'
import { BrowserLive } from './browser-live'
import { allowFraming, listening, Preview } from './preview'
import * as voice from './voice'
import { nativeBrowser } from './jbrowser/native'
import { nativeComputer } from './computer/native'
import { projectFiles, slashItems } from './composer'
import { Jolty } from './jolty'
import * as updater from './updater'
import * as local from './local'
import * as modelWatch from './model-watch'
import * as store from './store'
import { buildLibrary } from './library'
import * as skills from './skills'
import * as pack from './share-pack'
import * as system from './system'
import * as connect from './connect'
import * as backup from './backup'
import { sendBugReport } from './bug-report'
import * as useTime from './use-time'
import * as obsidian from './obsidian'
import * as gitMerge from './git-merge'
import * as background from './background'
import * as quick from './quick'
import { Remote } from './remote'
import { RemoteScreen } from './remote-screen'
import { nativeScreenInput, nativeScreenSource } from './remote-screen-native'
import { EncoderHost } from './remote-video'
import { userServerNames } from './mcp-share'
import * as github from './github'
import { getLang, setLang, tr } from '@shared/i18n'
import { openableUrl } from '@shared/links'

/** Links from chats and pages open in the browser only when they are plain web links. */
function openWeb(url: unknown): void {
  if (openableUrl(url)) void shell.openExternal(url as string)
}

const RUNNABLE = /\.(exe|com|bat|cmd|scr|msi|msp|ps1|psm1|vbs|vbe|js|jse|wsf|wsh|hta|cpl|reg|lnk|url|jar|dll|appref-ms)$/i

/** Opens a file or folder like a double click would, except programs and scripts: those are only shown in Explorer. */
async function openLocal(p: string): Promise<void> {
  try {
    if (!fs.statSync(p).isDirectory() && RUNNABLE.test(p.replace(/[. ]+$/, ''))) return shell.showItemInFolder(p)
  } catch {
    throw new Error(tr("Nu pot accesa fișierul sau folderul: {p}", { p }))
  }
  const error = await shell.openPath(p)
  if (error) throw new Error(error)
}

/** A link target from chat text as a Windows path: file:// URLs and /E:/... forms included. */
function localPath(href: string): string {
  try {
    if (/^file:/i.test(href)) href = fileURLToPath(href)
    else href = decodeURIComponent(href)
  } catch {
    // malformed URL or escape: use the text as written
  }
  const p = path.normalize(href.replace(/^\/(?=[a-z]:)/i, '').replace(/:\d+(?::\d+)?$/, ''))
  if (!path.isAbsolute(p) || p.replace(/^[a-z]:/i, '').includes(':')) throw new Error(tr("Cale locală invalidă"))
  return p
}

declare const __JOLTY_VERSION__: string

// dev and test runs get their own id: Windows otherwise ties the real Jolty taskbar group to node_modules electron.exe
const APP_ID = app.isPackaged ? 'com.joltarise.jolty' : 'com.joltarise.jolty.dev'
let win: BrowserWindow | undefined
let jolty: Jolty
const browserLive = new BrowserLive(send)
const preview = new Preview()
const remote = new Remote(() => win && !win.isDestroyed() && win.webContents.send('remote:changed'))
const screenVideo = new EncoderHost()
remote.useScreen(new RemoteScreen(nativeScreenSource, nativeScreenInput, () => store.loadSettings().remoteScreen === true, () => win && !win.isDestroyed() && win.webContents.send('remote:changed'), screenVideo))
nativeComputer.onKill(() => remote.stopScreen())

function send(e: ChatEvent): void {
  background.track(e)
  remote.broadcast('jolty:event', e)
  if (!win || win.isDestroyed()) return
  win.webContents.send('jolty:event', e)
  // while the user is elsewhere: a Windows notification that brings Jolty back (each kind has its own switch in Settings)
  // only these two can notify: every other event (each streamed chunk) skips the settings file read below
  if ((e.type !== 'status' || e.status === 'running') && e.type !== 'permission') return
  if (win.isFocused() || !Notification.isSupported() || process.env.JOLTY_TEST) return
  const st = store.loadSettings()
  let head: string | undefined
  if (e.type === 'status' && e.status !== 'running' && st.notifyDone !== false) head = e.status === 'error' ? tr("Jolty: s-a oprit cu o eroare") : tr("Jolty: gata")
  else if (e.type === 'permission' && st.notifyAttention !== false) head = e.request.plan ? tr("Jolty: planul așteaptă aprobarea ta") : tr("Jolty: are nevoie de acordul tău")
  if (!head || (e.type !== 'status' && e.type !== 'permission')) return
  const title = jolty.sessions().find((s) => s.id === e.sessionId)?.title || tr("Conversație")
  const n = new Notification({ title: head, body: title, silent: st.notifySound === false })
  n.on('click', background.reveal)
  n.show()
}

const icon = app.isPackaged ? path.join(process.resourcesPath, 'icon.ico') : path.join(__dirname, '../../build/icon.ico')

/**
 * Windows 11 22H2 and newer draw acrylic only while "Transparency effects" is on (Settings > Personalization > Colors); off, the system
 * paints a flat grey in its place, so the see-through window would only look washed out.
 */
function glassSupport(): Promise<'ok' | 'os' | 'effects-off'> {
  if (process.platform !== 'win32' || Number(os.release().split('.')[2]) < 22621) return Promise.resolve('os')
  const key = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize'
  return new Promise((resolve) =>
    execFile('reg', ['query', key, '/v', 'EnableTransparency'], { windowsHide: true, timeout: 5000 }, (err, out) => resolve(!err && /EnableTransparency\s+REG_DWORD\s+0x0\b/.test(out) ? 'effects-off' : 'ok'))
  )
}

/** Glass theme with see-through on: the system draws a blurred acrylic behind a transparent page. */
async function applyWindowGlass(): Promise<void> {
  if (!win || win.isDestroyed() || process.platform !== 'win32') return
  const s = store.loadSettings()
  const supported = (await glassSupport()) === 'ok'
  if (!win || win.isDestroyed()) return
  const frost = s.theme === 'frost'
  const clear = (s.theme === 'glass' || frost) && supported && (s.glassClear || 0) > 0
  win.setBackgroundMaterial(clear ? 'acrylic' : 'none')
  win.setBackgroundColor(clear ? '#00000000' : frost ? '#e6e9f1' : '#020204')
  // a glass theme draws its own bar: the caption buttons sit on it without a block of their own
  const glass = s.theme === 'glass' || frost
  win.setTitleBarOverlay({ color: glass ? '#00000000' : '#060709', symbolColor: frost ? '#1c1e2c' : glass ? '#e6e4f5' : '#a3a3a3', height: 36 })
}

function createWindow(): void {
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
      sandbox: true
    }
  })
  if (process.platform === 'win32' && app.isPackaged) {
    win.setAppDetails({ appId: APP_ID, appIconPath: icon, relaunchCommand: process.execPath, relaunchDisplayName: 'Jolty' })
  }
  win.webContents.setWindowOpenHandler(({ url }) => {
    openWeb(url)
    return { action: 'deny' }
  })
  // the window only ever shows the app itself: anything else goes to the browser, never into this window
  win.webContents.on('will-navigate', (event, url) => {
    if (url === win?.webContents.getURL()) return
    event.preventDefault()
    openWeb(url)
  })
  // shown once the first frame is painted: no white flash, no half-drawn layout
  // automated screenshot runs (JOLTY_TEST=1) open without taking focus from whatever the user is doing
  // started with Windows: it waits in the tray until opened
  void applyWindowGlass()
  // the user may switch Windows' transparency effects while Jolty runs
  win.on('focus', () => {
    const s = store.loadSettings()
    if ((s.glassClear || 0) > 0 && (s.theme === 'glass' || s.theme === 'frost')) void applyWindowGlass()
  })
  win.once('ready-to-show', () => (background.startHidden() ? undefined : process.env.JOLTY_TEST ? win?.showInactive() : win?.show()))
  // a dead or hung page stays a black window: bring it back, at most 3 times a minute so a real loop cannot spin
  let reloads: number[] = []
  const revive = (why: string): void => {
    const now = Date.now()
    reloads = reloads.filter((t) => now - t < 60_000)
    console.error(`[jolty] window page ${why}`)
    if (reloads.length >= 3 || !win || win.isDestroyed()) return
    reloads.push(now)
    win.webContents.reload()
  }
  win.webContents.on('render-process-gone', (_e, d) => revive(`gone: ${d.reason}`))
  win.webContents.on('unresponsive', () => revive('unresponsive'))
  win.webContents.on('did-fail-load', (_e, code, desc, _url, isMain) => isMain && code !== -3 && revive(`failed to load: ${desc}`))
  background.attach(win)
  // the hidden quick entry window would otherwise keep the app alive once the main window closed for good
  win.on('closed', () => process.platform !== 'darwin' && !background.keepRunning() && app.quit())
  if (process.env.ELECTRON_RENDERER_URL) void win.loadURL(process.env.ELECTRON_RENDERER_URL)
  else void win.loadFile(path.join(__dirname, '../renderer/index.html'))
}

/** Registers `channel` so the renderer gets the value, or the error message as a rejection. */
function handle<A extends unknown[], R>(channel: string, fn: (...args: A) => R | Promise<R>): void {
  remote.register(channel, fn as (...a: unknown[]) => unknown)
  ipcMain.handle(channel, async (_e, ...args) => fn(...(args as A)))
}

function registerIpc(): void {
  // the phone link is managed at the PC only: these channels are not in the phone's allowed list (remote-policy.ts)
  handle('remote:status', () => remote.status())
  handle('remote:enable', (on: boolean) => remote.enable(on === true))
  handle('remote:pair', () => remote.startPairing())
  handle('remote:revoke', async (id: string) => (remote.revoke(String(id)), remote.status()))
  handle('remote:disconnect', () => remote.disconnectAll())
  handle('remote:stopScreen', () => remote.stopScreen())
  handle('remote:wakeStatus', () => remote.wakeStatus())
  handle('remote:wakeSet', (url: string) => remote.wakeSet(String(url)))
  handle('remote:wakeTest', () => remote.wakeTest())
  handle('remote:wakeConfig', () => remote.wakeConfig())
  handle('profiles:list', () => jolty.profiles())
  handle('profiles:create', (input) => jolty.createProfile(input as never))
  handle('profiles:update', (id: string, patch) => jolty.updateProfile(id, patch as never))
  handle('profiles:remove', (id: string) => jolty.removeProfile(id))
  handle('profiles:reorder', (ids: unknown) => void store.reorderProfiles(ids))
  handle('profiles:status', (id: string) => jolty.status(id))
  handle('profiles:login', (id: string) => jolty.login(id))
  handle('profiles:logout', (id: string) => jolty.logout(id))
  handle('profiles:models', (id: string) => jolty.models(id))

  handle('sessions:list', () => jolty.sessions())
  handle('sessions:external', (profileId: string, cwd?: string) => jolty.externalSessions(profileId, cwd))
  handle('sessions:start', (input) => jolty.startSession(input as never))
  handle('sessions:history', (id: string) => jolty.loadHistory(id))
  handle('sessions:importAll', () => jolty.importAll())
  handle('sessions:send', (id: string, text: string, attachments, parallel) => jolty.sendMessage(id, text, (attachments as never) || [], undefined, parallel === true))
  handle('sessions:interrupt', (id: string) => jolty.interrupt(id))
  handle('sessions:setModel', (id: string, model: string) => jolty.setModel(id, model))
  handle('sessions:setEffort', (id: string, effort: string) => jolty.setEffort(id, effort))
  handle('sessions:setPermissionMode', (id: string, mode) => jolty.setPermissionMode(id, mode as never))
  handle('sessions:compact', (id: string) => jolty.compact(id))
  handle('sessions:compactAndWait', (id: string) => jolty.compactAndWait(String(id)))
  handle('sessions:rewind', (id: string, itemId: string, dryRun?: boolean) => jolty.rewind(id, String(itemId), dryRun === true))
  handle('sessions:setBrowser', (id: string, on: boolean) => jolty.setBrowser(id, on === true))
  handle('sessions:setComputer', (id: string, on: boolean) => jolty.setComputer(id, on === true))
  handle('sessions:setMcpOff', (id: string, names: string[]) => jolty.setMcpOff(id, Array.isArray(names) ? names : []))
  handle('sessions:connectors', () => userServerNames())
  // the folder comes from the chat, never from the window
  const cwdOf = (id: string): string => {
    const cwd = jolty.sessions().find((s) => s.id === id)?.cwd
    if (!cwd) throw new Error(tr("Conversația nu există."))
    return cwd
  }
  handle('sessions:githubOverview', (id: string, force?: boolean) => github.overview(cwdOf(id), force === true))
  handle('sessions:githubIssue', (id: string, n: number) => github.issue(cwdOf(id), n))
  handle('sessions:githubAutoMerge', (id: string, on: boolean) => github.autoMerge(cwdOf(id), on === true))
  handle('schedules:list', () => jolty.scheduler.list())
  handle('schedules:add', (input) => jolty.scheduler.add(input as never))
  handle('schedules:update', (id: string, patch) => jolty.scheduler.update(String(id), (patch || {}) as never))
  handle('schedules:remove', (id: string) => jolty.scheduler.remove(String(id)))
  handle('schedules:run', (id: string) => jolty.scheduler.runNow(String(id)))
  handle('power:arm', (on: boolean, plan?: unknown) => jolty.power.arm(on === true, plan))
  handle('power:cancel', () => jolty.power.cancel())
  handle('power:state', () => jolty.power.state())
  handle('browser:hasToken', () => Boolean(store.getSecret(BROWSER_TOKEN_KEY)))
  handle('browser:info', () => browsers())
  handle('updates:status', () => updater.current())
  handle('updates:check', () => updater.check())
  // a manual update restarts the app, so it is asked once first (here, not in the page: a native confirm() there leaves the chat box without keyboard focus)
  handle('updates:install', async () => {
    const version = updater.current().version
    const busy = jolty.anyBusy()
    const r = await dialog.showMessageBox(win!, {
      type: 'question',
      title: 'Jolty',
      message: tr("Actualizezi Jolty la {version}?", { version: version || '' }),
      detail: busy
        ? tr("Jolty se închide și se pornește din nou. Ce lucrează acum se oprește, iar conversațiile rămân și le poți continua.")
        : tr("Jolty se închide și se pornește din nou, în câteva secunde. Conversațiile rămân."),
      buttons: [tr("Actualizează"), tr("Mai târziu")],
      defaultId: 0,
      cancelId: 1,
      noLink: true
    })
    if (r.response === 0) await updater.install()
  })
  // from a paired phone: no dialog on the PC (nobody is there), the phone asked its user. The phones are told first, so they say "updating" and not "lost".
  handle('updates:installFromPhone', async () => {
    const s = updater.current()
    if (s.state !== 'ready' && s.state !== 'available') throw new Error(tr("Nu e nicio actualizare de instalat."))
    remote.broadcast('jolty:event', { type: 'restarting' })
    await new Promise((r) => setTimeout(r, 400))
    await updater.install()
  })
  handle('composer:slash', (cwd?: string) => slashItems(typeof cwd === 'string' ? cwd : undefined))
  handle('composer:files', (cwd: string) => (typeof cwd === 'string' && fs.existsSync(cwd) ? projectFiles(cwd) : []))
  handle('browser:setToken', async (token: string) => {
    store.setSecret(BROWSER_TOKEN_KEY, (typeof token === 'string' && cleanToken(token)) || undefined)
    await jolty.reconnectBrowser()
  })
  handle('browser:openExtensionPage', () => openWeb(BROWSER_EXTENSION_URL))
  handle('browser:native', async () => {
    await nativeBrowser.start()
    return nativeBrowser.status()
  })
  handle('browser:installNative', () => nativeBrowser.installAndOpen())
  handle('browser:live', (on: boolean) => (on === true ? browserLive.start() : browserLive.stop()))
  handle('preview:open', (cwd: string) => (typeof cwd === 'string' ? preview.open(cwd) : ''))
  handle('preview:probe', (ports: unknown) => listening(Array.isArray(ports) ? ports.filter((p): p is number => Number.isInteger(p) && p > 0 && p < 65536) : []))
  // voice input: the model is fetched once on request, recordings are checked before whisper sees them
  handle('voice:status', () => voice.status())
  handle('voice:download', () =>
    voice.download((completed, total) => send({ type: 'pull', tag: 'whisper', status: 'download', completed, total })).then(
      () => send({ type: 'pull', tag: 'whisper', status: 'gata', done: true }),
      (err) => {
        send({ type: 'pull', tag: 'whisper', status: 'eroare', error: String(err), done: true })
        throw err
      }
    )
  )
  handle('voice:transcribe', (wav: unknown, lang: unknown) => {
    // a 16 kHz mono 16-bit WAV: 50 MB is about 26 minutes
    if (!(wav instanceof Uint8Array) || wav.length < 44 || wav.length > 50e6) return ''
    return voice.transcribe(wav, typeof lang === 'string' && /^(auto|[a-z]{2,3})$/.test(lang) ? lang : 'auto')
  })
  handle('preview:draft', (rel: string, html: string | null) => {
    if (typeof rel === 'string' && (typeof html === 'string' || html === null)) preview.draft(rel, html)
  })
  handle('sessions:respond', (id: string, requestId: string, decision) => jolty.respond(id, requestId, decision as never))
  handle('sessions:handoff', (id: string, target: string, model?: string, effort?: string, fresh?: boolean) =>
    jolty.handoff(id, target, typeof model === 'string' ? model : undefined, typeof effort === 'string' ? effort : undefined, fresh === true)
  )
  // a conversation removed, archived, pinned or brought back on the PC or on a phone: every window and phone reads the list again
  const listChanged = <T>(v: T): T => (send({ type: 'sessionsChanged' }), v)
  handle('sessions:remove', async (id: string) => listChanged(await jolty.removeSession(id)))
  handle('sessions:referenceFile', (id: string) => jolty.referenceFile(String(id)))
  // the Library page: what was attached or linked, and the pictures one by one (small ones for the grid)
  const thumbs = new Map<string, string>()
  handle('library:list', () => buildLibrary(jolty.sessions(), (id) => store.loadTranscript(id)))
  handle('library:image', (sessionId: unknown, itemId: unknown, index: unknown, small: unknown) => {
    if (typeof sessionId !== 'string' || typeof itemId !== 'string' || typeof index !== 'number') return null
    const key = `${sessionId}:${itemId}:${index}:${small === true}`
    const hit = thumbs.get(key)
    if (hit) return hit
    const item = store.loadTranscript(sessionId).find((x) => x.id === itemId)
    const url = item && item.kind === 'user' ? item.images?.[index]?.dataUrl : undefined
    if (!url) return null
    let out = url
    if (small === true) {
      const img = nativeImage.createFromDataURL(url)
      if (!img.isEmpty() && img.getSize().width > 280) out = `data:image/jpeg;base64,${img.resize({ width: 280, quality: 'good' }).toJPEG(72).toString('base64')}`
      if (thumbs.size > 400) thumbs.clear()
      thumbs.set(key, out)
    }
    return out
  })
  handle('sessions:rename', (id: string, title: string) => jolty.renameSession(String(id), String(title)))
  handle('sessions:setFlags', async (ids: unknown, flags: { pinned?: boolean; archived?: boolean }) => listChanged(await jolty.setFlags(Array.isArray(ids) ? ids.map(String) : [], flags ?? {})))
  handle('sessions:closed', () => jolty.closedSessions())
  handle('sessions:restore', async (id?: string) => listChanged(await jolty.restoreSession(id === undefined ? undefined : String(id))))
  handle('sessions:review', (id: string) => jolty.review(String(id)))
  // the worktree comes from the session's own record, never from a path the renderer sends
  const tree = (id: unknown) => {
    const w = jolty.sessions().find((s) => s.id === id)?.worktree
    if (!w) throw new Error(tr("Conversația nu are un worktree."))
    return w
  }
  const seen = (v: unknown) => ({ tip: String((v as { tip?: unknown })?.tip ?? ''), baseTip: String((v as { baseTip?: unknown })?.baseTip ?? '') })
  handle('merge:status', (id: string) => gitMerge.mergeStatus(tree(id)))
  handle('merge:check', (id: string, action) => gitMerge.mergeCheck(tree(id), action === 'rebase' ? 'rebase' : 'merge'))
  handle('merge:run', (id: string, action, s) => (action === 'rebase' ? gitMerge.rebaseBranch(tree(id), seen(s)) : gitMerge.mergeBranch(tree(id), seen(s))))
  handle('merge:pr', (id: string, title, body) => gitMerge.createPr(tree(id), String(title ?? ''), String(body ?? '')))
  handle('merge:remove', async (id: string, tip, lose) => {
    await gitMerge.removeBranch(tree(id), String(tip ?? ''), lose === true)
    jolty.forgetWorktree(String(id))
  })
  handle('sessions:side', (id: string, profileId?: string, model?: string, effort?: string) =>
    jolty.sideChat(String(id), { profileId: typeof profileId === 'string' ? profileId : undefined, model: typeof model === 'string' ? model : undefined, effort: typeof effort === 'string' ? effort : undefined })
  )
  handle('sessions:promoteSide', (id: string) => jolty.promoteSide(String(id)))
  handle('skills:list', () => skills.list())
  handle('skills:check', (ids?: string[]) => skills.check(ids))
  handle('skills:update', (id: string) => skills.update(String(id)))
  handle('skills:setSource', (id: string, source) => skills.setSource(String(id), source as never))
  handle('skills:reveal', (id: string) => skills.reveal(String(id)))
  handle('pack:items', () => pack.items())
  handle('pack:export', (req) => pack.exportPack(req as never))
  handle('pack:open', (file?: string) => pack.openPack(file))
  handle('pack:apply', (previewId: string, decisions) => pack.apply(String(previewId), decisions as never))
  handle('pack:discard', (previewId: string) => pack.discard(String(previewId)))
  handle('pack:undo', (importId: string) => pack.undo(String(importId)))
  handle('backup:list', () => backup.list())
  handle('backup:pictures', () => backup.fillPictures())
  handle('backup:setConfig', (id: string, values) => backup.setConfig(id, values as never))
  handle('backup:connect', (id: string) => backup.connect(id))
  handle('backup:disconnect', (id: string) => backup.disconnect(id))
  handle('backup:setPassword', (id: string, password: string) => backup.setPassword(id, password))
  handle('backup:run', (id: string) => backup.run(id))
  handle('backup:remote', (id: string) => backup.remote(id))
  handle('backup:restore', (id: string, password?: string) => backup.restore(id, typeof password === 'string' ? password : undefined))
  handle('usage:time', () => useTime.stats())
  handle('sessions:improvePrompt', (text: string, profileId?: string, model?: string, cwd?: string, sessionId?: string) =>
    jolty.improvePrompt(String(text), typeof profileId === 'string' ? profileId : undefined, typeof model === 'string' ? model : undefined, typeof cwd === 'string' ? cwd : undefined, typeof sessionId === 'string' ? sessionId : undefined)
  )

  handle('usage:summary', () => jolty.usageSummary())
  handle('usage:balance', (id: string) => jolty.balance(id))
  handle('usage:refreshLimits', (id: string) => jolty.refreshLimits(id))

  handle('local:hardware', () => local.hardware())
  handle('local:status', () => local.status())
  handle('local:catalog', () => local.catalog())
  handle('local:pull', (tag: string) => jolty.pullLocal(tag))
  handle('local:remove', (tag: string) => local.remove(tag))
  handle('local:createProfile', (tag: string) => jolty.createLocalProfile(tag))
  handle('local:installOllama', () => system.fix('ollama', (p) => shell.openPath(p)))

  handle('claudeWeb:list', () => jolty.claudeWebList())
  handle('claudeWeb:connect', (id: string) => jolty.claudeWeb.connect(jolty.profile(id)))
  handle('claudeWeb:disconnect', (id: string) => jolty.claudeWeb.disconnect(id))
  handle('claudeWeb:refresh', (id: string) => jolty.claudeWeb.refresh(jolty.profile(id)))
  handle('setup:testKey', (baseUrl: unknown, model: unknown, key: unknown) => connect.testKey(baseUrl, model, key))
  handle('setup:providerModels', (baseUrl: unknown, key: unknown, profileId: unknown) => connect.providerModels(baseUrl, key, profileId))
  handle('setup:testFree', (model: unknown) => connect.testFree(model))
  handle('setup:account', (engine: unknown) => jolty.connectAccount(engine))
  handle('setup:presets', () => jolty.setupPresets())
  handle('setup:helper', (profileId: unknown, model: unknown) => jolty.startSetupHelper(profileId, model))

  handle('system:check', () => system.check())
  handle('system:fix', async (id: string) => {
    await system.fix(id, (p) => shell.openPath(p))
    if (id === 'opencode') jolty.addDetectedAgents()
  })

  handle('codexImport:detect', (id: string, cwd?: string) => jolty.codex.importDetect(jolty.profile(id), cwd))
  handle('codexImport:run', (id: string, cwd?: string, types?: string[]) => jolty.codex.importRun(jolty.profile(id), cwd, types))

  handle('app:settings', () => store.loadSettings())
  // read synchronously by the preload, before the interface builds any text
  ipcMain.on('app:lang', (e) => (e.returnValue = getLang()))
  handle('app:saveSettings', async (patch) => {
    const saved = store.saveSettings(patch as never)
    if (patch && typeof patch === 'object' && 'language' in patch) setLang(saved.language)
    if (patch && typeof patch === 'object' && 'remoteScreen' in patch && saved.remoteScreen !== true) remote.stopScreen()
    if (patch && typeof patch === 'object' && 'autoUpdate' in patch) updater.setAuto(saved.autoUpdate !== false)
    if (patch && typeof patch === 'object' && Object.keys(patch).some((k) => k.startsWith('browser'))) await jolty.reconnectBrowser()
    if (patch && typeof patch === 'object' && ('keepInBackground' in patch || 'startWithWindows' in patch)) background.apply(patch as never)
    if (patch && typeof patch === 'object' && ('theme' in patch || 'glassClear' in patch)) void applyWindowGlass()
    send({ type: 'settingsChanged' })
    return saved
  })
  handle('app:pickFolder', async () => {
    const r = await dialog.showOpenDialog(win!, { properties: ['openDirectory'] })
    return r.canceled ? undefined : r.filePaths[0]
  })
  handle('app:openExternal', (url: string) => openWeb(url))
  handle('app:sendBugReport', (message: unknown, facts: unknown) => sendBugReport(message, facts))
  // Windows keeps its toast switches in the registry: one for every app, one per app id. Off in either, and nothing shows outside the window.
  handle('app:notificationsBlocked', async () => {
    if (process.platform !== 'win32') return false
    const off = (key: string, value: string): Promise<boolean> =>
      new Promise((resolve) => execFile('reg', ['query', key, '/v', value], { windowsHide: true, timeout: 5000 }, (err, out) => resolve(!err && new RegExp(`${value}\\s+REG_DWORD\\s+0x0\\b`).test(out))))
    const base = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\'
    const [all, mine] = await Promise.all([off(base + 'PushNotifications', 'ToastEnabled'), off(base + 'Notifications\\Settings\\' + APP_ID, 'Enabled')])
    return all || mine
  })
  handle('app:openNotificationSettings', () => shell.openExternal('ms-settings:notifications'))
  handle('app:glassSupport', () => glassSupport())
  handle('app:openColorSettings', () => shell.openExternal('ms-settings:colors'))
  // the renderer only ever opens Jolty's own data folder; any other path would let a compromised page launch files
  handle('app:openPath', async (p: string) => {
    if (typeof p === 'string' && path.resolve(p) === path.resolve(store.dataDir())) await shell.openPath(p)
  })
  handle('app:revealPath', (p: string) => shell.showItemInFolder(localPath(p)))
  // right-click menu actions: the menu is drawn by the renderer in Jolty's theme, these only do what a page cannot
  const EDITS = ['undo', 'redo', 'cut', 'copy', 'paste', 'selectAll'] as const
  handle('app:edit', (action: string) => {
    if (win && !win.isDestroyed() && (EDITS as readonly string[]).includes(action)) win.webContents[action as (typeof EDITS)[number]]()
  })
  handle('app:copyText', (text: string) => {
    if (typeof text === 'string') clipboard.writeText(text)
  })
  handle('app:openLocal', (p: string) => {
    if (typeof p === 'string') return openLocal(localPath(p))
  })
  handle('app:openLink', (url: string) => {
    if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) return
    const b = activeBrowser()
    if (b) b.open(url)
    else openWeb(url)
  })
  handle('app:image', (kind: string, image: string, name: string) => {
    const img = typeof image === 'string' ? /^data:image\/(png|jpeg|gif|webp);base64,([A-Za-z0-9+/=]+)$/.exec(image) : null
    if (!img) return
    const ext = img[1] === 'jpeg' ? 'jpg' : img[1]
    const bytes = Buffer.from(img[2], 'base64')
    const base = (path.parse(String(name || 'imagine')).name || 'imagine').replace(/[<>:"/\|?*]/g, '_')
    if (kind === 'copy') {
      clipboard.write([new ClipboardItem({ 'image/png': new Blob([new Uint8Array(nativeImage.createFromBuffer(bytes).toPNG())], { type: 'image/png' }) })])
    } else if (kind === 'save' && win) {
      void dialog.showSaveDialog(win, { defaultPath: `${base}.${ext}`, filters: [{ name: tr("Imagine"), extensions: [ext] }] }).then((r) => {
        if (!r.canceled && r.filePath) fs.writeFileSync(r.filePath, bytes)
      })
    } else if (kind === 'open') {
      const dir = path.join(os.tmpdir(), 'jolty-images')
      fs.mkdirSync(dir, { recursive: true })
      const file = path.join(dir, `${base}-${Date.now()}.${ext}`)
      fs.writeFileSync(file, bytes)
      void shell.openPath(file)
    }
  })
  handle('app:version', () => __JOLTY_VERSION__)
}

// One Jolty at a time: two instances would write the same profile and conversation files
if (!app.requestSingleInstanceLock()) {
  app.exit(0)
} else {
  app.setAppUserModelId(APP_ID)
  // a window behind other windows (or without focus) keeps painting: the Live panel's browser picture and the
  // preview must follow the model while the user works in another app, not only when Jolty is on top
  app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion')
  app.commandLine.appendSwitch('disable-backgrounding-occluded-windows')
  app.commandLine.appendSwitch('disable-renderer-backgrounding')
  // the CI runner has no GPU: software WebGL lets the 3D mascot start there (tests only, users keep their own GPU path)
  if (process.env.JOLTY_TEST) app.commandLine.appendSwitch('enable-unsafe-swiftshader')
  app.on('second-instance', () => {
    if (!win || win.isDestroyed()) return
    if (win.isMinimized()) win.restore()
    win.focus()
  })
  // a second launch brings the running Jolty back, also from the tray
  app.on('second-instance', () => background.reveal())
  app.whenReady().then(() => {
    jolty = new Jolty(send)
    void nativeBrowser.start()
    jolty.scheduler.start()
    registerIpc()
    void remote.init()
    allowFraming(session.defaultSession)
    createWindow()
    updater.init(
      (status) => send({ type: 'update', status }),
      () => {
        win?.show()
        win?.focus()
      },
      store.loadSettings().autoUpdate !== false
    )
    updater.init((status) => send({ type: 'update', status }), background.reveal)
    background.init({ window: () => win, focus: (sessionId) => send({ type: 'focus', open: sessionId }), quickEntry: quick.open, quickKeyBusy: quick.keyBusy }, icon)
    quick.init({
      start: async ({ profileId, cwd, text }) => {
        const last = store.loadSettings().lastModels?.[profileId]
        // the new chat's defaults (renderer ModelPicker DEFAULT_MODE), on the model this profile used last
        const meta = await jolty.startSession({ profileId, cwd, model: last?.model, effort: last?.effort || undefined, permissionMode: 'autoEdit' })
        store.saveSettings({ lastProfileId: profileId, lastCwd: cwd })
        send({ type: 'meta', sessionId: meta.id, meta })
        void jolty.sendMessage(meta.id, text).catch((err) => send({ type: 'status', sessionId: meta.id, status: 'error', error: err instanceof Error ? err.message : String(err) }))
        return meta
      },
      reveal: background.reveal,
      focus: (sessionId) => send({ type: 'focus', open: sessionId }),
      isMain: (e) => Boolean(win && !win.isDestroyed() && e.sender === win.webContents),
      state: background.state
    })
    // model lists and the scores table refreshed in the background, so a newly released model is announced without opening the picker
    modelWatch.start({
      scan: !process.env.JOLTY_TEST,
      profiles: () => jolty.profiles(),
      loggedIn: (id) => jolty.status(id).then((s) => s.loggedIn),
      models: (id) => jolty.models(id),
      limits: (id) => jolty.refreshLimits(id)
    })
    void jolty.sweepTemps().catch(() => undefined)
    const vault = store.loadSettings().obsidianVault
    if (vault && !process.env.JOLTY_TEST) {
      void obsidian.start()
      globalShortcut.register(obsidian.SHORTCUT, () => void obsidian.toggle())
      void obsidian.backup(vault, store.loadSettings().obsidianBackupDir || obsidian.defaultBackupDir())
    }
    jolty.sweepTrash()
    if (!process.env.JOLTY_TEST) useTime.startUseTime(() => jolty.anyBusy(), () => BrowserWindow.getAllWindows().some((w) => w.isFocused()))
    // automated runs start with What's new already seen, unless the run sets an older seenVersion itself
    if (process.env.JOLTY_TEST && !store.loadSettings().seenVersion) store.saveSettings({ seenVersion: __JOLTY_VERSION__ })
    if (!process.env.JOLTY_TEST) {
      setTimeout(() => void store.shrinkTranscripts(), 10000)
    }
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })
}

let quitting = false
app.on('before-quit', (e) => {
  // Quit in the tray, the updater's restart and the power menu all end here: the window may close for real now
  background.letClose()
  if (quitting || !jolty) return
  e.preventDefault()
  quitting = true
  preview.stop()
  void remote.stop()
  screenVideo.dispose()
  const vault = store.loadSettings().obsidianVault
  const obsidianDone = vault
    ? obsidian.backup(vault, store.loadSettings().obsidianBackupDir || obsidian.defaultBackupDir()).catch(() => undefined).then(() => obsidian.stop())
    : undefined
  void Promise.all([nativeComputer.stop().catch(() => undefined), jolty.shutdown(), obsidianDone]).then(() => nativeBrowser.stop()).finally(() => app.quit())
  quick.stop()
  background.destroy()
  void Promise.all([nativeComputer.stop().catch(() => undefined), jolty.shutdown()]).then(() => nativeBrowser.stop()).finally(() => app.quit())
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
