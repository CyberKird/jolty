// A bad network in a box: a TCP proxy that carries bytes at a set rate, with a set round trip, jitter, loss and cuts.
// It reads from each side as fast as it can (the worst bufferbloat: an unbounded queue in the middle), so a sender that
// trusts its socket buffer would pile seconds of data into it; only acks tell the truth. Loss is the way TCP shows it to
// an application: a lost segment is resent (usually after one round trip, sometimes after a timeout) and everything
// behind it waits.
import net from 'node:net'

export interface LinkProfile {
  kbps: number
  rttMs: number
  /** extra random delay per segment, ms (order is kept) */
  jitterMs?: number
  /** share of segments lost */
  loss?: number
  /** the link carries nothing for `down` ms every `every` ms */
  flap?: { every: number; down: number }
}

const MSS = 1460

interface Seg {
  data: Buffer
  holdUntil: number
}

class Pipe {
  private queue: Seg[] = []
  private flying: Array<{ at: number; data: Buffer }> = []
  private lastAt = 0
  private credit = 0
  queuedBytes = 0
  maxQueuedBytes = 0

  constructor(private out: net.Socket, private link: () => LinkProfile, private rnd: () => number) {}

  push(d: Buffer): void {
    for (let i = 0; i < d.length; i += MSS) {
      const data = d.subarray(i, i + MSS)
      this.queue.push({ data, holdUntil: 0 })
      this.queuedBytes += data.length
    }
    this.maxQueuedBytes = Math.max(this.maxQueuedBytes, this.queuedBytes)
  }

  step(now: number, dt: number, cut: boolean): void {
    const l = this.link()
    if (!cut) {
      this.credit = Math.min(this.credit + (l.kbps * 1000 * dt) / 8 / 1000, MSS * 4 + (l.kbps * 1000) / 8 / 50)
      while (this.queue.length && this.credit >= Math.min(MSS, this.queue[0].data.length)) {
        const s = this.queue[0]
        if (s.holdUntil > now) break
        if (s.holdUntil === 0 && l.loss && this.rnd() < l.loss) {
          s.holdUntil = now + (this.rnd() < 0.8 ? l.rttMs : Math.max(200, l.rttMs * 1.5))
          break
        }
        this.queue.shift()
        this.queuedBytes -= s.data.length
        this.credit -= s.data.length
        const at = Math.max(this.lastAt, now + l.rttMs / 2 + (l.jitterMs ? this.rnd() * l.jitterMs : 0))
        this.lastAt = at
        this.flying.push({ at, data: s.data })
      }
    } else this.credit = 0
    while (this.flying.length && this.flying[0].at <= now && !cut) {
      const f = this.flying.shift()!
      if (!this.out.destroyed) this.out.write(f.data)
    }
  }
}

export class LinkShaper {
  private server: net.Server
  private pipes: Pipe[] = []
  private sockets: net.Socket[] = []
  private timer?: NodeJS.Timeout
  private t0 = performance.now()
  private last = performance.now()
  private seed = 7
  link: LinkProfile

  constructor(private target: number, link: LinkProfile) {
    this.link = link
    this.server = net.createServer((client) => {
      const upstream = net.connect(this.target, '127.0.0.1')
      client.setNoDelay(true)
      upstream.setNoDelay(true)
      const down = new Pipe(client, () => this.link, () => this.random())
      const up = new Pipe(upstream, () => this.link, () => this.random())
      this.pipes.push(down, up)
      this.sockets.push(client, upstream)
      upstream.on('data', (d) => down.push(d))
      client.on('data', (d) => up.push(d))
      const end = (): void => {
        client.destroy()
        upstream.destroy()
      }
      client.on('close', end)
      upstream.on('close', end)
      client.on('error', end)
      upstream.on('error', end)
    })
  }

  private random(): number {
    this.seed = (this.seed * 1103515245 + 12345) % 2 ** 31
    return this.seed / 2 ** 31
  }

  async listen(): Promise<number> {
    await new Promise<void>((r) => this.server.listen(0, '127.0.0.1', r))
    this.timer = setInterval(() => {
      const now = performance.now()
      const dt = now - this.last
      this.last = now
      const f = this.link.flap
      const cut = f ? (now - this.t0) % f.every < f.down : false
      for (const p of this.pipes) p.step(now, dt, cut)
    }, 1)
    return (this.server.address() as net.AddressInfo).port
  }

  /** bytes waiting in the middle toward the phone, now and at most since the last reset */
  queued(): { now: number; max: number } {
    const down = this.pipes.filter((_, i) => i % 2 === 0)
    return { now: down.reduce((n, p) => n + p.queuedBytes, 0), max: Math.max(0, ...down.map((p) => p.maxQueuedBytes)) }
  }

  resetMax(): void {
    for (const p of this.pipes) p.maxQueuedBytes = p.queuedBytes
  }

  async close(): Promise<void> {
    if (this.timer) clearInterval(this.timer)
    for (const s of this.sockets) s.destroy()
    await new Promise<void>((r) => this.server.close(() => r()))
  }
}
