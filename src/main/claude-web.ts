// The claude.ai side of a Claude account: its limit resets and promotions (Full reset, Fable reset...). Claude Code's OAuth token
// is answered "not eligible" for them, so each profile gets a claude.ai sign-in of its own, in a window the person fills in
// themselves, kept in a storage partition of that profile. Nothing is typed or stored by Jolty: only the browser's own cookies.
import { BrowserWindow, Notification, session, type Session } from 'electron'
import type { ChatEvent, Profile } from '@shared/types'
import { parseResets, type ClaudeResets, type ClaudeWebInfo } from '@shared/claude-resets'
import { tr } from '@shared/i18n'
import * as store from './store'
import { claudeAccount } from './engines/claude'

const HOME = 'https://claude.ai'
const EVERY = 30 * 60 * 1000

const partitionOf = (profileId: string): string => `persist:claude-web-${profileId.replace(/[^\w-]/g, '')}`

/* eslint-disable @typescript-eslint/no-explicit-any */
interface Fetched {
  status: number
  json?: any
}

export class ClaudeWeb {
  private timer?: NodeJS.Timeout
  private reading = new Set<string>()

  constructor(
    private send: (e: ChatEvent) => void,
    private profiles: () => Profile[]
  ) {}

  private ses(profileId: string): Session {
    const s = session.fromPartition(partitionOf(profileId))
    // a browser's name: the site answers browsers, and the Electron token is not one
    s.setUserAgent(s.getUserAgent().replace(/\s(Electron|jolty)\/\S+/gi, ''))
    return s
  }

