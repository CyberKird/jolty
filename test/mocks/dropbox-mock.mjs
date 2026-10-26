// Just enough of Dropbox for the backup tests: consent (redirects to the loopback port), tokens with PKCE checked
// and no app secret, the account call, and the app folder of each account. Used by test/backup-providers/dropbox-test.ts.
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import http from 'node:http'

export const A = { account_id: 'dbid:AAA', email: 'ana@dropbox.example', name: { display_name: 'Ana' } }
export const B = { account_id: 'dbid:BBB', email: 'bob@dropbox.example', name: { display_name: 'Bob' } }
export const KEY = 'app-key'

/** `state.next` is the account the next sign-in returns; `state.fail401` refuses that many file calls; `files` is account_id -> {data, modified}. */
export async function startDropboxMock() {
  const codes = new Map()
  const tokens = new Map()
  const files = new Map()
  const refreshes = new Map()
  const revoked = []
  const state = { next: A, fail401: 0 }
  const server = http.createServer(async (req, res) => {
    const u = new URL(req.url, 'http://x')
    const chunks = []
    for await (const c of req) chunks.push(c)
    const body = Buffer.concat(chunks)
    const send = (code, json, headers = {}) => res.writeHead(code, { 'content-type': 'application/json', ...headers }).end(JSON.stringify(json))
    if (u.pathname === '/oauth2/authorize') {
      const q = u.searchParams
      assert.equal(q.get('client_id'), KEY)
      assert.equal(q.get('response_type'), 'code')
      assert.equal(q.get('token_access_type'), 'offline')
      assert.equal(q.get('code_challenge_method'), 'S256')
      assert.equal(q.get('redirect_uri'), 'http://127.0.0.1:53682/', 'Dropbox needs the registered redirect exactly')
      assert.match(q.get('scope'), /files\.content\.write/)
      const code = randomUUID()
      codes.set(code, { acct: state.next, challenge: q.get('code_challenge'), redirect: q.get('redirect_uri') })
      return void res.writeHead(302, { location: `${q.get('redirect_uri')}?code=${code}&state=${q.get('state')}` }).end()
    }
    if (u.pathname === '/oauth2/token') {
      const f = new URLSearchParams(body.toString())
      assert.equal(f.get('client_id'), KEY)
      assert.equal(f.get('client_secret'), null, 'a public client sends no secret')
      if (f.get('grant_type') === 'authorization_code') {
        const c = codes.get(f.get('code'))
        if (!c || createHash('sha256').update(f.get('code_verifier')).digest('base64url') !== c.challenge || f.get('redirect_uri') !== c.redirect) return send(400, { error: 'invalid_grant' })
        codes.delete(f.get('code'))
        const access = `at-${randomUUID()}`
        const refresh = `rt-${randomUUID()}`
        tokens.set(access, { acct: c.acct, refresh })
        refreshes.set(refresh, c.acct)
        return send(200, { access_token: access, refresh_token: refresh, expires_in: 14400, token_type: 'bearer', account_id: c.acct.account_id })
      }
      const refresh = f.get('refresh_token') || ''
      const acct = refreshes.get(refresh)
      if (!acct) return send(400, { error: 'invalid_grant' })
      const access = `at-${randomUUID()}`
      tokens.set(access, { acct, refresh })
      return send(200, { access_token: access, expires_in: 14400, token_type: 'bearer' })
    }
    const auth = (req.headers.authorization || '').replace('Bearer ', '')
    const session = tokens.get(auth)
    const acct = session?.acct
    if (!acct || (state.fail401 > 0 && u.pathname.startsWith('/2/files/') && state.fail401--)) return send(401, { error_summary: 'expired_access_token/', error: { '.tag': 'expired_access_token' } })
    if (u.pathname === '/2/auth/token/revoke') {
      // the refresh token behind this access token dies with it
      refreshes.delete(session.refresh)
      revoked.push(session.refresh)
      tokens.delete(auth)
      return send(200, {})
    }
    if (u.pathname === '/2/users/get_current_account') {
      assert.equal(req.headers['content-type'], undefined, 'this call takes no argument')
      assert.equal(body.length, 0)
      return send(200, acct)
    }
    const mine = files.get(acct.account_id)
    const meta = (f) => ({ '.tag': 'file', name: 'jolty-backup.enc', path_lower: '/jolty-backup.enc', size: f.data.length, server_modified: f.modified })
    const missing = () => send(409, { error_summary: 'path/not_found/..', error: { '.tag': 'path', path: { '.tag': 'not_found' } } })
    if (u.pathname === '/2/files/get_metadata') {
      assert.equal(req.headers['content-type'], 'application/json')
      assert.equal(JSON.parse(body.toString()).path, '/jolty-backup.enc')
      return mine ? send(200, meta(mine)) : missing()
    }
    if (u.pathname === '/2/files/upload') {
      const arg = JSON.parse(req.headers['dropbox-api-arg'])
      assert.equal(arg.path, '/jolty-backup.enc')
      assert.equal(arg.mode, 'overwrite')
      assert.equal(req.headers['content-type'], 'application/octet-stream')
      const f = { data: body, modified: new Date().toISOString().replace(/\.\d+Z$/, 'Z') }
      files.set(acct.account_id, f)
      return send(200, meta(f))
    }
    if (u.pathname === '/2/files/download') {
      assert.equal(JSON.parse(req.headers['dropbox-api-arg']).path, '/jolty-backup.enc')
      return mine ? void res.writeHead(200, { 'content-type': 'application/octet-stream', 'dropbox-api-result': JSON.stringify(meta(mine)) }).end(mine.data) : missing()
    }
    send(404, {})
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  return { server, files, state, revoked, url: `http://127.0.0.1:${server.address().port}` }
}
