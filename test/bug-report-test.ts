import assert from 'node:assert/strict'
import http from 'node:http'
import { test } from 'node:test'

test('the report is posted as JSON to the endpoint, and a refusal is an error', async () => {
  const seen: { body: string; type: string }[] = []
  let status = 200
  const server = http.createServer((req, res) => {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      seen.push({ body, type: String(req.headers['content-type']) })
      res.writeHead(status).end('{}')
    })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  process.env.JOLTY_BUG_URL = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/jolty-bug`
  const { sendBugReport } = await import('../src/main/bug-report')

  await sendBugReport('The chat froze when I switched models', 'Jolty 1.0 | Windows NT 10.0 | ro')
  assert.equal(seen[0].type, 'application/json')
  assert.deepEqual(JSON.parse(seen[0].body), { message: 'The chat froze when I switched models', facts: 'Jolty 1.0 | Windows NT 10.0 | ro' })

  await assert.rejects(sendBugReport('too short', ''), /invalid/)
  assert.equal(seen.length, 1, 'an invalid report never leaves the PC')

  status = 429
  await assert.rejects(sendBugReport('A long enough description of the problem', ''), /429/)
  server.close()
})
