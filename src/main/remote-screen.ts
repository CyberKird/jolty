// The PC's screen on a paired phone, with the phone's touches as mouse and keyboard on the PC.
// A phone that can decode video gets the screen as H.264 with sound (remote-video.ts encodes it on the PC's graphics chip);
// any other gets JPEG pictures. Input goes through the same native helper that computer use drives.
// Nothing here starts unless the user switched "screen from phone" on at the PC, and the kill key stops every viewer.
import crypto from 'crypto'
import type { DisplayInfo } from './computer/geometry'
import { parseCombo, type Ev } from './computer/plan'

/** What the screen is read from. The app brings Electron's desktopCapturer; tests bring a fake. */
export interface ScreenSource {
  displays(): DisplayInfo[]
  /** one picture of `display`, no wider or taller than `maxEdge` pixels */
  frame(display: DisplayInfo, maxEdge: number): Promise<{ jpeg: Buffer; width: number; height: number } | undefined>
  /** the pointer, in physical pixels of the desktop */
  cursor(): { x: number; y: number }
}

export interface ScreenInput {
  play(events: Ev[]): Promise<unknown>
}

export interface VideoChunk {
  key: boolean
  /** microseconds */
  ts: number
  data: Buffer
}

export interface VideoStart {
  codec: string
  width: number
  height: number
  /** the stream carries the PC's sound (Opus, 48 kHz) */
  audio: boolean
}

/** The screen as video: one encoder, on one display at a time, for every phone that can play it. */
export interface ScreenVideo {
  available(): boolean
  start(display: DisplayInfo, opts: { audio: boolean }): Promise<VideoStart>
  stop(): void
  /** the next picture is a whole one: a phone that lost some can start again from it */
  keyframe(): void
  bitrate(bps: number): void
  onVideo(cb: (c: VideoChunk) => void): void
  onAudio(cb: (c: { ts: number; data: Buffer }) => void): void
}

/** A connected phone, as far as the screen is concerned. */
export interface ScreenClient {
  id: string
  send(json: unknown): void
  sendBinary(data: Buffer): void
  /** bytes waiting to leave for this phone: a slow link must not make frames pile up */
  backlog(): number
}

// binary messages to the phone start with what they are
export const BIN_JPEG = 1
export const BIN_VIDEO = 2
export const BIN_AUDIO = 3

interface Viewer {
  client: ScreenClient
  display: number
  mode: 'jpeg' | 'video'
  wantsVideo: boolean
  wantsAudio: boolean
  /** a picture was dropped for this phone: it gets none until the next whole one */
  needKey: boolean
  /** JPEG: a frame was sent and the phone has not answered yet */
  waiting: boolean
  sentAt: number
  last: string
  /** JPEG: the phone's frames get smaller while its link is slow */
  edge: number
  lastCursor: string
}

const MIN_GAP = 70
const IDLE_GAP = 400
const MAX_EDGE = 1920
const MIN_EDGE = 960
const BUTTONS = new Set(['l', 'r', 'm'])
const START_BPS = 6_000_000
const MAX_BPS = 12_000_000
const MIN_BPS = 1_200_000
/** bytes waiting for one phone before pictures are dropped for it */
const BACKLOG_VIDEO = 450_000

const num = (v: unknown, lo: number, hi: number): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : undefined)

export class RemoteScreen {
  private viewers = new Map<string, Viewer>()
  private timer?: NodeJS.Timeout
  private busy = false
  private chain: Promise<unknown> = Promise.resolve()
  private pendingMove?: { x: number; y: number }
  /** the PC's input was used: only then is there anything to let go of */
  private touched = false
  /** the display the encoder is on, while it runs */
  private videoOn?: number
  private bps = START_BPS
  private drops = 0
  private calm = 0
  private adapt?: NodeJS.Timeout
  private cursors?: NodeJS.Timeout

