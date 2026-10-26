// Just enough of a WebDAV server (Nextcloud layout) for the backup tests: Basic auth, PROPFIND Depth 0, MKCOL, PUT, GET.
// Two users, each only inside /dav/files/<user>/. Ana's answers use the d: prefix, Bob's a default namespace, because
// real servers differ. Used by test/backup-providers/webdav-test.ts.
import assert from 'node:assert/strict'
import http from 'node:http'

export const A = { user: 'ana', password: 'app-pw-ana' }
export const B = { user: 'bob', password: 'app-pw-bob' }

/** `collections` is a set of folder paths ending in /, `files` is path -> {data, modified}. Bob has no Jolty folder yet. */
export async function startWebdavMock() {
  const collections = new Set(['/dav/files/ana/', '/dav/files/ana/Jolty/', '/dav/files/bob/'])
  const files = new Map()
  const state = { requests: [] }
  const server = http.createServer(async (req, res) => {
    const chunks = []
    for await (const c of req) chunks.push(c)
    const body = Buffer.concat(chunks)
    const path = decodeURIComponent(new URL(req.url, 'http://x').pathname)
    state.requests.push(`${req.method} ${path}`)
    const m = /^Basic (.+)$/.exec(req.headers.authorization ?? '')
    const [user, password] = m ? Buffer.from(m[1], 'base64').toString().split(':') : []
    const acct = [A, B].find((x) => x.user === user && x.password === password)
    if (!acct) return void res.writeHead(401, { 'www-authenticate': 'Basic realm="x"' }).end()
    if (!path.startsWith(`/dav/files/${acct.user}/`)) return void res.writeHead(403).end()

    if (req.method === 'PROPFIND') {
      assert.equal(req.headers.depth, '0')
      const f = files.get(path)
      if (!f && !collections.has(path)) return void res.writeHead(404).end()
      const p = acct === A ? 'd:' : ''
      const ns = acct === A ? ' xmlns:d="DAV:"' : ' xmlns="DAV:"'
      const props = f ? `<${p}getlastmodified>${f.modified}</${p}getlastmodified><${p}getcontentlength>${f.data.length}</${p}getcontentlength>` : `<${p}resourcetype><${p}collection/></${p}resourcetype>`
      const xml = `<?xml version="1.0"?><${p}multistatus${ns}><${p}response><${p}href>${path}</${p}href><${p}propstat><${p}prop>${props}</${p}prop><${p}status>HTTP/1.1 200 OK</${p}status></${p}propstat></${p}response></${p}multistatus>`
      return void res.writeHead(207, { 'content-type': 'application/xml; charset=utf-8' }).end(xml)
    }
    if (req.method === 'MKCOL') {
      const parent = path.replace(/[^/]+\/$/, '')
      if (collections.has(path)) return void res.writeHead(405).end()
      if (!collections.has(parent)) return void res.writeHead(409).end()
      collections.add(path)
      return void res.writeHead(201).end()
    }
    if (req.method === 'PUT') {
      if (!collections.has(path.replace(/[^/]+$/, ''))) return void res.writeHead(409).end()
      assert.equal(Number(req.headers['content-length']), body.length)
      const had = files.has(path)
      files.set(path, { data: body, modified: new Date().toUTCString() })
      return void res.writeHead(had ? 204 : 201).end()
    }
    if (req.method === 'GET') {
      const f = files.get(path)
      return f ? void res.writeHead(200).end(f.data) : void res.writeHead(404).end()
    }
    res.writeHead(405).end()
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  return { server, files, collections, state, url: `http://127.0.0.1:${server.address().port}` }
}
