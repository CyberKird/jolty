// The PC screen stream over bad networks, for real: RemoteScreen behind a ws server, a phone client that answers with the
// page's own code (remote/screen-feedback.ts), and test/link-shaper.ts in between. The encoder is a stand-in that makes
// exactly what it is configured for (worse than a real screen, which is mostly still). Measured on the phone: pictures
// per second, capture to arrival (both ends share this clock), and the queue in the middle of the link.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { WebSocket, WebSocketServer } from 'ws'
import type { DisplayInfo } from '../src/main/computer/geometry'
import { LADDER } from '../src/main/remote-screen-adapt'
import { RemoteScreen, type EncoderConfig, type ScreenClient, type ScreenVideo, type VideoChunk } from '../src/main/remote-screen'
import { BIN_VIDEO, Feedback, parseChunk } from '../src/renderer/src/remote/screen-feedback'
import { LinkShaper, type LinkProfile } from './link-shaper'

const display: DisplayInfo = { index: 0, id: 1, x: 0, y: 0, w: 1920, h: 1080, primary: true, scaleFactor: 1 }
const calm = () => [{ model: '', speed: 0, times: { idle: 1e9, user: 0, nice: 0, sys: 0, irq: 0 } }]

/** Makes chunks the size the step asks for, at its rate; a whole picture every gopSec and when asked. */
class FakeEncoder implements ScreenVideo {
  private onV: (c: VideoChunk) => void = () => undefined
  private timer?: NodeJS.Timeout
  private cfg?: EncoderConfig
  private key = true
  private lastKey = 0
  available = (): boolean => true
  onVideo(cb: (c: VideoChunk) => void): void {
    this.onV = cb
  }
  onAudio(): void {}
  async start(_d: DisplayInfo, o: { config: EncoderConfig }) {
    this.configure(o.config)
    return { codec: o.config.codec, width: o.config.width, height: o.config.height, audio: false }
  }
  configure(c: EncoderConfig): void {
    const resize = !this.cfg || this.cfg.width !== c.width
    this.cfg = c
    if (resize) this.key = true
    if (this.timer) clearInterval(this.timer)
    this.timer = setInterval(() => this.frame(), 1000 / c.fps)
  }
  private frame(): void {
    const c = this.cfg!
    const now = Date.now()
    const avg = c.bps / 8 / c.fps
    const key = this.key || c.keyOnly || now - this.lastKey > c.gopSec * 1000
    if (key) {
      this.key = false
      this.lastKey = now
    }
    this.onV({ key, ts: now * 1000, data: Buffer.alloc(Math.max(64, Math.round(key && !c.keyOnly ? avg * 6 : avg))) })
  }
  keyframe(): void {
    this.key = true
  }
  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
    this.cfg = undefined
  }
}

interface Phases {
  ms: number
  link: LinkProfile
}

async function run(phases: Phases[]) {
  const video = new FakeEncoder()
  const screen = new RemoteScreen({ displays: () => [display], cursor: () => ({ x: 10, y: 10 }), frame: async () => undefined }, async () => ({ play: async () => undefined }), () => true, () => undefined, video, { cpus: calm })
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 })
  await new Promise<void>((r) => wss.on('listening', () => r()))
  wss.on('connection', (ws) => {
    const client: ScreenClient = { id: 'phone', send: (m) => ws.send(JSON.stringify(m)), sendBinary: (b) => ws.send(b), backlog: () => ws.bufferedAmount }
    ws.on('message', (d, bin) => !bin && screen.handle(client, JSON.parse(String(d))))
    ws.on('close', () => screen.drop(client))
  })
  const shaper = new LinkShaper((wss.address() as { port: number }).port, phases[0].link)
  const port = await shaper.listen()
  const ws = new WebSocket(`ws://127.0.0.1:${port}`)
  ws.binaryType = 'arraybuffer'
  await new Promise((r) => ws.on('open', r))
  const fb = new Feedback((m) => ws.readyState === 1 && ws.send(JSON.stringify({ t: 'screen', ...m })), () => performance.now())
  const arrivals: Array<{ t: number; g2g: number }> = []
  const steps: Array<{ t: number; step: string }> = []
  const queue: Array<{ t: number; bytes: number }> = []
  const t0 = Date.now()
  ws.on('message', (d: ArrayBuffer | Buffer, bin: boolean) => {
    if (!bin) {
      const m = JSON.parse(String(d))
      if (m.op === 'net') steps.push({ t: Date.now() - t0, step: m.step })
      return
    }
    const buf = d instanceof ArrayBuffer ? d : d.buffer.slice(d.byteOffset, d.byteOffset + d.byteLength)
    const c = parseChunk(buf as ArrayBuffer)
    if (!c) return
    fb.got(c.seq, buf.byteLength, c.key)
    if (c.kind === BIN_VIDEO) {
      fb.decodedOne(1, 0)
      fb.drawnOne()
      arrivals.push({ t: Date.now() - t0, g2g: Date.now() - c.ts / 1000 })
    }
  })
  ws.send(JSON.stringify({ t: 'screen', op: 'start', video: true }))
  const sampler = setInterval(() => queue.push({ t: Date.now() - t0, bytes: shaper.queued().now }), 100)
  for (const p of phases) {
    shaper.link = p.link
    await new Promise((r) => setTimeout(r, p.ms))
  }
  clearInterval(sampler)
  fb.close()
  ws.close()
  screen.stopAll()
  video.stop()
  await shaper.close()
  await new Promise<void>((r) => wss.close(() => r()))
  return { arrivals, steps, queue }
}

