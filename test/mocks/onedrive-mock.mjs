// Just enough of Microsoft (login + Graph) for the backup tests: consent (redirects to http://localhost, which the
// browser would resolve to the loopback), tokens with PKCE checked, no app secret and a refresh token that rotates, /me,
// and the app folder of each account. Used by test/backup-providers/onedrive-test.ts.
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import http from 'node:http'

export const A = { id: 'ms-aaa', mail: 'ana@outlook.example', userPrincipalName: 'ana@outlook.example', displayName: 'Ana' }
// a personal account without `mail`: the label falls back to userPrincipalName
export const B = { id: 'ms-bbb', mail: null, userPrincipalName: 'bob@live.example', displayName: 'Bob' }
export const CLIENT = 'client-guid'
const APP = '/v1.0/me/drive/special/approot:/jolty-backup.enc'

/** `state.next` is the account the next sign-in returns; `state.fail401` refuses that many Graph file calls; `files` is id -> {data, modified}. */
export async function startOneDriveMock() {
  const codes = new Map()
  const tokens = new Map()
  const refreshes = new Map()
  const files = new Map()
  const state = { next: A, fail401: 0, downloadAuth: /** @type {(string|undefined)[]} */ ([]) }
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
      return { access_token: access, refresh_token: refresh, expires_in: 3599, token_type: 'Bearer', scope: 'Files.ReadWrite.AppFolder User.Read' }
    }
    if (u.pathname === '/common/oauth2/v2.0/authorize') {
      const q = u.searchParams
      assert.equal(q.get('client_id'), CLIENT)
      assert.equal(q.get('response_type'), 'code')
      assert.equal(q.get('code_challenge_method'), 'S256')
      assert.match(q.get('scope'), /offline_access/)
      assert.match(q.get('scope'), /Files\.ReadWrite\.AppFolder/)
      const redirect = q.get('redirect_uri')
      assert.match(redirect, /^http:\/\/localhost:\d+\/$/, 'Microsoft wants http://localhost for desktop apps')
      const code = randomUUID()
      codes.set(code, { acct: state.next, challenge: q.get('code_challenge'), redirect })
      // the test is the browser and resolves localhost to the loopback the app listens on
      return void res.writeHead(302, { location: `${redirect.replace('localhost', '127.0.0.1')}?code=${code}&state=${q.get('state')}` }).end()
    }
    if (u.pathname === '/common/oauth2/v2.0/token') {
      const f = new URLSearchParams(body.toString())
      assert.equal(f.get('client_id'), CLIENT)
      assert.equal(f.get('client_secret'), null, 'a public client sends no secret')
      if (f.get('grant_type') === 'authorization_code') {
        const c = codes.get(f.get('code'))
        if (!c || createHash('sha256').update(f.get('code_verifier')).digest('base64url') !== c.challenge || f.get('redirect_uri') !== c.redirect) return send(400, { error: 'invalid_grant' })
        codes.delete(f.get('code'))
        return send(200, issue(c.acct))
      }
      const acct = refreshes.get(f.get('refresh_token'))
      if (!acct) return send(400, { error: 'invalid_grant' })
      // Microsoft hands out a new refresh token with every refresh and discards the old one
      refreshes.delete(f.get('refresh_token'))
      return send(200, issue(acct))
    }
    if (u.pathname.startsWith('/dl/')) {
      state.downloadAuth.push(req.headers.authorization)
      const f = [...files.values()].find((x) => x.id === u.pathname.split('/')[2])
      return f ? void res.writeHead(200).end(f.data) : send(404, {})
    }
    const acct = tokens.get((req.headers.authorization || '').replace('Bearer ', ''))
    if (!acct || (state.fail401 > 0 && u.pathname.startsWith(APP) && state.fail401--)) return send(401, { error: { code: 'InvalidAuthenticationToken' } })
    if (u.pathname === '/v1.0/me') return send(200, acct)
    const mine = files.get(acct.id)
    const item = (f) => ({ id: f.id, name: 'jolty-backup.enc', size: f.data.length, lastModifiedDateTime: f.modified })
    if (u.pathname === APP && req.method === 'GET') return mine ? send(200, item(mine)) : send(404, { error: { code: 'itemNotFound' } })
    if (u.pathname === `${APP}:/content` && req.method === 'PUT') {
      assert.match(req.headers['content-type'], /octet-stream/)
      const f = { id: mine?.id || `item-${randomUUID()}`, data: body, modified: new Date().toISOString() }
      files.set(acct.id, f)
      return send(mine ? 200 : 201, item(f))
    }
    if (u.pathname === `${APP}:/content` && req.method === 'GET') {
      return mine ? void res.writeHead(302, { location: `http://127.0.0.1:${server.address().port}/dl/${mine.id}` }).end() : send(404, { error: { code: 'itemNotFound' } })
    }
    send(404, {})
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  return { server, files, state, refreshes, url: `http://127.0.0.1:${server.address().port}` }
}
