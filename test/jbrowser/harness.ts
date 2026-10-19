// Starts everything a browser tool test needs: a local web server, the Jolty hub + service, and a real
// Chromium with the Jolty extension loaded. Tools are called over HTTP, exactly like a model's client does.
import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { BrowserHub } from '../../src/main/jbrowser/hub'
import { BrowserService } from '../../src/main/jbrowser/service'
import { PAGES } from './pages'

const TOKEN = 'test-token-0123456789abcdef0123456789abcdef'

export interface Harness {
  site: string
  hub: BrowserHub
  svc: BrowserService
  call(name: string, args?: Record<string, unknown>, sid?: string): Promise<{ text: string; images: number; isError: boolean }>
  rpc(sid: string, body: unknown, token?: string): Promise<Response>
  stop(): Promise<void>
}

export async function startHarness(opts: { overlay?: boolean } = {}): Promise<Harness> {
  // JBROWSER_FIREFOX=<firefox.exe> runs the same tests in Firefox, with the Firefox extension loaded by web-ext
  const firefox = process.env.JBROWSER_FIREFOX
  const chrome = process.env.JBROWSER_CHROME || path.join(process.env.LOCALAPPDATA || '', 'ms-playwright/chromium-1234/chrome-win64/chrome.exe')
  if (!firefox && !fs.existsSync(chrome)) throw new Error('no test Chromium at ' + chrome)
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jbrowser-test-'))
  const ext = path.join(root, 'ext')
  fs.cpSync(path.resolve(firefox ? 'browser-extension-firefox' : 'browser-extension'), ext, { recursive: true })

  const site = http.createServer((req, res) => {
    const url = new URL(req.url || '/', 'http://x')
    const page = PAGES[url.pathname]
    res.writeHead(page ? 200 : 404, { 'content-type': 'text/html; charset=utf-8' }).end(page || 'not found')
  })
  await new Promise<void>((r) => site.listen(0, '127.0.0.1', r))
  const siteUrl = `http://127.0.0.1:${(site.address() as { port: number }).port}`

  const debug = (tag: string) => (m: string) => {
    if (process.env.JBROWSER_DEBUG) console.error(tag, m)
  }
  const hub = new BrowserHub({
    token: () => TOKEN,
    bundledVersion: () => '1.0.1',
    mcp: (sid, m) => svc.handle(sid, m),
    log: debug('[hub]')
  })
  const svc: BrowserService = new BrowserService(hub, {
    overlay: () => opts.overlay !== false,
    notConnected: () => 'not connected',
    log: debug('[svc]')
  })
  const port = await hub.start()
  fs.writeFileSync(path.join(ext, 'config.json'), JSON.stringify({ token: TOKEN, ports: [port] }))

  const proc: ChildProcess = firefox
    ? spawn('npx', ['--yes', 'web-ext', 'run', '--source-dir', ext, '--firefox', firefox, '--firefox-profile', path.join(root, 'profile'), '--profile-create-if-missing', '--no-reload', '--no-input', '--start-url', 'about:blank'].map((a) => `"${a}"`), { stdio: process.env.JBROWSER_DEBUG ? 'inherit' : 'ignore', shell: true })
    : spawn(
    chrome,
    [`--user-data-dir=${path.join(root, 'profile')}`, `--load-extension=${ext}`, `--disable-extensions-except=${ext}`, ...(process.env.JBROWSER_HEADFUL ? [] : ['--headless=new']), '--no-first-run', '--no-default-browser-check', '--window-size=1280,900', 'about:blank'],
    { stdio: 'ignore' }
  )
  const end = Date.now() + 30000
  while (!hub.connected && Date.now() < end) await new Promise((r) => setTimeout(r, 200))
  if (!hub.connected) {
    if (firefox && proc.pid) spawn('taskkill', ['/pid', String(proc.pid), '/T', '/F'], { stdio: 'ignore' })
    else proc.kill()
    throw new Error('the extension did not connect to the hub in 30s')
  }

  let id = 0
  const rpc = (sid: string, body: unknown, token = TOKEN): Promise<Response> =>
    fetch(`http://127.0.0.1:${port}/mcp/${sid}`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify(body) })

  return {
    site: siteUrl,
    hub,
    svc,
    rpc,
    async call(name, args = {}, sid = 'chat1') {
      const r = await rpc(sid, { jsonrpc: '2.0', id: ++id, method: 'tools/call', params: { name, arguments: args } })
      const j = (await r.json()) as { result: { content: { type: string; text?: string }[]; isError?: boolean } }
      return {
        text: j.result.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n'),
        images: j.result.content.filter((c) => c.type === 'image').length,
        isError: j.result.isError === true
      }
    },
    async stop() {
      // web-ext starts Firefox as a child of a shell: the whole tree has to go
      if (firefox && proc.pid) spawn('taskkill', ['/pid', String(proc.pid), '/T', '/F'], { stdio: 'ignore' })
      else proc.kill()
      await hub.stop()
      site.close()
      await new Promise((r) => setTimeout(r, 400))
      fs.rmSync(root, { recursive: true, force: true })
    }
  }
}
