import { test } from 'node:test'
import assert from 'node:assert'
import fs from 'fs'
import http from 'http'
import os from 'os'
import path from 'path'
import { listening, Preview } from '../src/main/preview'

test('preview server: serves the project, hides dot-files, refuses foreign hosts, serves drafts, reloads on change', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prev-'))
  fs.writeFileSync(path.join(dir, 'index.html'), '<html><body>v1</body></html>')
  fs.writeFileSync(path.join(dir, '.env'), 'SECRET=1')
  fs.mkdirSync(path.join(dir, 'sub'))
  fs.writeFileSync(path.join(dir, 'sub', 'a.css'), 'b{}')
  const p = new Preview()
  try {
    const base = await p.open(dir)
    const get = (u: string) => fetch(base + u)
    const home = await (await get('/')).text()
    assert(home.includes('v1') && home.includes('/__jolty/events'), 'index with the reload script')
    assert.equal((await get('/sub/a.css')).headers.get('content-type'), 'text/css')
    for (const u of ['/.env', '/%2e%2e/x', '/nope.html']) assert.equal((await get(u)).status, 404, u)
    // fetch cannot set Host, so a rebinding page is simulated with http directly
    const code = await new Promise<number>((ok) => http.get(base + '/', { headers: { host: 'evil.com' } }, (res) => ok(res.statusCode || 0)))
    assert.equal(code, 403)
    // a page still being written exists only as a draft
    p.draft('new/page.html', '<h1>typing')
    const draft = await (await get('/new/page.html')).text()
    assert(draft.includes('<h1>typing') && draft.includes('__jolty/events'))
    // the real file lands: SSE pings and the draft is gone
    const ping = new Promise<void>((ok, no) => {
      setTimeout(() => no(new Error('no reload ping')), 4000)
      http.get(base + '/__jolty/events', (res) => res.on('data', (c) => String(c).includes('data: 1') && ok()))
    })
    fs.mkdirSync(path.join(dir, 'new'))
    fs.writeFileSync(path.join(dir, 'new', 'page.html'), '<body>done</body>')
    await ping
    const final = await (await get('/new/page.html')).text()
    assert(final.includes('done') && !final.includes('typing'))
  } finally {
    p.stop()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('listening: finds only ports with a server on them', async () => {
  const srv = http.createServer().listen(0, '127.0.0.1')
  await new Promise((ok) => srv.once('listening', ok))
  const port = (srv.address() as { port: number }).port
  try {
    assert.deepEqual(await listening([port, 1]), [port])
  } finally {
    srv.close()
  }
})
