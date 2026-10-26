// Just enough of the GitHub REST API for the backup tests: two users with a token each, a private repo each (plus a
// public one and one the token cannot write to), and the contents/commits endpoints Jolty uses.
// Used by test/backup-providers/github-test.ts.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import http from 'node:http'

export const A = { id: 101, login: 'ana', token: 'github_pat_ana' }
export const B = { id: 202, login: 'bob', token: 'github_pat_bob' }

/** `state.conflicts` is how many of the next PUTs answer 409 (someone wrote in between); `repos` is full name lowercased -> repo. */
export async function startGithubMock() {
  const repo = (owner, priv = true, readOnly = false) => ({ owner, private: priv, readOnly, branches: new Map([['main', new Map()], ['dev', new Map()]]), defaultBranch: 'main' })
  const repos = new Map([
    ['ana/jolty-backup', repo('ana')],
    ['ana/public', repo('ana', false)],
    ['bob/jolty-backup', repo('bob')],
    ['bob/readonly', repo('bob', true, true)]
  ])
  const state = { conflicts: 0, puts: 0 }
  const blobSha = (data) => createHash('sha1').update(`blob ${data.length}\0`).update(data).digest('hex')

  const server = http.createServer(async (req, res) => {
    const u = new URL(req.url, 'http://x')
    const chunks = []
    for await (const c of req) chunks.push(c)
    const body = Buffer.concat(chunks)
    const send = (code, json) => res.writeHead(code, { 'content-type': 'application/json' }).end(JSON.stringify(json))
    assert.equal(req.headers['x-github-api-version'], '2022-11-28')
    assert.ok(req.headers['user-agent'])
    assert.match(req.headers.accept, /^application\/vnd\.github(\.raw)?\+json$/)
    const user = [A, B].find((x) => `Bearer ${x.token}` === req.headers.authorization)
    if (!user) return send(401, { message: 'Bad credentials' })
    if (u.pathname === '/user') return send(200, { id: user.id, login: user.login })

    const m = /^\/repos\/([^/]+)\/([^/]+)(\/.*)?$/.exec(u.pathname)
    const r = m && repos.get(`${m[1]}/${m[2]}`.toLowerCase())
    // a private repo of someone else looks like it does not exist
    if (!r || (r.private && r.owner !== user.login)) return send(404, { message: 'Not Found' })
    const rest = m[3] ?? ''
    if (rest === '') return send(200, { full_name: `${m[1]}/${m[2]}`, private: r.private, permissions: { push: r.owner === user.login && !r.readOnly, pull: true } })

    const branch = u.searchParams.get(rest.startsWith('/commits') ? 'sha' : 'ref') || r.defaultBranch
    const files = r.branches.get(branch)
    if (!files) return send(404, { message: 'No commit found for the ref' })
    if (rest === '/commits') {
      const f = files.get(u.searchParams.get('path'))
      assert.equal(u.searchParams.get('per_page'), '1')
      return send(200, f ? [{ commit: { committer: { date: f.date } } }] : [])
    }
    const file = /^\/contents\/(.+)$/.exec(rest)?.[1]
    if (!file) return send(404, {})

    if (req.method === 'GET') {
      const f = files.get(file)
      if (!f) return send(404, { message: 'Not Found' })
      if (req.headers.accept === 'application/vnd.github.raw+json') return void res.writeHead(200, { 'content-type': 'application/vnd.github.raw+json' }).end(f.data)
      // like the real API above 1 MB: metadata only, empty content
      return send(200, { type: 'file', name: file, path: file, sha: f.sha, size: f.data.length, content: '', encoding: 'none' })
    }
    if (req.method === 'PUT') {
      assert.equal(r.owner, user.login)
      const p = JSON.parse(body.toString())
      assert.ok(p.message && typeof p.content === 'string')
      state.puts++
      if (state.conflicts > 0) {
        state.conflicts--
        return send(409, { message: 'is at abc but expected def' })
      }
      const target = r.branches.get(p.branch || r.defaultBranch)
      if (!target) return send(404, {})
      const old = target.get(file)
      if (old && p.sha !== old.sha) return send(409, { message: `${file} does not match ${old.sha}` })
      if (!old && p.sha) return send(422, { message: 'Invalid request. "sha" wasn\'t supplied.' })
      const data = Buffer.from(p.content, 'base64')
      target.set(file, { data, sha: blobSha(data), date: new Date().toISOString() })
      return send(old ? 200 : 201, { content: { sha: blobSha(data) } })
    }
    send(404, {})
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  return { server, repos, state, url: `http://127.0.0.1:${server.address().port}` }
}
