import { createApi } from '@shared/api-factory'
import type { JoltyApi } from '@shared/types'
import { screenBus } from './screen-bus'

// The same page runs in a phone's browser: there is no preload there, so the API is built over a WebSocket to the PC's Jolty.
// A phone is paired once (a code from Settings > Phone) and keeps its own key in this browser.

const KEY = 'jolty-remote-token'

interface Pending {
  resolve: (v: unknown) => void
  reject: (e: Error) => void
}

class Link {
  private ws?: WebSocket
  private ready = false
  private everReady = false
  private id = 0
  private pending = new Map<number, Pending>()
  private listeners = new Map<string, Set<(data: unknown) => void>>()
  private waiters: Array<() => void> = []
  private delay = 500

  constructor(private token: string) {}

  /** Resolves when the PC accepted the key for the first time. */
  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.open(resolve, reject)
    })
  }

  private open(first?: () => void, fail?: (e: Error) => void): void {
    const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`)
    this.ws = ws
    ws.binaryType = 'arraybuffer'
    ws.onopen = () => ws.send(JSON.stringify({ t: 'auth', token: this.token }))
    ws.onmessage = (ev) => {
      // a picture of the PC's screen
      if (typeof ev.data !== 'string') return screenBus.frame(ev.data as ArrayBuffer)
      const m = JSON.parse(String(ev.data)) as { t: string; id?: number; ok?: boolean; value?: unknown; error?: string; channel?: string; data?: unknown }
      if (m.t === 'screen') return screenBus.message(m as unknown as Record<string, unknown>)
      if (m.t === 'ready') {
        const back = this.everReady
        screenBus.attach((msg) => ws.readyState === 1 && ws.send(JSON.stringify(msg)))
        this.ready = true
        this.everReady = true
        this.delay = 500
        for (const w of this.waiters.splice(0)) w()
        // while the phone was away, events were missed: the page catches up from the PC (remote/phone.ts), keeping what is typed
        if (back) window.dispatchEvent(new Event('jolty:resync'))
        else first?.()
      } else if (m.t === 'res' && m.id !== undefined) {
        const p = this.pending.get(m.id)
        this.pending.delete(m.id)
        if (m.ok) p?.resolve(m.value)
        else p?.reject(new Error(m.error || 'Failed'))
      } else if (m.t === 'ev' && m.channel) {
        for (const cb of this.listeners.get(m.channel) || []) cb(m.data)
      }
    }
    ws.onclose = (ev) => {
      this.ready = false
      screenBus.message({ t: 'screen', op: 'ended', reason: 'link' })
      for (const p of this.pending.values()) p.reject(new Error('Connection to the PC lost'))
      this.pending.clear()
      if (ev.code === 4401) {
        // the PC does not know this key (revoked or reset): pair again
        localStorage.removeItem(KEY)
        if (!this.everReady) return fail?.(new Error('This phone is no longer paired. Open the pairing link from Jolty again.'))
        // revoked while the app was open: back to the pairing screen (nothing typed is worth keeping for a phone that was cut off)
        location.reload()
        return
      }
      setTimeout(() => this.open(first, fail), this.delay)
      this.delay = Math.min(this.delay * 2, 5000)
    }
  }

  private whenReady(): Promise<void> {
    return this.ready ? Promise.resolve() : new Promise((resolve) => this.waiters.push(resolve))
  }

  call = async <T>(channel: string, ...args: unknown[]): Promise<T> => {
    await this.whenReady()
    const id = ++this.id
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject })
      this.ws?.send(JSON.stringify({ t: 'call', id, channel, args }))
    })
  }

  listen = (channel: string, cb: (data: unknown) => void): (() => void) => {
    const set = this.listeners.get(channel) || new Set()
    set.add(cb)
    this.listeners.set(channel, set)
    return () => set.delete(cb)
  }
}

async function claim(code: string): Promise<string> {
  const name = /iPhone/.test(navigator.userAgent) ? 'iPhone' : /Android/.test(navigator.userAgent) ? 'Android' : 'Browser'
  const res = await fetch('/api/pair', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code, name }) })
  const j = (await res.json().catch(() => ({}))) as { token?: string; error?: string }
  if (!res.ok || !j.token) throw new Error(j.error || 'Pairing failed')
  return j.token
}

/** The pairing screen: asks for the code shown at the PC, or says what went wrong. */
async function pairScreen(message?: string): Promise<string> {
  const { pairScreen: show } = await import('./pair-screen')
  return show(message, claim)
}

/** Sets window.jolty for a browser that is not the desktop window. */
export async function connectRemote(): Promise<void> {
  document.documentElement.classList.add('remote')
  let token = localStorage.getItem(KEY) || ''
  const fromLink = /[#&]pair=([0-9A-Za-z]+)/.exec(location.hash)?.[1]
  let note: string | undefined
  if (!token && fromLink) {
    try {
      token = await claim(fromLink)
    } catch (e) {
      note = e instanceof Error ? e.message : String(e)
    }
  }
  history.replaceState(null, '', location.pathname)
  for (;;) {
    if (!token) token = await pairScreen(note)
    localStorage.setItem(KEY, token)
    const link = new Link(token)
    try {
      await link.start()
      const api = createApi(link.call, link.listen, () => '')
      // the PC's clipboard and browser are not the phone's: copying and links happen on the phone itself
      api.app.copyText = async (text) => void (await navigator.clipboard?.writeText(text).catch(() => undefined))
      api.app.openExternal = async (url) => void window.open(url, '_blank', 'noopener')
      api.app.openLink = async (url) => void window.open(url, '_blank', 'noopener')
      // no see-through window on a phone
      api.app.glassSupport = async () => 'os'
      ;(window as unknown as { jolty: JoltyApi }).jolty = api
      return
    } catch (e) {
      note = e instanceof Error ? e.message : String(e)
      token = ''
    }
  }
}