  constructor(
    private source: ScreenSource,
    private input: () => Promise<ScreenInput>,
    private allowed: () => boolean,
    private onChange: () => void = () => undefined,
    private video?: ScreenVideo
  ) {
    video?.onVideo((c) => this.fanVideo(c))
    video?.onAudio((c) => this.fanAudio(c))
  }

  /** How many phones are looking at the screen now. */
  viewing(): number {
    return this.viewers.size
  }

  /** The kill key, "Stop" at the PC, switching the setting off: every phone loses the screen at once. */
  stopAll(reason = 'stopped'): void {
    for (const v of this.viewers.values()) v.client.send({ t: 'screen', op: 'ended', reason })
    this.viewers.clear()
    this.release()
    this.halt()
    this.settle()
    this.onChange()
  }

  drop(client: ScreenClient): void {
    if (!this.viewers.delete(client.id)) return
    this.release()
    if (!this.viewers.size) this.halt()
    this.settle()
    this.onChange()
  }

  handle(client: ScreenClient, m: Record<string, unknown>): void {
    const op = m.op
    if (op === 'start') return void this.start(client, num(m.display, 0, 64), m.video === true, m.audio === true)
    const viewer = this.viewers.get(client.id)
    if (!viewer) return
    if (!this.allowed()) return this.stopAll('off')
    switch (op) {
      case 'stop':
        return this.drop(client)
      case 'ack': {
        viewer.waiting = false
        // a quick answer lets the pictures grow back, a slow one makes them smaller
        const rtt = Date.now() - viewer.sentAt
        if (rtt > 450) viewer.edge = Math.max(MIN_EDGE, Math.round(viewer.edge * 0.85))
        else if (rtt < 150) viewer.edge = Math.min(MAX_EDGE, Math.round(viewer.edge * 1.06))
        return
      }
      case 'keyframe':
        // the phone's decoder lost its place: the next picture is a whole one
        viewer.needKey = true
        return this.video?.keyframe()
      case 'display': {
        const index = num(m.index, 0, 64)
        if (index === undefined || !this.source.displays()[index]) return
        viewer.display = index
        viewer.last = ''
        viewer.waiting = false
        if (!viewer.wantsVideo) return this.info(viewer)
        return void this.pick(viewer).then(() => this.info(viewer))
      }
      default:
        return this.act(viewer, m)
    }
  }

  private async start(client: ScreenClient, display?: number, video = false, audio = false): Promise<void> {
    if (!this.allowed()) return client.send({ t: 'screen', op: 'denied', reason: 'off' })
    const displays = this.source.displays()
    if (!displays.length) return client.send({ t: 'screen', op: 'denied', reason: 'none' })
    const primary = displays.findIndex((d) => d.primary)
    const viewer: Viewer = {
      client,
      display: display !== undefined && displays[display] ? display : Math.max(0, primary),
      mode: 'jpeg',
      wantsVideo: video && Boolean(this.video?.available()),
      wantsAudio: audio,
      needKey: false,
      waiting: false,
      sentAt: 0,
      last: '',
      edge: 1600,
      lastCursor: ''
    }
    this.viewers.set(client.id, viewer)
    this.onChange()
    // the picture mode is settled before the phone is told, so what it is told is true (a phone with no video needs no wait)
    if (viewer.wantsVideo) {
      await this.pick(viewer)
      if (this.viewers.get(client.id) !== viewer) return
    }
    this.info(viewer)
    this.kick()
  }

  /** Video when the phone can play it and the encoder is free or already on this display; JPEG otherwise. */
  private async pick(v: Viewer): Promise<void> {
    v.mode = 'jpeg'
    v.needKey = false
    if (!v.wantsVideo || !this.video) return this.settle()
    const others = [...this.viewers.values()].some((o) => o !== v && o.mode === 'video' && o.display !== v.display)
    if (others) return this.settle()
    try {
      if (this.videoOn !== v.display) {
        const d = this.source.displays()[v.display]
        this.started = await this.video.start(d, { audio: [...this.viewers.values()].some((o) => o.wantsAudio) })
        this.videoOn = v.display
        this.bps = START_BPS
        this.video.bitrate(this.bps)
        this.spin()
      }
      v.mode = 'video'
      v.needKey = true
      this.video.keyframe()
    } catch (e) {
      // no hardware encoder, or the capture was refused: this phone gets pictures instead
      v.mode = 'jpeg'
      v.client.send({ t: 'screen', op: 'warn', message: e instanceof Error ? e.message : String(e) })
    }
    this.settle()
  }

