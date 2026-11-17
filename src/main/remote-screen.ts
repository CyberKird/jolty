// The PC's screen on a paired phone, with the phone's touches as mouse and keyboard on the PC.
// A phone that can decode video gets the screen as H.264 with sound (remote-video.ts / remote-ffmpeg.ts encode it on the
// PC's graphics chip); any other gets JPEG pictures. How much it gets follows its link and the phone itself, measured from
// the phone's answers (remote-screen-adapt.ts). Input goes through the same native helper that computer use drives.
// Nothing here starts unless the user switched "screen from phone" on at the PC, and the kill key stops every viewer.
import crypto from 'crypto'
import os from 'os'
import type { DisplayInfo } from './computer/geometry'
import type { Ev } from './computer/plan'
import { Adapt, LADDER, LoadWatch, type PhoneReport } from './remote-screen-adapt'
import { ANY_PHONE, avcCodecFor, avcLevel, capsFloor, commonProfile, parseCaps, type PhoneCaps, type Profile } from './remote-screen-caps'
import { ScreenInputs } from './remote-screen-input'

/** What the screen is read from. The app brings Electron's desktopCapturer; tests bring a fake. */
export interface ScreenSource {
  displays(): DisplayInfo[]
  /** one picture of `display`, no wider or taller than `maxEdge` pixels, at JPEG `quality` (0-100) */
  frame(display: DisplayInfo, maxEdge: number, quality?: number): Promise<{ jpeg: Buffer; width: number; height: number } | undefined>
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

/** What the encoder is asked to make; it changes while it runs, as the link changes. */
export interface EncoderConfig {
  width: number
  height: number
  fps: number
  bps: number
  gopSec: number
  /** every picture whole (the slideshow floor) */
  keyOnly: boolean
  /** H.264 profile every watching phone decodes, the level for this size and rate ("4.2"), and both as a codec string */
  profile: Profile
  level: string
  codec: string
}

/** The screen as video: one encoder, on one display at a time, for every phone that can play it. */
export interface ScreenVideo {
  available(): boolean
  start(display: DisplayInfo, opts: { audio: boolean; config: EncoderConfig }): Promise<VideoStart>
  stop(): void
  /** the next picture is a whole one: a phone that lost some can start again from it */
  keyframe(): void
  configure(c: EncoderConfig): void
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

// binary messages to the phone start with what they are, and each carries a number the phone answers with (ack)
//   video: [2][flags: 1 = whole picture][timestamp f64 LE, microseconds][seq u32 LE] data      (14 byte head)
//   sound: [3][timestamp f64 LE][seq u32 LE] data                                              (13 byte head)
//   JPEG:  [1][cursor x u16][cursor y u16][seq u32 LE] data   (65535 = pointer elsewhere)      (9 byte head)
export const BIN_JPEG = 1
export const BIN_VIDEO = 2
export const BIN_AUDIO = 3
export const HEAD_VIDEO = 14
export const HEAD_AUDIO = 13
export const HEAD_JPEG = 9

interface Viewer {
  client: ScreenClient
  display: number
  mode: 'jpeg' | 'video'
  wantsVideo: boolean
  wantsAudio: boolean
  /** a picture was dropped for this phone: it gets none until the next whole one */
  needKey: boolean
  adapt: Adapt
  seq: number
  last: string
  lastCursor: string
  cursorAt: number
  /** what the phone decodes (undefined: an older page, taken to play anything) */
  caps?: PhoneCaps
}

export interface RemoteScreenOptions {
  /** the PC's processor times (os.cpus()); tests pass a calm machine */
  cpus?: () => ReturnType<typeof os.cpus>
  /** how often the link is judged, ms */
  tickMs?: number
  /** the step a new phone starts at (tests) */
  startLevel?: number
}

const MIN_GAP = 70
const IDLE_GAP = 400
const MAX_EDGE = 1920
/** bytes waiting in the socket itself before pictures are dropped, whatever the acks say */
const BACKLOG_HARD = 1_500_000
const even = (n: number): number => Math.max(2, Math.round(n / 2) * 2)

const num = (v: unknown, lo: number, hi: number): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : undefined)

export class RemoteScreen {
  private viewers = new Map<string, Viewer>()
  private timer?: NodeJS.Timeout
  private busy = false
  private inputs: ScreenInputs
  /** the display the encoder is on, while it runs */
  private videoOn?: number
  private started?: VideoStart
  private config = ''
  private loop?: NodeJS.Timeout
  private cursors?: NodeJS.Timeout
  private ticks = 0
  private load = new LoadWatch()

