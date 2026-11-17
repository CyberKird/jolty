import crypto from 'crypto'
import fs from 'fs'
import type http from 'http'
import path from 'path'
import zlib from 'zlib'
import { getLang } from '@shared/i18n'

// The phone's copy of the page: the desktop's built files, served from this PC.
// - The page names, up front, every script the phone is sure to run (from the build's manifest), so a phone on a far
//   line fetches them all in one round trip instead of one after the other (entry, dictionary, phone code, app, chat).
// - Text files are sent compressed with brotli at its best setting, made once and in the background (never blocking
//   the PC's main process); built files carry a hash in their name and are kept by the phone for good.
// - The phone keeps (service worker) only the scripts it runs: not the 3D character, not the other languages.

declare const __JOLTY_VERSION__: string | undefined
const VERSION = typeof __JOLTY_VERSION__ === 'string' ? __JOLTY_VERSION__ : 'dev'

type End = (code: number, body?: string | Buffer, type?: string, extra?: Record<string, string>) => void

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.glb': 'model/gltf-binary',
  '.wasm': 'application/wasm'
}

/** What makes the page installable on a phone's home screen and lets it use the whole screen. */
const PHONE_HEAD = [
  '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover, interactive-widget=resizes-content" />',
  '<link rel="manifest" href="/manifest.webmanifest" />',
  '<link rel="apple-touch-icon" href="/apple-touch-icon.png" />',
  '<meta name="apple-mobile-web-app-capable" content="yes" />',
  '<meta name="mobile-web-app-capable" content="yes" />',
  '<meta name="apple-mobile-web-app-title" content="Jolty Remote" />',
  '<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />',
  '<meta name="theme-color" content="#060709" />'
].join('')

/** the bar of the app with its bolt (as remote/pair-screen.ts draws it), shown until the scripts are in */
const BOOT_SHELL =
  '<header class="titlebar boot-shell"><div class="titlebar-brand"><svg class="bolt" width="4.7" height="17" viewBox="0 0 205 740" aria-hidden="true"><polygon points="52,0 170,0 118,300 205,284 56,740 84,408 0,426"/></svg></div></header>'

/** the dictionary chunks of the interface languages (named like "de-AbCd1234.js"): a phone keeps only its own */
const LOCALE_CHUNK = /^(ar|de|en|es|fr|hi|id|it|ja|ko|pt-BR)-[\w-]{8}\.js$/
/** what a phone never runs: the 3D character, its physics, the desktop's quick entry box, and the old font format */
const NOT_ON_PHONE = /^(Rig3D|ragdoll|Mascot|QuickEntry)-|\.woff$/
/** the modules a phone always runs, as the build's manifest names them */
const PHONE_ROOTS = ['src/App.tsx', 'src/remote/boot.ts', 'src/remote/phone.ts', 'src/remote/link.ts', 'src/remote/keystore.ts']

const TEXT = /^(text\/|application\/(json|manifest\+json|wasm)|image\/svg)/

interface Packed {
  etag: string
  raw: Buffer
  br?: Buffer
  gz?: Buffer
}

interface ManifestChunk {
  file: string
  imports?: string[]
  css?: string[]
}

export class PhoneFiles {
  /** compressed copies, by file and content */
  private packed = new Map<string, Packed>()
  private preload?: { lang: string; mtime: number; links: string }

  constructor(
    private root: string,
    private agentOrigin: () => string
  ) {}

  /** Serves a file of the page (GET or HEAD). */
  serve(pathname: string, host: string, req: http.IncomingMessage, end: End): void {
    let rel: string
    try {
      rel = decodeURIComponent(pathname)
    } catch {
      return end(400)
    }
    if (rel === '/shell.json') return end(200, JSON.stringify(this.shellFiles()), 'application/json', { 'Cache-Control': 'no-cache' })
    const target = path.resolve(this.root, '.' + (rel === '/' ? '/index.html' : rel))
    if (target !== this.root && !target.startsWith(this.root + path.sep)) return end(403)
    // build bookkeeping (.vite) is not part of the page
    if (rel.includes('/.')) return end(404, 'Not found')
    fs.readFile(target, (err, data) => {
      if (err) return end(404, 'Not found')
      const type = MIME[path.extname(target).toLowerCase()] || 'application/octet-stream'
      let body: Buffer = data
      let cache = rel.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache'
      const more: Record<string, string> = {}
      if (target.endsWith(`${path.sep}index.html`)) body = Buffer.from(this.page(data.toString('utf8'), host))
      // the kept pages are named after the version, so an update replaces them
      else if (rel === '/sw.js') {
        body = Buffer.from(data.toString('utf8').replace('__VERSION__', VERSION))
        cache = 'no-cache'
        more['Service-Worker-Allowed'] = '/'
      }
      this.send(req, body, type, cache, target, end, more)
    })
  }

