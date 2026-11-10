import { createApi } from '@shared/api-factory'
import type { JoltyApi } from '@shared/types'

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
    ws.onopen = () => ws.send(JSON.stringify({ t: 'auth', token: this.token }))
    ws.onmessage = (ev) => {
      const m = JSON.parse(String(ev.data)) as { t: string; id?: number; ok?: boolean; value?: unknown; error?: string; channel?: string; data?: unknown }
      if (m.t === 'ready') {
        const back = this.everReady
        this.ready = true
        this.everReady = true
        this.delay = 500
        for (const w of this.waiters.splice(0)) w()
        // while the phone was away, events were missed: start again from the PC's state
        if (back) location.reload()
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
      for (const p of this.pending.values()) p.reject(new Error('Connection to the PC lost'))
      this.pending.clear()
      if (ev.code === 4401) {
        // the PC does not know this key (revoked or reset): pair again
        localStorage.removeItem(KEY)
        if (!this.everReady) return fail?.(new Error('This phone is no longer paired. Open the pairing link from Jolty again.'))
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

/** A plain screen before the app exists: asks for the code shown at the PC, or says what went wrong. */
function pairScreen(message?: string): Promise<string> {
  document.title = 'Jolty'
  const root = document.getElementById('root')!
  root.innerHTML = ''
  const box = document.createElement('form')
  box.style.cssText = 'min-height:100dvh;display:flex;flex-direction:column;justify-content:center;gap:14px;padding:28px;max-width:420px;margin:auto;font:16px/1.4 Inter,system-ui,sans-serif;color:#e8e8ea;background:#060709'
  box.innerHTML = '<div style="font-size:22px;font-weight:600">Jolty</div><div style="color:#9a9aa2">Pair this phone with your PC. In Jolty on the PC open Settings, Phone, and press Pair a phone.</div>'
  const input = document.createElement('input')
  Object.assign(input, { placeholder: 'Pairing code', autocomplete: 'off', autocapitalize: 'characters' })
  input.style.cssText = 'padding:14px;border-radius:12px;border:1px solid #2a2a30;background:#101014;color:inherit;font:inherit;letter-spacing:.12em;text-transform:uppercase'
  const btn = document.createElement('button')
  btn.textContent = 'Pair'
  btn.style.cssText = 'padding:14px;border-radius:12px;border:0;background:#d4ff00;color:#060709;font:inherit;font-weight:600'
  const note = document.createElement('div')
  note.style.cssText = 'color:#ff8a80;min-height:1.4em'
  note.textContent = message || ''
  box.append(input, btn, note)
  root.append(box)
  return new Promise((resolve) => {
    box.onsubmit = async (e) => {
      e.preventDefault()
      btn.disabled = true
      try {
        resolve(await claim(input.value))
      } catch (err) {
        note.textContent = err instanceof Error ? err.message : String(err)
        btn.disabled = false
      }
    }
  })
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
      ;(window as unknown as { jolty: JoltyApi }).jolty = createApi(link.call, link.listen, () => '')
      return
    } catch (e) {
      note = e instanceof Error ? e.message : String(e)
      token = ''
    }
  }
}