  private async get(profileId: string, path: string): Promise<Fetched> {
    try {
      const res = await this.ses(profileId).fetch(HOME + path, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(20000) })
      if (!(res.headers.get('content-type') || '').includes('json')) return { status: res.status }
      return { status: res.status, json: await res.json() }
    } catch {
      return { status: 0 }
    }
  }

  /** Where the profile's claude.ai session stands; the session must belong to the same account as the profile. */
  async info(profile: Profile): Promise<ClaudeWebInfo> {
    const saved = store.loadClaudeWeb()[profile.id]
    if (!saved) return { profileId: profile.id, connected: false }
    const acc = await this.get(profile.id, '/api/account')
    const email = typeof acc.json?.email_address === 'string' ? acc.json.email_address : undefined
    if (!email) {
      // no answer at all (offline) is not a signed-out session
      return acc.status === 0 ? { profileId: profile.id, connected: true, email: saved.email } : { profileId: profile.id, connected: false, problem: 'signin', email: saved.email }
    }
    const mine = await claudeAccount(profile)
    if (mine?.email && mine.email.toLowerCase() !== email.toLowerCase()) return { profileId: profile.id, connected: true, problem: 'account', email }
    return { profileId: profile.id, connected: true, email }
  }

  /** Opens the claude.ai sign-in in a window of its own; resolves when the person is in, or closed the window. */
  async connect(profile: Profile): Promise<ClaudeWebInfo> {
    const ses = this.ses(profile.id)
    // a fresh sign-in: an old session of another account must not be picked up again
    await ses.clearStorageData()
    const parent = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
    const win = new BrowserWindow({
      width: 520,
      height: 780,
      parent,
      title: tr("Conectare claude.ai"),
      autoHideMenuBar: true,
      webPreferences: { session: ses, contextIsolation: true, sandbox: true, nodeIntegration: false }
    })
    // Google and the email link open their pages in a second window of the same storage
    win.webContents.setWindowOpenHandler(({ url }) => (url.startsWith('https://') ? { action: 'allow' } : { action: 'deny' }))
    win.webContents.on('will-navigate', (e, url) => {
      if (!url.startsWith('https://')) e.preventDefault()
    })
    return new Promise<ClaudeWebInfo>((resolve) => {
      let done = false
      const finish = async (signedIn: boolean): Promise<void> => {
        if (done) return
        done = true
        if (signedIn) {
          const acc = await this.get(profile.id, '/api/account')
          store.saveClaudeWeb(profile.id, { email: typeof acc.json?.email_address === 'string' ? acc.json.email_address : undefined, at: Date.now() })
        }
        if (!win.isDestroyed()) win.close()
        const info = await this.info(profile)
        this.send({ type: 'claudeWeb', info })
        if (info.connected && !info.problem) void this.refresh(profile)
        resolve(info)
      }
      const check = async (): Promise<void> => {
        if (done || win.isDestroyed()) return
        const url = win.webContents.getURL()
        if (!url.startsWith(HOME + '/')) return
        const acc = await this.get(profile.id, '/api/account')
        if (typeof acc.json?.email_address === 'string') await finish(true)
      }
      win.webContents.on('did-navigate', () => void check())
      win.webContents.on('did-navigate-in-page', () => void check())
      win.on('closed', () => void finish(false))
      void win.loadURL(HOME + '/login')
    })
  }

  /** Forgets the session of this profile: its cookies go, and with them what it showed. */
  async disconnect(profileId: string): Promise<void> {
    await this.ses(profileId).clearStorageData()
    store.dropClaudeWeb(profileId)
    this.send({ type: 'claudeWeb', info: { profileId, connected: false } })
    this.send({ type: 'resets', resets: { profileId, grants: [], updatedAt: Date.now() } })
  }

  /** Reads the resets of one profile now. Returns undefined when there is no usable session. */
  async refresh(profile: Profile): Promise<ClaudeResets | undefined> {
    if (this.reading.has(profile.id)) return store.loadResets()[profile.id]
    this.reading.add(profile.id)
    try {
      const info = await this.info(profile)
      this.send({ type: 'claudeWeb', info })
      if (!info.connected || info.problem) return undefined
      const org = await this.orgOf(profile)
      if (!org) return undefined
      const usage = await this.get(profile.id, `/api/organizations/${org}/usage?cedar_ember=1&skip_spend=1`)
      if (!usage.json) return undefined
      const prev = store.loadResets()[profile.id]
      const resets: ClaudeResets = { profileId: profile.id, grants: parseResets(usage.json), updatedAt: Date.now() }
      store.saveResets(resets)
      this.send({ type: 'resets', resets })
      this.announce(profile, prev, resets)
      return resets
    } finally {
      this.reading.delete(profile.id)
    }
  }

  /** The organisation of the profile's account: the one Claude Code reports, else the first chat organisation of the session. */
  private async orgOf(profile: Profile): Promise<string | undefined> {
    const mine = (await claudeAccount(profile))?.orgUuid
    const list = await this.get(profile.id, '/api/organizations')
    const orgs: { uuid?: string; capabilities?: string[] }[] = Array.isArray(list.json) ? list.json : []
    if (mine && orgs.some((o) => o.uuid === mine)) return mine
    return orgs.find((o) => typeof o.uuid === 'string' && o.capabilities?.includes('chat'))?.uuid ?? orgs.find((o) => typeof o.uuid === 'string')?.uuid
  }

  /** A reset or promotion the account did not have at the last read: said once, as the usage page would show it. */
  private announce(profile: Profile, prev: ClaudeResets | undefined, now: ClaudeResets): void {
    if (!prev || process.env.JOLTY_TEST || !Notification.isSupported()) return
    for (const g of now.grants) {
      if (prev.grants.some((p) => p.id === g.id)) continue
      new Notification({
        title: tr("Reset nou pe {name}", { name: profile.name }),
        body: g.endsAt ? tr("{label}. Expiră {when}.", { label: g.label, when: new Date(g.endsAt).toLocaleDateString(undefined, { day: 'numeric', month: 'short' }) }) : g.label
      }).show()
    }
  }

  private claudeProfiles(): Profile[] {
    return this.profiles().filter((p) => p.engine === 'claude' && p.auth === 'subscription' && store.loadClaudeWeb()[p.id])
  }

  /** The saved state at start, then a read now and every half hour for the profiles that have a session. */
  start(): void {
    if (process.env.JOLTY_TEST) return
    const run = async (): Promise<void> => {
      for (const p of this.claudeProfiles()) await this.refresh(p).catch(() => undefined)
    }
    setTimeout(() => void run(), 25000).unref()
    this.timer = setInterval(() => void run(), EVERY)
    this.timer.unref()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
  }
}
