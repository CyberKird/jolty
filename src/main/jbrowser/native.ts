// Jolty's own browser bridge as the app uses it: starts the hub, keeps the extension folder in step with
// the app, gives engines their MCP connection and tells the settings page what state everything is in.
import { randomBytes } from 'crypto'
import { app } from 'electron'
import fs from 'fs'
import path from 'path'
import type { NativeBrowserStatus } from '@shared/types'
import { activeBrowser } from '../browser'
import { dataDir, getSecret, loadSettings, setSecret } from '../store'
import { tr } from '@shared/i18n'
import { BrowserHub } from './hub'
import { BrowserService } from './service'

const TOKEN_KEY = 'jbrowser-token'

export const NATIVE_SERVER = 'jolty-browser'

/** The extension files that ship with the app: next to the executable when installed, in the repo while developing. */
const bundledDir = (): string => {
  const candidates = [path.join(process.resourcesPath || '', 'browser-extension'), path.join(__dirname, '../../browser-extension'), path.join(app.getAppPath(), 'browser-extension')]
  return candidates.find((c) => fs.existsSync(path.join(c, 'manifest.json'))) || candidates[0]
}
export const installedDir = (): string => path.join(dataDir(), 'browser-extension')

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
    bundledVersion: () => versionOf(bundledDir()),
    mcp: (sid, m) => this.service.handle(sid, m),
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

  /** Port and token in the extension folder: the extension reads them each time it connects. */
  private writeConfig(dir: string): void {
    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ token: token(), ports: [this.hub.port] }))
  }

  /** What the user installed once stays current: files copied again when the app ships a newer extension. */
  private refreshFiles(): void {
    const dir = installedDir()
    if (!fs.existsSync(dir)) return
    const stale = versionOf(dir) !== versionOf(bundledDir())
    if (stale) this.copyFiles(dir)
    else this.writeConfig(dir)
    if (stale) this.hub.reloadExtension()
  }

  private copyFiles(dir: string): void {
    fs.mkdirSync(dir, { recursive: true })
    for (const name of fs.readdirSync(bundledDir())) fs.copyFileSync(path.join(bundledDir(), name), path.join(dir, name))
    this.writeConfig(dir)
  }

  /** Puts the extension files where the browser will load them from (once; the browser keeps the path). */
  install(): string {
    const dir = installedDir()
    this.copyFiles(dir)
    return dir
  }

  status(): NativeBrowserStatus {
    const dir = installedDir()
    return {
      installed: fs.existsSync(path.join(dir, 'manifest.json')),
      connected: this.hub.connected,
      version: this.hub.extension?.version,
      bundledVersion: versionOf(bundledDir()),
      dir,
      port: this.hub.port
    }
  }

  /** The MCP connection an engine gives its model, one per chat so each chat has tabs of its own. */
  mcp(sid: string): { url: string; headers: Record<string, string> } {
    return { url: `http://127.0.0.1:${this.hub.port}/mcp/${sid}`, headers: { Authorization: `Bearer ${token()}` } }
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
