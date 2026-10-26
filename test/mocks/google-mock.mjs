// Just enough of Google for the backup tests: consent (redirects to the loopback port), tokens with PKCE checked,
// userinfo, and the Drive app folder of each account. Used by test/google-backup-test.ts and test/account-ui.mjs.
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import http from 'node:http'

export const A = { sub: '111', email: 'ana@gmail.example', name: 'Ana' }
export const B = { sub: '222', email: 'bob@gmail.example', name: 'Bob' }

/** `state.next` is the account the next sign-in returns; `state.fail401` refuses that many Drive calls; `drive` is sub -> {id, data, modified}. */
export async function startGoogleMock() {
  const codes = new Map()
  const tokens = new Map()
  const drive = new Map()
  const sessions = new Map()
  const state = { next: A, fail401: 0 }
  const server = http.createServer(async (req, res) => {
    const u = new URL(req.url, 'http://x')
    const chunks = []
    for await (const c of req) chunks.push(c)
    const body = Buffer.concat(chunks)
    const send = (code, json) => res.writeHead(code, { 'content-type': 'application/json' }).end(JSON.stringify(json))
    if (u.pathname === '/auth') {
      const code = randomUUID()
      codes.set(code, { acct: state.next, challenge: u.searchParams.get('code_challenge'), redirect: u.searchParams.get('redirect_uri') })
      assert.equal(u.searchParams.get('code_challenge_method'), 'S256')
      assert.match(u.searchParams.get('scope'), /drive\.appdata/)
      return void res.writeHead(302, { location: `${u.searchParams.get('redirect_uri').replace(/\/?$/, '/')}?code=${code}&state=${u.searchParams.get('state')}` }).end()
    }
    if (u.pathname === '/token') {
      const f = new URLSearchParams(body.toString())
      assert.equal(f.get('client_secret'), 'sec')
      if (f.get('grant_type') === 'authorization_code') {
        const c = codes.get(f.get('code'))
        if (!c || createHash('sha256').update(f.get('code_verifier')).digest('base64url') !== c.challenge || f.get('redirect_uri') !== c.redirect) return send(400, { error: 'invalid_grant' })
        codes.delete(f.get('code'))
        const access = `at-${randomUUID()}`
        tokens.set(access, c.acct)
        return send(200, { access_token: access, refresh_token: `rt-${c.acct.sub}`, expires_in: 3600 })
      }
      const m = /^rt-(.+)$/.exec(f.get('refresh_token') || '')
      const acct = [A, B].find((x) => x.sub === m?.[1])
      if (!acct) return send(400, { error: 'invalid_grant' })
      const access = `at-${randomUUID()}`
      tokens.set(access, acct)
      return send(200, { access_token: access, expires_in: 3600 })
    }
    if (u.pathname === '/revoke') return send(200, {})
    const acct = tokens.get((req.headers.authorization || '').replace('Bearer ', ''))
    if (!acct || (state.fail401 > 0 && u.pathname.startsWith('/drive') && state.fail401--)) return send(401, { error: 'unauth' })
    if (u.pathname === '/userinfo') return send(200, acct)
    const mine = () => drive.get(acct.sub)
    if (u.pathname === '/drive/v3/files' && req.method === 'GET') {
      assert.equal(u.searchParams.get('spaces'), 'appDataFolder')
      const f = mine()
      return send(200, { files: f ? [{ id: f.id, modifiedTime: f.modified, size: String(f.data.length) }] : [] })
    }
    if (u.pathname.startsWith('/drive/v3/files/') && u.searchParams.get('alt') === 'media') {
      const f = mine()
      if (!f || f.id !== u.pathname.split('/').pop()) return send(404, {})
      return void res.writeHead(200).end(f.data)
    }
    if (u.pathname.startsWith('/upload/drive/v3/files') && u.searchParams.get('uploadType') === 'resumable') {
      const id = u.pathname.split('/')[5]
      if (req.method === 'POST') assert.deepEqual(JSON.parse(body.toString()).parents, ['appDataFolder'])
      if (req.method === 'PATCH') assert.equal(id, mine()?.id)
      const session = randomUUID()
      sessions.set(session, { sub: acct.sub, id })
      return void res.writeHead(200, { location: `http://127.0.0.1:${server.address().port}/session/${session}` }).end()
    }
    if (u.pathname.startsWith('/session/') && req.method === 'PUT') {
      const s = sessions.get(u.pathname.split('/')[2])
      assert.equal(s.sub, acct.sub)
      drive.set(s.sub, { id: s.id || `file-${s.sub}`, data: body, modified: new Date().toISOString() })
      return send(200, {})
    }
    send(404, {})
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  return { server, drive, state, url: `http://127.0.0.1:${server.address().port}` }
}
