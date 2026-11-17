// A bad phone line between a test browser and Jolty's phone server: a TCP proxy with a bandwidth cap per direction
// (shared by every connection, as one radio link is), a fixed delay each way, random segment loss paid as a
// retransmission wait (TCP head-of-line blocking), and cuts (every connection dropped, new ones refused for a while).
// It also counts what crosses it: bytes each way, connections, HTTP requests by path, WebSocket bytes.
import net from 'node:net'

const SEGMENT = 1460

/** profile: { kbps, rttMs, loss } (loss 0..1); null kbps = unlimited */
export function shaper(upstreamPort, profile) {
  let p = { kbps: null, rttMs: 0, loss: 0, ...profile }
  const sockets = new Set()
  let downUntil = 0
  const stats = () => ({ down: 0, up: 0, wsDown: 0, wsUp: 0, conns: 0, requests: [] })
  let s = stats()
  // per direction: when the link is free again (ms since epoch)
  const free = { down: 0, up: 0 }

  function pace(dir, len) {
    const now = Date.now()
    let t = Math.max(now, free[dir])
    if (p.kbps) t += (len * 8) / p.kbps
    // each lost segment stalls the stream for a retransmission timeout
    if (p.loss > 0) {
      const segs = Math.ceil(len / SEGMENT)
      for (let i = 0; i < segs; i++) if (Math.random() < p.loss) t += Math.max(200, p.rttMs * 1.5)
    }
    free[dir] = t
    return t - now + p.rttMs / 2
  }

  function relay(from, to, dir, conn) {
    let chain = Promise.resolve()
    from.on('data', (chunk) => {
      if (dir === 'up') {
        const head = /^(GET|POST|HEAD) (\S+) HTTP/.exec(chunk.toString('latin1', 0, Math.min(chunk.length, 300)))
        if (head) {
          s.requests.push(head[2])
          if (head[2] === '/ws') conn.ws = true
        }
      }
      s[dir] += chunk.length
      if (conn.ws) s[dir === 'up' ? 'wsUp' : 'wsDown'] += chunk.length
      const wait = pace(dir, chunk.length)
      // delivery keeps the order of the stream
      const at = Date.now() + wait
      chain = chain.then(() => new Promise((r) => setTimeout(r, Math.max(0, at - Date.now())))).then(() => {
        if (!to.destroyed) to.write(chunk)
      })
    })
    from.on('end', () => void chain.then(() => to.end()))
    from.on('error', () => to.destroy())
    from.on('close', () => void chain.then(() => to.destroy()))
  }

  const server = net.createServer((client) => {
    if (Date.now() < downUntil) return client.destroy()
    s.conns++
    const conn = { ws: false }
    const up = net.connect(upstreamPort, '127.0.0.1')
    sockets.add(client)
    sockets.add(up)
    client.on('close', () => sockets.delete(client))
    up.on('close', () => sockets.delete(up))
    relay(client, up, 'up', conn)
    relay(up, client, 'down', conn)
  })

  return {
    listen: (port) => new Promise((r) => server.listen(port, '127.0.0.1', r)),
    set(profile2) {
      p = { kbps: null, rttMs: 0, loss: 0, ...profile2 }
    },
    reset() {
      const out = s
      s = stats()
      return out
    },
    peek: () => s,
    /** drops every open connection; new ones are refused for `ms` (a tunnel, a Wi-Fi to cellular switch) */
    cut(ms = 0) {
      downUntil = Date.now() + ms
      for (const x of sockets) x.destroy()
    },
    close: () =>
      new Promise((r) => {
        for (const x of sockets) x.destroy()
        server.close(r)
      })
  }
}

/** A noisy PNG of about the size of a real screenshot (no image libraries needed). */
import zlib from 'node:zlib'
export function noisyPng(w = 1600, h = 1000, seed = 1) {
  let x = seed
  const rnd = () => ((x = (x * 1103515245 + 12345) & 0x7fffffff), x & 255)
  const raw = Buffer.alloc((w * 3 + 1) * h)
  for (let y = 0; y < h; y++) {
    const o = y * (w * 3 + 1)
    raw[o] = 0
    for (let i = 0; i < w; i++) {
      const n = rnd() >> 3
      raw[o + 1 + i * 3] = (i * 255) / w + n
      raw[o + 2 + i * 3] = (y * 255) / h + n
      raw[o + 3 + i * 3] = 120 + n
    }
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4)
    len.writeUInt32BE(data.length)
    const td = Buffer.concat([Buffer.from(type, 'latin1'), data])
    const crc = Buffer.alloc(4)
    crc.writeUInt32BE(zlib.crc32(td))
    return Buffer.concat([len, td, crc])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0)
  ihdr.writeUInt32BE(h, 4)
  ihdr[8] = 8
  ihdr[9] = 2
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 6 })), chunk('IEND', Buffer.alloc(0))])
}
