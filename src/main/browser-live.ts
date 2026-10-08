// The Live panel's Browser tab: the page in the Jolty browser window, streamed with Chromium's own
// screencast over the debugging port that window already opens. The extension mode drives the
// user's everyday browser through the extension and has no such port, so it gets a note instead.
import fs from 'fs'
import path from 'path'
import type { ChatEvent } from '@shared/types'
import { browserMode } from './browser'
import { dataDir } from './store'

interface Target {
  id: string
  type: string
  url: string
  title: string
  webSocketDebuggerUrl?: string
}

function debugPort(): number {
  try {
    return Number(fs.readFileSync(path.join(dataDir(), 'browser-profile', 'DevToolsActivePort'), 'utf8').split(/\r?\n/)[0]) || 0
  } catch {
    return 0
  }
}

/** Open tabs, most recently used first (Chromium's own order), so the agent's current tab leads. */
async function pages(port: number): Promise<Target[]> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(1500) })
    const list = (await res.json()) as Target[]
    // web pages only: not the browser's own screens (edge://, vivaldi://, Vivaldi's UI as an extension page)
    return list.filter((t) => t.type === 'page' && t.webSocketDebuggerUrl && /^(https?|about|data|file):/i.test(t.url))
  } catch {
    return []
  }
}

export class BrowserLive {
  private ws?: WebSocket
  private target?: string
  private timer?: NodeJS.Timeout
  private note?: string
  private url = ''
  private title = ''

  constructor(private emit: (e: ChatEvent) => void) {}

  start(): void {
    if (this.timer) return
    this.note = undefined
    void this.poll()
    // follows tab switches and navigations; frames themselves arrive as the page paints
    this.timer = setInterval(() => void this.poll(), 2000)
  }

  stop(): void {
    clearInterval(this.timer)
    this.timer = undefined
    this.close()
  }

  private close(): void {
    this.ws?.close()
    this.ws = undefined
    this.target = undefined
  }

  private say(note: string): void {
    this.close()
    if (note === this.note) return
    this.note = note
    this.emit({ type: 'browserLive', note })
  }

  private async poll(): Promise<void> {
    if (browserMode() !== 'own') return this.say('Imaginea live merge cu fereastra proprie Jolty. Alege-o în Setări, la Browser.')
    const port = debugPort()
    const page = port ? (await pages(port))[0] : undefined
    if (!page) return this.say('Browserul Jolty e închis. Se deschide când modelul folosește browserul.')
    this.note = undefined
    if (page.url !== this.url || page.title !== this.title) {
      this.url = page.url
      this.title = page.title
      this.emit({ type: 'browserLive', url: page.url, title: page.title })
    }
    if (page.id === this.target && this.ws) return
    this.close()
    this.target = page.id
    const ws = new WebSocket(page.webSocketDebuggerUrl!)
    this.ws = ws
    let seq = 0
    const call = (method: string, params: object): void => ws.send(JSON.stringify({ id: ++seq, method, params }))
    ws.onopen = () => call('Page.startScreencast', { format: 'jpeg', quality: 60, maxWidth: 1280, maxHeight: 900 })
    ws.onmessage = (m) => {
      const msg = JSON.parse(String(m.data)) as { method?: string; params?: { data: string; sessionId: number } }
      if (msg.method !== 'Page.screencastFrame' || !msg.params) return
      // Chromium sends the next frame only after this one is acknowledged
      call('Page.screencastFrameAck', { sessionId: msg.params.sessionId })
      this.emit({ type: 'browserLive', frame: msg.params.data, url: this.url, title: this.title })
    }
    ws.onerror = () => ws.close()
    ws.onclose = () => {
      if (this.ws !== ws) return
      this.ws = undefined
      this.target = undefined
    }
  }
}