const p95 = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b)
  return s.length ? s[Math.min(s.length - 1, Math.floor(s.length * 0.95))] : Infinity
}
const window = (r: Awaited<ReturnType<typeof run>>, from: number, to: number) => {
  const a = r.arrivals.filter((x) => x.t >= from && x.t < to)
  const q = r.queue.filter((x) => x.t >= from && x.t < to)
  return { fps: Math.round((a.length / ((to - from) / 1000)) * 10) / 10, p95: Math.round(p95(a.map((x) => x.g2g))), maxQueueKB: Math.round(Math.max(0, ...q.map((x) => x.bytes)) / 1000) }
}
const levelOf = (name: string): number => LADDER.findIndex((s) => s.name === name)
const results: Record<string, unknown> = {}

const PROFILES: Array<{ name: string; link: LinkProfile; ms: number; levels: [number, number]; p95: number; minFps: number }> = [
  { name: 'good 20 Mbit/s 20 ms', link: { kbps: 20_000, rttMs: 20 }, ms: 12_000, levels: [0, 0], p95: 150, minFps: 45 },
  { name: '4G 5 Mbit/s 80 ms', link: { kbps: 5000, rttMs: 80, jitterMs: 15 }, ms: 14_000, levels: [1, 3], p95: 600, minFps: 12 },
  { name: 'weak 300 kbit/s 400 ms', link: { kbps: 300, rttMs: 400 }, ms: 20_000, levels: [4, 6], p95: 1800, minFps: 2 },
  { name: 'awful 100 kbit/s 1200 ms', link: { kbps: 100, rttMs: 1200 }, ms: 30_000, levels: [6, 7], p95: 4500, minFps: 0.3 },
  { name: 'loss 5 % on 4G', link: { kbps: 5000, rttMs: 80, loss: 0.05 }, ms: 16_000, levels: [2, 6], p95: 900, minFps: 3 }
]

for (const p of PROFILES) {
  test(`over ${p.name}: the right step, bounded delay, no growing queue`, { timeout: p.ms + 20_000 }, async () => {
    const r = await run([{ ms: p.ms, link: p.link }])
    const late = window(r, p.ms - 5000, p.ms)
    const mid = window(r, p.ms / 2 - 2500, p.ms / 2 + 2500)
    const last = r.steps.at(-1)?.step ?? '?'
    results[p.name] = { step: last, ...late }
    const lv = levelOf(last)
    assert.ok(lv >= p.levels[0] && lv <= p.levels[1], `${p.name}: step ${last} (level ${lv}), expected ${p.levels.join('-')}`)
    assert.ok(late.p95 <= p.p95, `${p.name}: capture to phone p95 ${late.p95} ms <= ${p.p95}`)
    assert.ok(late.fps >= p.minFps, `${p.name}: ${late.fps} pictures/s >= ${p.minFps}`)
    // no backlog that grows: the end is not worse than the middle, and the queue in the link stays small
    assert.ok(late.p95 <= mid.p95 * 1.6 + 200, `${p.name}: latency not growing (${mid.p95} -> ${late.p95} ms)`)
    const queueSec = (late.maxQueueKB * 1000 * 8) / (p.link.kbps * 1000)
    assert.ok(queueSec <= 2.5, `${p.name}: queue at most ${queueSec.toFixed(2)} s of the link`)
  })
}

test('recovery: an awful link that turns good is back at 60 fps, from whole pictures, without a restart', { timeout: 80_000 }, async () => {
  const r = await run([
    { ms: 20_000, link: { kbps: 100, rttMs: 1200 } },
    { ms: 30_000, link: { kbps: 20_000, rttMs: 20 } }
  ])
  const top = r.steps.find((s) => s.t > 20_000 && s.step === LADDER[0].name)
  assert.ok(top, 'reached 60/1080p again')
  const end = window(r, 45_000, 50_000)
  results.recovery = { secondsToTop: Math.round((top!.t - 20_000) / 100) / 10, ...end }
  assert.ok(top!.t - 20_000 <= 25_000, `back at the top after ${(top!.t - 20_000) / 1000} s`)
  assert.ok(end.fps >= 45 && end.p95 <= 150, `streaming at the top (${end.fps} fps, p95 ${end.p95} ms)`)
})

test('measured numbers', () => {
  console.log('LINK ' + JSON.stringify(results))
})
