// The Live panel's Preview tab: the project folder served on 127.0.0.1 so an HTML page the model is
// building shows up rendered, and reloads by itself whenever a file in the folder changes. A page
// still being written is served from memory (draft), so the preview fills in while the model types.
// Dev servers (Next.js, Vite) are shown directly by the panel and never come through here.
import fs from 'fs'
import http from 'http'
import path from 'path'
import type { AddressInfo } from 'net'

const TYPES: Record<string, string> = {
  html: 'text/html', htm: 'text/html', css: 'text/css', js: 'text/javascript', mjs: 'text/javascript', json: 'application/json',
  svg: 'image/svg+xml', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
  avif: 'image/avif', ico: 'image/x-icon', woff: 'font/woff', woff2: 'font/woff2', ttf: 'font/ttf', otf: 'font/otf',
  mp4: 'video/mp4', webm: 'video/webm', mp3: 'audio/mpeg', wav: 'audio/wav', txt: 'text/plain', wasm: 'application/wasm'
}
const RELOAD = '<script>new EventSource("/__jolty/events").onmessage=function(){location.reload()}</script>'
const SKIP = /(^|[\\/])(node_modules|\.git|\.next|\.jolty)([\\/]|$)/
const DRAFT_TTL = 60_000

export class Preview {
  private server?: http.Server
  private watcher?: fs.FSWatcher
  private root = ''
  private base = ''
  private clients = new Set<http.ServerResponse>()
  private drafts = new Map<string, { html: string; at: number }>()
  private timer?: NodeJS.Timeout

  /** Serves `cwd` (restarting if the folder changed) and returns the server's origin, or '' if it cannot. */
  async open(cwd: string): Promise<string> {
    const root = path.resolve(cwd)
    if (this.server && this.root === root) return this.base
    this.stop()
    if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) return ''
    this.root = root
    const server = http.createServer((req, res) => this.serve(req, res))
    await new Promise<void>((ok, fail) => server.once('error', fail).listen(0, '127.0.0.1', ok))
    this.server = server
    this.base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    try {
      // ponytail: one recursive watch on the project folder; a huge cwd (a whole home dir) makes it heavy
      this.watcher = fs.watch(root, { recursive: true }, (_, name) => this.changed(name || ''))
      this.watcher.on('error', () => {})
    } catch {
      // no watching: the panel's refresh button still works
    }
    return this.base
  }

  /** The unfinished content of `rel` (a path inside the project) until the real file lands; null clears it. */
  draft(rel: string, html: string | null): void {
    const key = this.key(rel)
    if (html === null) this.drafts.delete(key)
    else this.drafts.set(key, { html, at: Date.now() })
    this.ping()
  }

  stop(): void {
    this.watcher?.close()
    this.server?.close()
    for (const c of this.clients) c.end()
    this.clients.clear()
    this.drafts.clear()
    this.watcher = this.server = undefined
    this.root = this.base = ''
  }

  private key(rel: string): string {
    return path.normalize(rel).replace(/^[\\/]+/, '').replace(/\\/g, '/').toLowerCase()
  }

  private changed(name: string): void {
    if (SKIP.test(name)) return
    this.drafts.delete(this.key(name)) // the file itself was written: it replaces its draft
    clearTimeout(this.timer)
    this.timer = setTimeout(() => this.ping(), 150)
  }

  private ping(): void {
    for (const c of this.clients) c.write('data: 1\n\n')
  }

  private serve(req: http.IncomingMessage, res: http.ServerResponse): void {
    const send = (code: number, body: string | Buffer, type = 'text/plain'): void => {
      res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store' })
      res.end(body)
    }
    // only our own panel talks to this server: a rebinding page would arrive with a foreign Host
    if (req.headers.host !== new URL(this.base).host) return send(403, 'forbidden')
    let rel: string
    try {
      rel = decodeURIComponent(new URL(req.url || '/', this.base).pathname)
    } catch {
      return send(400, 'bad request')
    }
    if (rel === '/__jolty/events') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' })
      res.write('retry: 1000\n\n')
      this.clients.add(res)
      req.on('close', () => this.clients.delete(res))
      return
    }
    if (rel.endsWith('/')) rel += 'index.html'
    // no dot-folders or dot-files (.env, .git) and nothing outside the project
    if (rel.split(/[\\/]/).some((s) => s.startsWith('.'))) return send(404, 'not found')
    const file = path.resolve(this.root, '.' + rel)
    if (file !== this.root && !file.startsWith(this.root + path.sep)) return send(403, 'forbidden')
    const page = (html: string): void => send(200, html.includes('</body>') ? html.replace(/<\/body>(?![\s\S]*<\/body>)/i, RELOAD + '</body>') : html + RELOAD, 'text/html; charset=utf-8')
    const draft = this.drafts.get(this.key(rel))
    if (draft && Date.now() - draft.at < DRAFT_TTL) return page(draft.html)
    fs.stat(file, (err, st) => {
      if (err) return send(404, 'not found')
      const target = st.isDirectory() ? path.join(file, 'index.html') : file
      fs.readFile(target, (e, data) => {
        if (e) return send(404, 'not found')
        const type = TYPES[path.extname(target).slice(1).toLowerCase()] || 'application/octet-stream'
        if (type === 'text/html') page(data.toString('utf8'))
        else send(200, data, type)
      })
    })
  }
}