  private started?: VideoStart

  private info(v: Viewer): void {
    const displays = this.source.displays()
    const d = displays[v.display]
    v.client.send({
      t: 'screen',
      op: 'info',
      display: v.display,
      width: d.w,
      height: d.h,
      video: v.mode === 'video' && this.started ? { codec: this.started.codec, width: this.started.width, height: this.started.height, audio: this.started.audio && v.wantsAudio } : undefined,
      displays: displays.map((x, index) => ({ index, w: x.w, h: x.h, primary: x.primary, name: x.name || '' }))
    })
  }

  // ------------------------------------------------------------------ video

  private fanVideo(c: VideoChunk): void {
    const head = Buffer.alloc(10)
    head.writeUInt8(BIN_VIDEO, 0)
    head.writeUInt8(c.key ? 1 : 0, 1)
    head.writeDoubleLE(c.ts, 2)
    let out: Buffer | undefined
    for (const v of this.viewers.values()) {
      if (v.mode !== 'video' || v.display !== this.videoOn) continue
      // dropped for this phone: nothing until a whole picture, so what it decodes is never torn
      if (v.needKey && !c.key) continue
      if (!c.key && v.client.backlog() > BACKLOG_VIDEO) {
        v.needKey = true
        this.drops++
        this.video?.keyframe()
        continue
      }
      v.needKey = false
      out ??= Buffer.concat([head, c.data])
      v.client.sendBinary(out)
    }
  }

  private fanAudio(c: { ts: number; data: Buffer }): void {
    const head = Buffer.alloc(9)
    head.writeUInt8(BIN_AUDIO, 0)
    head.writeDoubleLE(c.ts, 1)
    let out: Buffer | undefined
    for (const v of this.viewers.values()) {
      if (v.mode !== 'video' || !v.wantsAudio || v.client.backlog() > BACKLOG_VIDEO * 2) continue
      out ??= Buffer.concat([head, c.data])
      v.client.sendBinary(out)
    }
  }

  /** The encoder runs while a phone watches in video, and its bitrate follows the link: down when a phone falls behind, up when it keeps up. */
  private spin(): void {
    if (!this.adapt) {
      this.adapt = setInterval(() => {
        if (this.drops > 0) {
          this.bps = Math.max(MIN_BPS, Math.round(this.bps * 0.7))
          this.video?.bitrate(this.bps)
          this.calm = 0
        } else if (++this.calm >= 4 && this.bps < MAX_BPS) {
          this.bps = Math.min(MAX_BPS, Math.round(this.bps * 1.12))
          this.video?.bitrate(this.bps)
        }
        this.drops = 0
      }, 1000)
    }
    if (!this.cursors) {
      // the pointer is not in the video: it travels beside it, and the phone draws it
      this.cursors = setInterval(() => {
        const cur = this.source.cursor()
        for (const v of this.viewers.values()) {
          if (v.mode !== 'video') continue
          const d = this.source.displays()[v.display]
          if (!d) continue
          const inside = cur.x >= d.x && cur.y >= d.y && cur.x < d.x + d.w && cur.y < d.y + d.h
          const x = inside ? (cur.x - d.x) / d.w : -1
          const y = inside ? (cur.y - d.y) / d.h : -1
          const key = `${x.toFixed(4)},${y.toFixed(4)}`
          if (key === v.lastCursor) continue
          v.lastCursor = key
          v.client.send({ t: 'screen', op: 'cursor', x, y })
        }
      }, 33)
    }
  }