  private send(req: http.IncomingMessage, raw: Buffer, type: string, cache: string, key: string, end: End, more: Record<string, string>): void {
    const p = this.entry(key, raw)
    const extra: Record<string, string> = { 'Cache-Control': cache, ETag: p.etag, Vary: 'Accept-Encoding', ...more }
    if (req.headers['if-none-match'] === p.etag) return end(304, '', type, extra)
    if (!TEXT.test(type) || raw.length <= 1024) return end(200, raw, type, extra)
    const accept = String(req.headers['accept-encoding'] || '')
    const br = /\bbr\b/.test(accept)
    const gz = !br && /\bgzip\b/.test(accept)
    if (!br && !gz) return end(200, raw, type, extra)
    void this.pack(p, br ? 'br' : 'gz').then((out) => end(200, out, type, { ...extra, 'Content-Encoding': br ? 'br' : 'gzip' }))
  }

  private entry(key: string, raw: Buffer): Packed {
    const etag = `"${crypto.createHash('sha1').update(raw).digest('base64url').slice(0, 22)}"`
    const k = `${key}:${etag}`
    let p = this.packed.get(k)
    if (!p) {
      if (this.packed.size > 600) this.packed.clear()
      p = { etag, raw }
      this.packed.set(k, p)
    }
    return p
  }

  /** brotli at its best for files that are kept for good, a faster setting for the page itself (made on every visit) */
  private async pack(p: Packed, how: 'br' | 'gz'): Promise<Buffer> {
    if (how === 'gz') return (p.gz ??= await new Promise<Buffer>((r, j) => zlib.gzip(p.raw, { level: 9 }, (e, b) => (e ? j(e) : r(b)))))
    if (p.br) return p.br
    const quality = p.raw.length > 4_000_000 ? 9 : 11
    p.br = await new Promise<Buffer>((r, j) =>
      zlib.brotliCompress(p.raw, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: quality, [zlib.constants.BROTLI_PARAM_SIZE_HINT]: p.raw.length } }, (e, b) => (e ? j(e) : r(b)))
    )
    return p.br
  }

  /** Compresses the files a phone loads, one at a time in the background, so the first phone to come does not wait for it. */
  async warm(): Promise<void> {
    for (const f of this.shellFiles()) {
      const file = path.join(this.root, f)
      const type = MIME[path.extname(file).toLowerCase()] || ''
      if (!TEXT.test(type)) continue
      try {
        const raw = await fs.promises.readFile(file)
        if (raw.length > 1024) await this.pack(this.entry(file, raw), 'br')
      } catch {
        // a file gone with an update: made when asked
      }
    }
  }

  /** What the phone keeps for the page to open at once (and while the PC is off): the built files a phone runs. */
  shellFiles(): string[] {
    try {
      const lang = getLang()
      return fs
        .readdirSync(path.join(this.root, 'assets'))
        .filter((f) => !NOT_ON_PHONE.test(f))
        .filter((f) => !LOCALE_CHUNK.test(f) || f.startsWith(`${lang}-`))
        .map((f) => `/assets/${f}`)
    } catch {
      return []
    }
  }

  /** The scripts the phone is sure to run, with everything they import, as preload links (read from the build's manifest). */
  private preloads(): string {
    const lang = getLang()
    const file = path.join(this.root, 'build-manifest.json')
    let mtime = 0
    try {
      mtime = fs.statSync(file).mtimeMs
    } catch {
      return ''
    }
    if (this.preload && this.preload.lang === lang && this.preload.mtime === mtime) return this.preload.links
    let links = ''
    try {
      const m = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, ManifestChunk>
      const js = new Set<string>()
      const css = new Set<string>()
      const walk = (key: string): void => {
        const c = m[key]
        if (!c || js.has(c.file)) return
        js.add(c.file)
        for (const s of c.css ?? []) css.add(s)
        for (const i of c.imports ?? []) walk(i)
      }
      // the entry's own imports are already named by the page
      const entry = m['index.html']
      const inPage = new Set<string>()
      const mark = (key: string): void => {
        const c = m[key]
        if (!c || inPage.has(c.file)) return
        inPage.add(c.file)
        for (const i of c.imports ?? []) mark(i)
      }
      mark('index.html')
      for (const root of [...PHONE_ROOTS, `../shared/locales/${lang}.json`]) walk(root)
      for (const f of inPage) js.delete(f)
      for (const s of entry?.css ?? []) css.delete(s)
      links = [...js].map((f) => `<link rel="modulepreload" crossorigin href="/${f}">`).join('') + [...css].map((f) => `<link rel="preload" as="style" crossorigin href="/${f}">`).join('')
    } catch {
      links = ''
    }
    this.preload = { lang, mtime, links }
    return links
  }

  /** The desktop page, with the phone's connection allowed in its security policy, the language set before the app loads, and the preloads. */
  private page(html: string, host: string): string {
    return html
      .replace("connect-src 'self' blob:", `connect-src 'self' blob: wss://${host} ws://${host}${this.agentOrigin()}`)
      .replace('<head>', `<head><script src="/lang.js"></script>${PHONE_HEAD}`)
      .replace('</head>', `${this.preloads()}</head>`)
      // the app's bar, drawn as soon as the page and its styles are in: on a slow line the scripts take a while, and a blank
      // screen looks broken. React replaces it with the real app on its first render.
      .replace('<div id="root"></div>', `<div id="root">${BOOT_SHELL}</div>`)
  }
}
