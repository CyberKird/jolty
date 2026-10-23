// Jolty's own browser bridge as the app uses it: starts the hub, keeps the extension folder in step with
// the app, gives engines their MCP connection and tells the settings page what state everything is in.
import { randomBytes } from 'crypto'
import { app, clipboard, shell } from 'electron'
import fs from 'fs'
import path from 'path'
import type { NativeBrowserStatus } from '@shared/types'
import { activeBrowser, browsers } from '../browser'
import { dataDir, getSecret, loadSettings, setSecret } from '../store'
import { tr } from '@shared/i18n'
import { handleJoltyTools } from '../jolty-tools'
import { nativeComputer } from '../computer/native'
import { BrowserHub } from './hub'
import { BrowserService } from './service'

const TOKEN_KEY = 'jbrowser-token'

export const NATIVE_SERVER = 'jolty-browser'

/** Chromium browsers load one extension, Firefox another (it has no DevTools protocol for extensions). */
type Kind = 'browser-extension' | 'browser-extension-firefox'
const kindOf = (firefox: boolean): Kind => (firefox ? 'browser-extension-firefox' : 'browser-extension')
/** The browser that is on the other end of a connection, from the user agent it reports. */
const kindOfAgent = (agent: string): Kind => kindOf(/Firefox\//.test(agent))

/** The extension files that ship with the app: next to the executable when installed, in the repo while developing. */
const bundledDir = (kind: Kind): string => {
  const candidates = [path.join(process.resourcesPath || '', kind), path.join(__dirname, '../..', kind), path.join(app.getAppPath(), kind)]
  return candidates.find((c) => fs.existsSync(path.join(c, 'manifest.json'))) || candidates[0]
}
export const installedDir = (kind: Kind = 'browser-extension'): string => path.join(dataDir(), kind)
const KINDS: Kind[] = ['browser-extension', 'browser-extension-firefox']

const versionOf = (dir: string): string => {
  try {
    return String(JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8')).version || '')
  } catch {
    return ''
  }
}

function token(): string {
  let t = getSecret(TOKEN_KEY)
  if (!t) {
    t = randomBytes(24).toString('hex')
    setSecret(TOKEN_KEY, t)
  }
  return t
}

class NativeBrowser {
  readonly hub = new BrowserHub({
    token,
    bundledVersion: (agent) => versionOf(bundledDir(kindOfAgent(agent))),
    mcp: (sid, m) => this.service.handle(sid, m),
    tools: handleJoltyTools,
    computer: (sid, m) => nativeComputer.handle(sid, m),
    log: (m) => process.env.JOLTY_DEBUG && console.error('[jbrowser]', m)
  })
  readonly service = new BrowserService(this.hub, {
    overlay: () => loadSettings().browserOverlay !== false,
    notConnected: () => this.notConnected(),
    ensureBrowser: () => this.ensureBrowser(),
    log: (m) => process.env.JOLTY_DEBUG && console.error('[jbrowser]', m)
  })
  private started?: Promise<void>
  private launched = 0

  /** Starts the local server and brings the installed extension up to date. Safe to call again. */
  start(): Promise<void> {
    this.started ??= this.hub
      .start()
      .then(() => this.refreshFiles())
      .catch((e) => {
        this.started = undefined
        console.error('browser bridge:', e)
      })
    return this.started
  }

  async stop(): Promise<void> {
    await this.hub.stop()
    this.started = undefined
  }

  /** Whether the browser Jolty works in is Firefox. */
  private firefox(): boolean {
    return browsers().active === 'firefox'
  }

  /** Port and token in the extension folder: the extension reads them each time it connects. */
  private writeConfig(dir: string): void {
    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ token: token(), ports: [this.hub.port] }))
  }

  /** What the user installed once stays current: files copied again when the app ships a newer extension. */
  private refreshFiles(): void {
    for (const kind of KINDS) {
      const dir = installedDir(kind)
      if (!fs.existsSync(dir)) continue
      const stale = versionOf(dir) !== versionOf(bundledDir(kind))
      if (stale) this.copyFiles(kind, dir)
      else this.writeConfig(dir)
      if (stale) this.hub.reloadExtension()
    }
  }

  private copyFiles(kind: Kind, dir: string): void {
    fs.mkdirSync(dir, { recursive: true })
    for (const name of fs.readdirSync(bundledDir(kind))) fs.copyFileSync(path.join(bundledDir(kind), name), path.join(dir, name))
    this.writeConfig(dir)
  }

  /** Puts the extension files where the browser will load them from (once; the browser keeps the path). */
  install(): string {
    const kind = kindOf(this.firefox())
    const dir = installedDir(kind)
    this.copyFiles(kind, dir)
    return dir
  }

  /** Copies the files, puts the folder path on the clipboard and opens the browser's extensions page and the folder. */
  async installAndOpen(): Promise<NativeBrowserStatus> {
    await this.start()
    const dir = this.install()
    // Firefox asks for the manifest file, the other browsers for the folder
    clipboard.writeText(this.firefox() ? path.join(dir, 'manifest.json') : dir)
    activeBrowser()?.open(activeBrowser()!.extensionsUrl)
    void shell.openPath(dir)
    return this.status()
  }

  status(): NativeBrowserStatus {
    const firefox = this.firefox()
    const kind = kindOf(firefox)
    const dir = installedDir(kind)
    return {
      installed: fs.existsSync(path.join(dir, 'manifest.json')),
      connected: this.hub.connected,
      version: this.hub.extension?.version,
      bundledVersion: versionOf(bundledDir(kind)),
      dir,
      port: this.hub.port,
      ...(firefox ? { firefox } : {})
    }
  }

  /** The MCP connection an engine gives its model, one per chat so each chat has tabs of its own. */
  mcp(sid: string): { url: string; headers: Record<string, string> } {
    return { url: `http://127.0.0.1:${this.hub.port}/mcp/${sid}`, headers: { Authorization: `Bearer ${token()}` } }
  }

  /** Jolty's own tools for the same chat; undefined while the local server is not up. */
  toolsMcp(sid: string): { url: string; headers: Record<string, string> } | undefined {
    if (!this.hub.port) return undefined
    return { url: `http://127.0.0.1:${this.hub.port}/jolty/${sid}`, headers: { Authorization: `Bearer ${token()}` } }
  }

  /** Computer use for the same chat: the screen, the mouse and the keyboard of this PC; undefined while the local server is not up. */
  computerMcp(sid: string): { url: string; headers: Record<string, string> } | undefined {
    if (!this.hub.port) return undefined
    return { url: `http://127.0.0.1:${this.hub.port}/computer/${sid}`, headers: { Authorization: `Bearer ${token()}` } }
  }

  release(sid: string): Promise<void> {
    return this.service.release(sid)
  }

  private notConnected(): string {
    const b = activeBrowser()
    const name = b?.name || 'the browser'
    return this.status().installed
      ? tr("Extensia Jolty nu e conectată. Deschide {name} (cu extensia Jolty pornită) și încearcă din nou; dacă e deja deschis, apasă pe iconița extensiei și pe Reconectează.", { name })
      : tr("Extensia Jolty nu e instalată în {name}. Deschide Setări > Browser în Jolty și urmează pașii de instalare.", { name })
  }

  /** The browser may simply be closed: open it and give the extension a moment to connect. */
  private async ensureBrowser(): Promise<void> {
    const end = Date.now() + 20000
    while (!this.hub.connected && Date.now() < end) {
      if (!this.launched || Date.now() - this.launched > 60000) {
        if (this.status().installed) {
          this.launched = Date.now()
          // an already running browser just opens one more window; the extension answers within seconds
          await new Promise((r) => setTimeout(r, 2500))
          if (!this.hub.connected) activeBrowser()?.open('about:blank')
        }
      }
      await new Promise((r) => setTimeout(r, 400))
    }
  }
}

export const nativeBrowser = new NativeBrowser()