  constructor(
    private source: ScreenSource,
    input: () => Promise<ScreenInput>,
    private allowed: () => boolean,
    private onChange: () => void = () => undefined,
    private video?: ScreenVideo,
    private opts: RemoteScreenOptions = {}
  ) {
    this.inputs = new ScreenInputs(input)
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
    this.inputs.release()
    this.halt()
    this.settle()
    this.onChange()
  }

  drop(client: ScreenClient): void {
    if (!this.viewers.delete(client.id)) return
    if (!this.viewers.size) this.inputs.release()
    if (!this.viewers.size) this.halt()
    this.settle()
    this.onChange()
  }

  handle(client: ScreenClient, m: Record<string, unknown>): void {
    const op = m.op
    if (op === 'start') return void this.start(client, num(m.display, 0, 64), m.video === true, m.audio === true, parseCaps(m.caps))
    const viewer = this.viewers.get(client.id)
    if (!viewer) return
    if (!this.allowed()) return this.stopAll('off')
    this.inputs.alive()
    switch (op) {
      case 'stop':
        return this.drop(client)
      case 'ack': {
        const seq = num(m.seq, 0, 2 ** 32)
        // an old phone page answers without a number: everything sent so far counts as arrived
        viewer.adapt.acked(seq ?? viewer.seq, Date.now())
        // a phone on pictures gets the next one as soon as it has shown this one
        if (viewer.mode === 'jpeg' && !this.busy) {
          this.halt()
          this.timer = setTimeout(() => void this.tick(), MIN_GAP)
        }
        return
      }
      case 'stats':
        return viewer.adapt.report({ fps: num(m.fps, 0, 500), dec: num(m.dec, 0, 500), decMs: num(m.decMs, 0, 10_000), q: num(m.q, 0, 1000) } satisfies PhoneReport)
      case 'keyframe':
        // the phone's decoder lost its place: the next picture is a whole one (asked for at most so often)
        viewer.needKey = true
        if (viewer.adapt.askKey(Date.now())) this.video?.keyframe()
        return
      case 'display': {
        const index = num(m.index, 0, 64)
        if (index === undefined || !this.source.displays()[index]) return
        viewer.display = index
        viewer.last = ''
        // the picture of the other display goes at once, whatever was in the air for this one
        viewer.adapt.forget()
        if (!viewer.wantsVideo) return this.info(viewer)
        return void this.pick(viewer).then(() => this.info(viewer))
      }
      default:
        return this.inputs.act(this.source.displays()[viewer.display], m)
    }
  }

