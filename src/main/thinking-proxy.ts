// Claude Code leaves `thinking` out when it is off, but some providers (DeepSeek) think unless told
// otherwise. For a chat with thinking "off", the endpoint is reached through this local relay, which
// adds `thinking: disabled` and drops `output_config`. Bound to 127.0.0.1 and used only for such chats.
import http from 'http'
import https from 'https'

const relays = new Map<string, Promise<string>>()

/** A local URL that forwards to `upstream` with thinking turned off in every messages request. */
export function noThinkingUrl(upstream: string): Promise<string> {
  let url = relays.get(upstream)
  if (!url) {
    url = start(upstream)
    relays.set(upstream, url)
  }
  return url
}

function start(upstream: string): Promise<string> {
  const target = new URL(upstream)
  const lib = target.protocol === 'https:' ? https : http
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      let body = Buffer.concat(chunks)
      if (req.method === 'POST' && /\/v1\/messages(\?|$)/.test(req.url || '')) {
        try {
          const json = JSON.parse(body.toString('utf8'))
          json.thinking = { type: 'disabled' }
          delete json.output_config
          body = Buffer.from(JSON.stringify(json))
        } catch {
          // not JSON: forwarded untouched
        }
      }
      const headers = { ...req.headers, host: target.host, 'content-length': String(body.length) }
      const out = lib.request(
        { protocol: target.protocol, hostname: target.hostname, port: target.port, method: req.method, path: target.pathname.replace(/\/$/, '') + (req.url || ''), headers },
        (up) => {
          res.writeHead(up.statusCode || 502, up.headers)
          up.pipe(res)
        }
      )
      out.on('error', () => {
        if (!res.headersSent) res.writeHead(502)
        res.end()
      })
      res.on('close', () => out.destroy())
      out.end(body)
    })
  })
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.unref()
      resolve(`http://127.0.0.1:${(server.address() as { port: number }).port}`)
    })
  })
}
