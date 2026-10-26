// Just enough of Box for the backup tests: consent (redirects to the loopback port, no PKCE), tokens that need the
// client secret and single-use refresh tokens that rotate, /users/me, the root folder listing (paged, with other items
// in it), multipart upload (create and new version) and the download redirect. Used by test/backup-providers/box-test.ts.
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import http from 'node:http'

export const A = { id: '1001', login: 'ana@box.example', name: 'Ana' }
export const B = { id: '2002', login: 'bob@box.example', name: 'Bob' }
export const CLIENT = 'box-client'
export const SECRET = 'box-secret'

/** The parts of a multipart body, in order: [{name, filename, data}]. */
function parts(body, contentType) {
  const boundary = Buffer.from(`--${/boundary=(?:"([^"]+)"|([^;]+))/.exec(contentType)?.slice(1).find(Boolean)}`)
  const out = []
  let at = body.indexOf(boundary)
  while (at !== -1) {
    const start = at + boundary.length
    if (body.subarray(start, start + 2).toString() === '--') break
    const next = body.indexOf(boundary, start)
    const raw = body.subarray(start + 2, next - 2)
    const split = raw.indexOf('\r\n\r\n')
    const head = raw.subarray(0, split).toString()
    out.push({ name: /name="([^"]*)"/.exec(head)?.[1], filename: /filename="([^"]*)"/.exec(head)?.[1], data: raw.subarray(split + 4) })
    at = next
  }
  return out
}

/** `state.next` is the account the next sign-in returns; `state.fail401` refuses that many API calls; `state.pageSize` caps a listing page; `state.defer202` answers the next downloads with 202; `files` is user id -> {id, data, modified}. */
export async function startBoxMock() {
  const codes = new Map()
  const tokens = new Map()
  const refreshes = new Map()
  const files = new Map()
  const state = { next: A, fail401: 0, pageSize: 1000, defer202: 0, downloadAuth: /** @type {(string|undefined)[]} */ ([]) }
  const server = http.createServer(async (req, res) => {
    const u = new URL(req.url, 'http://x')
    const chunks = []
    for await (const c of req) chunks.push(c)
    const body = Buffer.concat(chunks)
    const send = (code, json, headers = {}) => res.writeHead(code, { 'content-type': 'application/json', ...headers }).end(JSON.stringify(json))
    const issue = (acct) => {
      const access = `at-${randomUUID()}`
      const refresh = `rt-${randomUUID()}`
      tokens.set(access, acct)
      refreshes.set(refresh, acct)
      return { access_token: access, refresh_token: refresh, expires_in: 4000, token_type: 'bearer' }
    }
    if (u.pathname === '/api/oauth2/authorize') {
      const q = u.searchParams
      assert.equal(q.get('client_id'), CLIENT)
      assert.equal(q.get('response_type'), 'code')
      assert.equal(q.get('code_challenge'), null, 'Box has no PKCE')
      assert.equal(q.get('redirect_uri'), 'http://127.0.0.1:53683/', 'Box needs the registered redirect exactly')
      assert.equal(q.get('scope'), 'root_readwrite')
      const code = randomUUID()
      codes.set(code, { acct: state.next, redirect: q.get('redirect_uri') })
      return void res.writeHead(302, { location: `${q.get('redirect_uri')}?code=${code}&state=${q.get('state')}` }).end()
    }
    if (u.pathname === '/oauth2/token') {
      const f = new URLSearchParams(body.toString())
      assert.equal(f.get('client_id'), CLIENT)
      assert.equal(f.get('client_secret'), SECRET)
      assert.equal(f.get('code_verifier'), null)
      if (f.get('grant_type') === 'authorization_code') {
        const c = codes.get(f.get('code'))
        if (!c) return send(400, { error: 'invalid_grant' })
        codes.delete(f.get('code'))
        return send(200, issue(c.acct))
      }
      const acct = refreshes.get(f.get('refresh_token'))
      if (!acct) return send(400, { error: 'invalid_grant', error_description: 'Refresh token has expired' })
      // single use: the old one is dead the moment it is exchanged
      refreshes.delete(f.get('refresh_token'))
      return send(200, issue(acct))
    }
    if (u.pathname.startsWith('/dl/')) {
      state.downloadAuth.push(req.headers.authorization)
      const f = [...files.values()].find((x) => x.id === u.pathname.split('/')[2])
      return f ? void res.writeHead(200).end(f.data) : send(404, {})
    }
    const acct = tokens.get((req.headers.authorization || '').replace('Bearer ', ''))
    if (!acct || (state.fail401 > 0 && u.pathname !== '/2.0/users/me' && state.fail401--)) return send(401, { code: 'unauthorized' })
    if (u.pathname === '/2.0/users/me') return send(200, { type: 'user', ...acct })
    const mine = files.get(acct.id)
    const entry = (f) => ({ type: 'file', id: f.id, name: 'jolty-backup.enc', size: f.data.length, modified_at: f.modified })
    if (u.pathname === '/2.0/folders/0/items') {
      assert.match(u.searchParams.get('fields'), /modified_at/)
      // other things in the root folder: the right file can be on a later page
      const all = [
        { type: 'folder', id: 'f1', name: 'Documents' },
        { type: 'file', id: 'f2', name: 'jolty-backup.enc.bak', size: 3, modified_at: '2020-01-01T00:00:00-00:00' },
        { type: 'folder', id: 'f3', name: 'jolty-backup.enc' },
        ...(mine ? [entry(mine)] : [])
      ]
      const offset = Number(u.searchParams.get('offset') || 0)
      const limit = Math.min(Number(u.searchParams.get('limit') || 100), state.pageSize)
      return send(200, { total_count: all.length, entries: all.slice(offset, offset + limit), offset, limit })
    }
    if (u.pathname === '/upload/2.0/files/content' || /^\/upload\/2\.0\/files\/[^/]+\/content$/.test(u.pathname)) {
      const [attrs, file, ...rest] = parts(body, req.headers['content-type'])
      assert.equal(attrs.name, 'attributes', 'attributes come before the file')
      assert.equal(file.name, 'file')
      assert.equal(rest.length, 0)
      const a = JSON.parse(attrs.data.toString())
      assert.equal(a.name, 'jolty-backup.enc')
      const id = u.pathname.split('/')[4]
      if (id === 'content') {
        assert.deepEqual(a.parent, { id: '0' })
        if (mine) return send(409, { code: 'item_name_in_use' })
      } else if (mine?.id !== id) return send(404, { code: 'not_found' })
      const f = { id: mine?.id || `file-${randomUUID()}`, data: file.data, modified: new Date().toISOString() }
      files.set(acct.id, f)
      return send(id === 'content' ? 201 : 200, { total_count: 1, entries: [entry(f)] })
    }
    const dl = /^\/2\.0\/files\/([^/]+)\/content$/.exec(u.pathname)
    if (dl && req.method === 'GET') {
      if (state.defer202 > 0) {
        state.defer202--
        return void res.writeHead(202, { 'retry-after': '0' }).end()
      }
      return mine?.id === dl[1] ? void res.writeHead(302, { location: `http://127.0.0.1:${server.address().port}/dl/${mine.id}` }).end() : send(404, {})
    }
    send(404, {})
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  return { server, files, state, refreshes, url: `http://127.0.0.1:${server.address().port}` }
}