  /** Stops the encoder and its timers when no phone watches in video any more. */
  private settle(): void {
    if ([...this.viewers.values()].some((v) => v.mode === 'video')) return
    if (this.videoOn !== undefined) this.video?.stop()
    this.videoOn = undefined
    if (this.adapt) clearInterval(this.adapt)
    if (this.cursors) clearInterval(this.cursors)
    this.adapt = this.cursors = undefined
  }

  // ------------------------------------------------------------------ JPEG frames

  private kick(): void {
    if (this.timer || ![...this.viewers.values()].some((v) => v.mode === 'jpeg')) return
    this.timer = setTimeout(() => void this.tick(), 0)
  }

  private halt(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = undefined
  }

  private async tick(): Promise<void> {
    this.timer = undefined
    if (this.busy) return
    const jpeg = [...this.viewers.values()].filter((v) => v.mode === 'jpeg')
    if (!jpeg.length) return
    this.busy = true
    let changed = false
    try {
      if (!this.allowed()) return this.stopAll('off')
      const wanted = new Map<number, Viewer[]>()
      for (const v of jpeg) {
        // a phone that has not taken the last picture, or whose link is backed up, waits
        if (v.waiting && Date.now() - v.sentAt < 4000) continue
        if (v.client.backlog() > 600_000) continue
        wanted.set(v.display, [...(wanted.get(v.display) || []), v])
      }
      for (const [index, list] of wanted) {
        const d = this.source.displays()[index]
        if (!d) continue
        // one capture per display, at the largest size any of its viewers takes
        const edge = Math.max(...list.map((v) => v.edge))
        const shot = await this.source.frame(d, edge)
        if (!shot) continue
        const hash = crypto.createHash('md5').update(shot.jpeg).digest('hex')
        const cur = this.source.cursor()
        const cx = Math.round(Math.min(1, Math.max(0, (cur.x - d.x) / d.w)) * 65534)
        const cy = Math.round(Math.min(1, Math.max(0, (cur.y - d.y) / d.h)) * 65534)
        const out = cur.x >= d.x && cur.y >= d.y && cur.x < d.x + d.w && cur.y < d.y + d.h
        for (const v of list) {
          // the cursor moves without the picture changing: the picture is only resent when it did, the cursor always rides along
          const same = hash === v.last
          if (same && !v.waiting) {
            v.client.send({ t: 'screen', op: 'cursor', x: out ? cx / 65534 : -1, y: out ? cy / 65534 : -1 })
            continue
          }
          if (same) continue
          v.last = hash
          v.waiting = true
          v.sentAt = Date.now()
          const head = Buffer.alloc(5)
          head.writeUInt8(BIN_JPEG, 0)
          head.writeUInt16LE(out ? cx : 65535, 1)
          head.writeUInt16LE(out ? cy : 65535, 3)
          v.client.sendBinary(Buffer.concat([head, shot.jpeg]))
          changed = true
        }
      }
    } catch (e) {
      // a locked or sleeping screen cannot be captured: say so once and keep trying
      for (const v of jpeg) v.client.send({ t: 'screen', op: 'warn', message: e instanceof Error ? e.message : String(e) })
    } finally {
      this.busy = false
      if ([...this.viewers.values()].some((v) => v.mode === 'jpeg')) this.timer = setTimeout(() => void this.tick(), changed ? MIN_GAP : IDLE_GAP)
    }
  }

  // ------------------------------------------------------------------ input

  private point(v: Viewer, m: Record<string, unknown>): { x: number; y: number } | undefined {
    const d = this.source.displays()[v.display]
    const nx = num(m.x, 0, 1)
    const ny = num(m.y, 0, 1)
    if (!d || nx === undefined || ny === undefined) return undefined
    return { x: Math.round(d.x + nx * (d.w - 1)), y: Math.round(d.y + ny * (d.h - 1)) }
  }

  private play(events: Ev[]): void {
    this.chain = this.chain.then(async () => (await this.input()).play(events)).catch(() => undefined)
  }