  private async start(client: ScreenClient, display?: number, video = false, audio = false, caps?: PhoneCaps): Promise<void> {
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
      adapt: new Adapt(Date.now(), this.opts.startLevel),
      seq: 0,
      last: '',
      lastCursor: '',
      cursorAt: 0,
      caps
    }
    this.viewers.set(client.id, viewer)
    this.onChange()
    this.spin()
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
        const config = this.encoderConfig(v.display, [v])
        this.started = await this.video.start(d, { audio: [...this.viewers.values()].some((o) => o.wantsAudio), config })
        this.videoOn = v.display
        this.config = JSON.stringify(config)
      }
      v.mode = 'video'
      v.needKey = true
      this.video.keyframe()
      this.reconfigure()
    } catch (e) {
      // no hardware encoder, or the capture was refused: this phone gets pictures instead
      v.mode = 'jpeg'
      v.client.send({ t: 'screen', op: 'warn', message: e instanceof Error ? e.message : String(e) })
    }
    this.settle()
  }

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

  /** Sends one binary chunk with the next number, and counts it as in the air. */
  private emit(v: Viewer, head: Buffer, seqAt: number, data: Buffer): void {
    v.seq = (v.seq + 1) >>> 0
    head.writeUInt32LE(v.seq, seqAt)
    const out = Buffer.concat([head, data])
    v.adapt.sent(v.seq, out.length, Date.now())
    v.client.sendBinary(out)
  }

  // ------------------------------------------------------------------ video

  private fanVideo(c: VideoChunk): void {
    const now = Date.now()
    const size = HEAD_VIDEO + c.data.length
    for (const v of this.viewers.values()) {
      if (v.mode !== 'video' || v.display !== this.videoOn) continue
      // dropped for this phone: nothing until a whole picture, so what it decodes is never torn (asked for again when allowed)
      if (v.needKey && !c.key) {
        v.adapt.lost(now)
        if (!v.adapt.step.keyOnly && v.adapt.askKey(now)) this.video?.keyframe()
        continue
      }
      if (!v.adapt.canSend(size, now) || v.client.backlog() > BACKLOG_HARD) {
        // it does not fit in what the link carries now: dropped, and a whole picture follows when there is room
        v.needKey = true
        if (!v.adapt.step.keyOnly && v.adapt.askKey(now)) this.video?.keyframe()
        continue
      }
      v.needKey = false
      const head = Buffer.alloc(HEAD_VIDEO)
      head.writeUInt8(BIN_VIDEO, 0)
      head.writeUInt8(c.key ? 1 : 0, 1)
      head.writeDoubleLE(c.ts, 2)
      this.emit(v, head, 10, c.data)
    }
  }

  private fanAudio(c: { ts: number; data: Buffer }): void {
    const now = Date.now()
    for (const v of this.viewers.values()) {
      // the sound goes first when the link is short: it is never sent at the lower steps nor when it would not fit
      if (v.mode !== 'video' || !v.wantsAudio || !v.adapt.step.audio) continue
      if (!v.adapt.canSend(HEAD_AUDIO + c.data.length, now) || v.client.backlog() > BACKLOG_HARD / 2) continue
      const head = Buffer.alloc(HEAD_AUDIO)
      head.writeUInt8(BIN_AUDIO, 0)
      head.writeDoubleLE(c.ts, 1)
      this.emit(v, head, 9, c.data)
    }
  }

  /** What the encoder should make: the step of the phone with the worst link among those watching this display. */
  private encoderConfig(display: number, list: Viewer[]): EncoderConfig {
    const level = Math.max(...list.map((v) => v.adapt.level))
    const s = LADDER[level]
    const d = this.source.displays()[display]
    // never more than the weakest decoder watching takes
    const edge = Math.min(s.edge, ...list.map((v) => (v.caps ?? ANY_PHONE).maxEdge))
    const fps = Math.min(s.fps, ...list.map((v) => (v.caps ?? ANY_PHONE).maxFps))
    const k = Math.min(1, edge / Math.max(d.w, d.h))
    const width = even(d.w * k)
    const height = even(d.h * k)
    const profile = commonProfile(list.map((v) => v.caps))
    return { width, height, fps, bps: s.bps, gopSec: s.gopSec, keyOnly: Boolean(s.keyOnly), profile, level: avcLevel(width, height, fps).name, codec: avcCodecFor(profile, width, height, fps) }
  }

  private reconfigure(): void {
    if (this.videoOn === undefined || !this.video) return
    const list = [...this.viewers.values()].filter((v) => v.mode === 'video' && v.display === this.videoOn)
    if (!list.length || !this.source.displays()[this.videoOn]) return
    const c = this.encoderConfig(this.videoOn, list)
    const key = JSON.stringify(c)
    if (key === this.config) return
    this.config = key
    this.video.configure(c)
  }

  /** The link judge and the pointer run while anyone watches. */
  private spin(): void {
    const tickMs = this.opts.tickMs ?? 250
    this.loop ??= setInterval(() => {
      const now = Date.now()
      // the PC's own load is looked at every 2 s: when it is busy, 60 fps goes first
      // (JOLTY_SCREEN_IGNORE_LOAD=1: measurements of the ceiling only)
      if (this.ticks++ % Math.max(1, Math.round(2000 / tickMs)) === 0 && !process.env.JOLTY_SCREEN_IGNORE_LOAD) this.load.sample((this.opts.cpus ?? os.cpus)())
      let changed = false
      for (const v of this.viewers.values()) {
        // a busy PC gives up 60 fps first; a phone whose decoder stops lower never climbs past what it plays
        v.adapt.floor = v.mode === 'video' ? Math.max(this.load.floor, capsFloor(v.caps)) : 0
        if (v.adapt.tick(now)) changed = true
      }
      if (changed) this.reconfigure()
      // once a second each phone is told what it gets and how its link looks (the small indicator shows it)
      if (this.ticks % Math.max(1, Math.round(1000 / tickMs)) === 0) {
        for (const v of this.viewers.values()) {
          const c = v.mode === 'video' ? (JSON.parse(this.config || '{}') as Partial<EncoderConfig>) : undefined
          v.client.send({ t: 'screen', op: 'net', mode: v.mode, ...v.adapt.stats(now), fps: v.adapt.step.fps, height: c?.height ?? 0, busy: this.load.floor > 0 })
        }
      }
    }, tickMs)
    this.loop.unref?.()
    // the pointer is not in the video: it travels beside it, as often as the phone's step allows, and the phone draws it
    this.cursors ??= setInterval(() => {
      const list = [...this.viewers.values()].filter((v) => v.mode === 'video')
      if (!list.length) return
      const cur = this.source.cursor()
      const now = Date.now()
      for (const v of list) {
        if (now - v.cursorAt < 1000 / v.adapt.step.cursorHz - 2) continue
        const d = this.source.displays()[v.display]
        if (!d) continue
        const inside = cur.x >= d.x && cur.y >= d.y && cur.x < d.x + d.w && cur.y < d.y + d.h
        const x = inside ? (cur.x - d.x) / d.w : -1
        const y = inside ? (cur.y - d.y) / d.h : -1
        const key = `${x.toFixed(4)},${y.toFixed(4)}`
        if (key === v.lastCursor) continue
        v.lastCursor = key
        v.cursorAt = now
        v.client.send({ t: 'screen', op: 'cursor', x, y })
      }
    }, 16)
    this.cursors.unref?.()
  }

  /** Stops the encoder when no phone watches in video any more, and the timers when nobody watches at all. */
  private settle(): void {
    if (!this.viewers.size) {
      if (this.loop) clearInterval(this.loop)
      if (this.cursors) clearInterval(this.cursors)
      this.loop = this.cursors = undefined
    }
    if ([...this.viewers.values()].some((v) => v.mode === 'video')) return
    if (this.videoOn !== undefined) this.video?.stop()
    this.videoOn = undefined
    this.config = ''
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
    let gap = IDLE_GAP
    try {
      if (!this.allowed()) return this.stopAll('off')
      const wanted = new Map<number, Viewer[]>()
      const now = Date.now()
      for (const v of jpeg) {
        // a phone that has not taken the last picture, or whose link is backed up, waits
        // pictures go one at a time: the next leaves when the phone has shown the last (or it was lost long ago)
        if (v.adapt.oldest(now) > 4000) v.adapt.forget()
        if (v.adapt.inFlight > 0 || v.client.backlog() > 600_000) continue
        wanted.set(v.display, [...(wanted.get(v.display) || []), v])
      }
      for (const [index, list] of wanted) {
        const d = this.source.displays()[index]
        if (!d) continue
        // one capture per display, at the largest size and best quality any of its viewers takes
        const edge = Math.min(MAX_EDGE, Math.max(...list.map((v) => v.adapt.step.edge)))
        const quality = Math.max(...list.map((v) => v.adapt.step.jpegQ))
        const shot = await this.source.frame(d, edge, quality)
        if (!shot) continue
        const hash = crypto.createHash('md5').update(shot.jpeg).digest('hex')
        const cur = this.source.cursor()
        const cx = Math.round(Math.min(1, Math.max(0, (cur.x - d.x) / d.w)) * 65534)
        const cy = Math.round(Math.min(1, Math.max(0, (cur.y - d.y) / d.h)) * 65534)
        const out = cur.x >= d.x && cur.y >= d.y && cur.x < d.x + d.w && cur.y < d.y + d.h
        for (const v of list) {
          // the cursor moves without the picture changing: the picture is only resent when it did, the cursor always rides along
          if (hash === v.last) {
            v.client.send({ t: 'screen', op: 'cursor', x: out ? cx / 65534 : -1, y: out ? cy / 65534 : -1 })
            continue
          }
          v.last = hash
          const head = Buffer.alloc(HEAD_JPEG)
          head.writeUInt8(BIN_JPEG, 0)
          head.writeUInt16LE(out ? cx : 65535, 1)
          head.writeUInt16LE(out ? cy : 65535, 3)
          this.emit(v, head, 5, shot.jpeg)
          changed = true
          gap = Math.min(gap, Math.max(MIN_GAP, 1000 / Math.min(15, v.adapt.step.fps)))
        }
      }
    } catch (e) {
      // a locked or sleeping screen cannot be captured: say so once and keep trying
      for (const v of jpeg) v.client.send({ t: 'screen', op: 'warn', message: e instanceof Error ? e.message : String(e) })
    } finally {
      this.busy = false
      if ([...this.viewers.values()].some((v) => v.mode === 'jpeg')) this.timer = setTimeout(() => void this.tick(), changed ? gap : IDLE_GAP)
    }
  }
}