  private act(v: Viewer, m: Record<string, unknown>): void {
    const op = m.op
    this.touched = true
    const button = typeof m.button === 'string' && BUTTONS.has(m.button) ? (m.button as 'l' | 'r' | 'm') : 'l'
    switch (op) {
      case 'move': {
        const p = this.point(v, m)
        if (!p) return
        // moves arrive faster than the helper takes them: only the newest one waits its turn
        const queued = this.pendingMove
        this.pendingMove = p
        if (queued) return
        this.chain = this.chain.then(async () => {
          const at = this.pendingMove
          this.pendingMove = undefined
          if (at) await (await this.input()).play([['m', 0, at.x, at.y]])
        }).catch(() => undefined)
        return
      }
      case 'down':
      case 'up': {
        const p = this.point(v, m)
        this.play([...(p ? ([['m', 0, p.x, p.y]] as Ev[]) : []), ['b', p ? 6 : 0, button, op === 'down' ? 1 : 0]])
        return
      }
      case 'click': {
        const p = this.point(v, m)
        const count = Math.min(3, Math.max(1, Math.round(num(m.count, 1, 3) ?? 1)))
        const evs: Ev[] = p ? [['m', 0, p.x, p.y]] : []
        let t = p ? 8 : 0
        for (let i = 0; i < count; i++) {
          evs.push(['b', t, button, 1], ['b', t + 28, button, 0])
          t += 90
        }
        this.play(evs)
        return
      }
      case 'wheel': {
        const n = Math.round(num(m.notches, -40, 40) ?? 0)
        if (!n) return
        const evs: Ev[] = []
        for (let i = 0; i < Math.abs(n); i++) evs.push(['w', i * 6, n < 0 ? 120 : -120, m.horizontal === true ? 1 : 0])
        this.play(evs)
        return
      }
      case 'text': {
        const text = typeof m.text === 'string' ? m.text.slice(0, 2000) : ''
        if (!text) return
        const evs: Ev[] = []
        let t = 0
        for (const ch of text) {
          if (ch === '\n') evs.push(['k', t, 0x0d, 1, 0], ['k', t + 8, 0x0d, 0, 0])
          else if (ch === '\t') evs.push(['k', t, 0x09, 1, 0], ['k', t + 8, 0x09, 0, 0])
          else evs.push(['c', t, ch.codePointAt(0) as number, 8])
          t += 14
        }
        this.play(evs)
        return
      }
      case 'key': {
        let vks: number[]
        try {
          vks = parseCombo(typeof m.combo === 'string' ? m.combo : '')
        } catch {
          return
        }
        this.keys(vks)
        return
      }
    }
  }

  private keys(vks: number[]): void {
    const mods = new Set([0x10, 0x11, 0x12, 0x5b])
    const ext = new Set([0x21, 0x22, 0x23, 0x24, 0x25, 0x26, 0x27, 0x28, 0x2c, 0x2d, 0x2e, 0x5b, 0x5d, 0x90])
    const evs: Ev[] = []
    let t = 0
    for (const k of vks.filter((x) => mods.has(x))) (evs.push(['k', t, k, 1, ext.has(k) ? 1 : 0]), (t += 8))
    for (const k of vks.filter((x) => !mods.has(x))) (evs.push(['k', t, k, 1, ext.has(k) ? 1 : 0], ['k', t + 14, k, 0, ext.has(k) ? 1 : 0]), (t += 28))
    for (const k of vks.filter((x) => mods.has(x)).reverse()) (evs.push(['k', t, k, 0, ext.has(k) ? 1 : 0]), (t += 8))
    this.play(evs)
  }

  // ------------------------------------------------------------------ release

  /** Buttons held down by a phone that vanished must not stay down on the PC. */
  private release(): void {
    if (this.viewers.size || !this.touched) return
    this.touched = false
    this.pendingMove = undefined
    this.play([
      ['b', 0, 'l', 0],
      ['b', 0, 'r', 0],
      ['b', 0, 'm', 0],
      ...[0x11, 0x10, 0x12, 0x5b].map((k) => ['k', 0, k, 0, k === 0x5b ? 1 : 0] as Ev)
    ])
  }
}
