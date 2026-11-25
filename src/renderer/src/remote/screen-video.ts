// Plays the PC's screen as video and its sound, on the phone, with WebCodecs: the chunks that come over the connection are
// H.264 (a whole picture, then changes) and Opus. A browser without WebCodecs gets JPEG pictures instead (the page asks for
// video only when `canPlayVideo` says it can).

import type { Feedback } from './screen-feedback'

export { BIN_AUDIO, BIN_JPEG, BIN_VIDEO } from './screen-feedback'

let audioCtx: AudioContext | undefined

/** The sound needs a tap to start on a phone: this is called from the tap that opens the screen, and again from the first touch on it. */
export function audioContext(): AudioContext | undefined {
  try {
    audioCtx ??= new AudioContext({ latencyHint: 'interactive', sampleRate: 48000 })
    if (audioCtx.state === 'suspended') void audioCtx.resume()
  } catch {
    // no audio on this browser
  }
  return audioCtx
}

/** What this phone decodes, told to the PC so it encodes only what plays here. */
export interface VideoCaps {
  /** H.264 profiles that decode, best first */
  profiles: Array<'high' | 'main' | 'baseline'>
  /** the largest picture edge and rate that decode (from the highest level that does) */
  maxEdge: number
  maxFps: number
  /** the decoder runs on the phone's video hardware at the best level */
  hardware: boolean
}

const PROFILE_IDC: Record<VideoCaps['profiles'][number], string> = { high: '6400', main: '4D40', baseline: '42E0' }
/** H.264 levels from the best down, with what each carries (a step of the PC's ladder must fit). The PC sends a 4K screen
 *  at its own pixels when the phone decodes it: text read zoomed in stays sharp. */
const LEVELS: Array<{ hex: string; edge: number; fps: number; w: number; h: number }> = [
  { hex: '34', edge: 3840, fps: 60, w: 3840, h: 2160 },
  { hex: '33', edge: 3840, fps: 30, w: 3840, h: 2160 },
  { hex: '33', edge: 2560, fps: 60, w: 2560, h: 1440 },
  { hex: '32', edge: 2560, fps: 30, w: 2560, h: 1440 },
  { hex: '2A', edge: 1920, fps: 60, w: 1920, h: 1080 },
  { hex: '28', edge: 1920, fps: 30, w: 1920, h: 1080 },
  { hex: '20', edge: 1280, fps: 60, w: 1280, h: 720 },
  { hex: '1F', edge: 1280, fps: 30, w: 1280, h: 720 },
  { hex: '1E', edge: 854, fps: 30, w: 854, h: 480 }
]

/** The codec string for a profile and level, as the PC's encoders name it. */
export const avcCodec = (profile: VideoCaps['profiles'][number], levelHex: string): string => `avc1.${PROFILE_IDC[profile]}${levelHex}`

/**
 * Asks the browser, with the exact codec strings, what it decodes: low-end Android decoders stop at Baseline or at 720p,
 * Safari has WebCodecs from iOS 16.4 only. Hardware is preferred; software counts only up to 720p30 (a phone's processor
 * cannot keep 1080p60 smooth). Undefined: nothing usable, the page asks for pictures. A call that throws counts as "no".
 */
export async function videoCaps(dec: { isConfigSupported(c: VideoDecoderConfig): Promise<VideoDecoderSupport> } | undefined = typeof VideoDecoder === 'undefined' ? undefined : VideoDecoder): Promise<VideoCaps | undefined> {
  if (!dec || typeof EncodedVideoChunk === 'undefined') return undefined
  const ok = async (codec: string, w: number, h: number, hardwareAcceleration: HardwareAcceleration): Promise<boolean> => {
    try {
      const r = await dec.isConfigSupported({ codec, codedWidth: w, codedHeight: h, hardwareAcceleration, optimizeForLatency: true })
      return r.supported === true
    } catch {
      return false
    }
  }
  const profiles: VideoCaps['profiles'] = []
  let best: (typeof LEVELS)[number] | undefined
  let hardware = false
  for (const p of ['high', 'main', 'baseline'] as const) {
    for (const l of LEVELS) {
      const hw = await ok(avcCodec(p, l.hex), l.w, l.h, 'prefer-hardware')
      const sw = !hw && l.edge <= 1280 && l.fps <= 30 && (await ok(avcCodec(p, l.hex), l.w, l.h, 'no-preference'))
      if (!hw && !sw) continue
      profiles.push(p)
      if (!best || l.edge * l.fps > best.edge * best.fps) {
        best = l
        hardware = hw
      }
      break
    }
  }
  if (!best || !profiles.length) return undefined
  return { profiles, maxEdge: best.edge, maxFps: best.fps, hardware }
}

let capsOnce: Promise<VideoCaps | undefined> | undefined

/** videoCaps, asked once per page (the answer does not change while the page lives). */
export function videoCapsOnce(): Promise<VideoCaps | undefined> {
  capsOnce ??= videoCaps()
  return capsOnce
}

/** Whether this phone should ask for video (a failure is remembered for a day, then video is tried again). */
export async function canPlayVideo(): Promise<boolean> {
  try {
    const no = Number(localStorage.getItem('jolty-screen-novideo') || 0)
    return !(no > 0 && Date.now() - no < 86_400_000) && typeof VideoDecoder !== 'undefined' && typeof EncodedVideoChunk !== 'undefined'
  } catch {
    return false
  }
}

// ---------------------------------------------------------------- H.264 as the browsers want it
// The PC sends Annex B (start codes, parameter sets with each whole picture). Safari and Chromium both take the other form
// (lengths in front of each unit, the parameter sets in a description), so the stream is converted here, once per chunk.

/** The units of an Annex B chunk, without their start codes. */
export function splitNals(data: Uint8Array): Uint8Array[] {
  const out: Uint8Array[] = []
  const n = data.length
  let start = -1
  for (let i = 0; i + 2 < n; i++) {
    if (data[i] === 0 && data[i + 1] === 0 && data[i + 2] === 1) {
      if (start >= 0) {
        let end = i
        while (end > start && data[end - 1] === 0) end--
        out.push(data.subarray(start, end))
      }
      start = i + 3
      i += 2
    }
  }
  if (start >= 0 && start < n) out.push(data.subarray(start, n))
  return out
}

const nalType = (u: Uint8Array): number => u[0] & 0x1f

/** The picture units with a 4 byte length in front of each; parameter sets and delimiters are in the description, not here. */
export function toAvcc(nals: Uint8Array[]): Uint8Array {
  const keep = nals.filter((u) => u.length && ![7, 8, 9].includes(nalType(u)))
  const out = new Uint8Array(keep.reduce((n, u) => n + 4 + u.length, 0))
  const view = new DataView(out.buffer)
  let at = 0
  for (const u of keep) {
    view.setUint32(at, u.length)
    out.set(u, at + 4)
    at += 4 + u.length
  }
  return out
}

/** The decoder's description (avcC) and codec string, from the parameter sets of a whole picture. */
export function avcDescription(nals: Uint8Array[]): { description: Uint8Array; codec: string } | undefined {
  const sps = nals.find((u) => nalType(u) === 7)
  const pps = nals.find((u) => nalType(u) === 8)
  if (!sps || !pps || sps.length < 4) return undefined
  const d = new Uint8Array(11 + sps.length + pps.length)
  const v = new DataView(d.buffer)
  d[0] = 1
  d[1] = sps[1]
  d[2] = sps[2]
  d[3] = sps[3]
  d[4] = 0xff
  d[5] = 0xe1
  v.setUint16(6, sps.length)
  d.set(sps, 8)
  d[8 + sps.length] = 1
  v.setUint16(9 + sps.length, pps.length)
  d.set(pps, 11 + sps.length)
  const hex = (n: number): string => n.toString(16).padStart(2, '0')
  return { description: d, codec: `avc1.${hex(sps[1])}${hex(sps[2])}${hex(sps[3])}` }
}

export async function canPlayAudio(): Promise<boolean> {
  try {
    if (typeof AudioDecoder === 'undefined' || typeof EncodedAudioChunk === 'undefined') return false
    const r = await AudioDecoder.isConfigSupported({ codec: 'opus', sampleRate: 48000, numberOfChannels: 2 })
    return r.supported === true
  } catch {
    return false
  }
}

const sameBytes = (a: Uint8Array, b: Uint8Array): boolean => a.length === b.length && a.every((x, i) => x === b[i])

/** Draws decoded pictures on a canvas, the newest one at each screen refresh; what arrived too late is thrown away, not queued. */
export class VideoPlayer {
  private decoder?: VideoDecoder
  private pending?: VideoFrame
  private raf = 0
  private gotKey = false
  private ctx: CanvasRenderingContext2D | null
  /** pictures drawn in the last second */
  fps = 0
  private drawnNow = 0
  private clock = setInterval(() => {
    this.fps = this.drawnNow
    this.drawnNow = 0
  }, 1000)

  private config?: { description: Uint8Array; codec: string }
  private errors = 0
  private born = Date.now()
  /** when each picture went into the decoder, by its timestamp */
  private inAt = new Map<number, number>()

  constructor(
    private canvas: HTMLCanvasElement,
    /** the decoder lost its place: ask the PC for a whole picture */
    private needKey: () => void,
    /** this browser cannot decode the stream: the page asks for pictures instead */
    private failed: () => void,
    /** decode times and drawn pictures go to the PC */
    private fb?: Feedback
  ) {
    this.ctx = canvas.getContext('2d', { alpha: false, desynchronized: true })
  }

  private open(): void {
    if (!this.config) return
    this.gotKey = false
    this.inAt.clear()
    const decoder = new VideoDecoder({
      output: (frame) => {
        this.errors = 0
        const at = this.inAt.get(frame.timestamp)
        this.inAt.delete(frame.timestamp)
        this.fb?.decodedOne(at === undefined ? 0 : performance.now() - at, decoder.decodeQueueSize)
        // only the newest picture is drawn: one that was waiting is replaced, never queued behind
        this.pending?.close()
        this.pending = frame
        if (!this.raf) this.raf = requestAnimationFrame(() => this.draw())
      },
      error: (e) => {
        console.warn('screen decoder error', e.message)
        // the decoder broke (a torn picture, the system took the hardware): start again from the next whole picture;
        // one that never gets a picture out is a browser that cannot do it
        if (++this.errors >= 3 && Date.now() - this.born < 8000) return this.failed()
        this.reopen()
      }
    })
    this.decoder = decoder
    try {
      decoder.configure({ codec: this.config.codec, description: this.config.description, optimizeForLatency: true, hardwareAcceleration: 'prefer-hardware' })
    } catch {
      this.failed()
    }
  }

  private close1(): void {
    try {
      this.decoder?.close()
    } catch {
      // already closed
    }
  }

  private reopen(): void {
    this.close1()
    this.open()
    this.needKey()
  }

  feed(key: boolean, ts: number, annexb: Uint8Array): void {
    const nals = splitNals(annexb)
    // a whole picture carries what the decoder needs; new parameters (the PC changed the picture size) mean a new decoder
    if (key) {
      const cfg = avcDescription(nals)
      if (cfg && (!this.config || !sameBytes(cfg.description, this.config.description))) {
        this.config = cfg
        this.close1()
        this.open()
      }
    }
    const d = this.decoder
    if (!d || d.state !== 'configured') return
    // nothing can be shown before a whole picture
    if (!this.gotKey && !key) return
    // a phone that cannot keep up must not fall behind more and more: it skips to the next whole picture
    if (!key && d.decodeQueueSize > 3) {
      this.gotKey = false
      this.needKey()
      return
    }
    if (key) this.gotKey = true
    if (this.inAt.size > 64) this.inAt.clear()
    this.inAt.set(ts, performance.now())
    try {
      d.decode(new EncodedVideoChunk({ type: key ? 'key' : 'delta', timestamp: ts, data: toAvcc(nals) }))
    } catch {
      this.reopen()
    }
  }

  private draw(): void {
    this.raf = 0
    const f = this.pending
    this.pending = undefined
    if (!f || !this.ctx) return f?.close()
    if (this.canvas.width !== f.displayWidth || this.canvas.height !== f.displayHeight) {
      this.canvas.width = f.displayWidth
      this.canvas.height = f.displayHeight
    }
    this.ctx.drawImage(f, 0, 0)
    f.close()
    this.drawnNow++
    this.fb?.drawnOne()
  }

  close(): void {
    clearInterval(this.clock)
    if (this.raf) cancelAnimationFrame(this.raf)
    this.pending?.close()
    this.close1()
  }
}

/** Plays the sound a little behind its arrival, so a late chunk does not crackle, and drops what would make the sound lag behind the picture. */
export class AudioPlayer {
  private decoder?: AudioDecoder
  private ctx: AudioContext
  private gain: GainNode
  private next = 0

  constructor(ctx: AudioContext, muted: boolean) {
    this.ctx = ctx
    this.gain = ctx.createGain()
    this.gain.gain.value = muted ? 0 : 1
    this.gain.connect(ctx.destination)
    this.decoder = new AudioDecoder({ output: (d) => this.play(d), error: () => undefined })
    this.decoder.configure({ codec: 'opus', sampleRate: 48000, numberOfChannels: 2 })
  }

  mute(on: boolean): void {
    this.gain.gain.value = on ? 0 : 1
  }

  feed(ts: number, data: Uint8Array): void {
    if (this.decoder?.state !== 'configured') return
    try {
      this.decoder.decode(new EncodedAudioChunk({ type: 'key', timestamp: ts, data }))
    } catch {
      // a broken chunk is a gap, not a reason to stop
    }
  }

  private play(data: AudioData): void {
    try {
      const ch = data.numberOfChannels
      const buf = this.ctx.createBuffer(ch, data.numberOfFrames, data.sampleRate)
      for (let c = 0; c < ch; c++) {
        const plane = new Float32Array(data.numberOfFrames)
        data.copyTo(plane, { planeIndex: c, format: 'f32-planar' })
        buf.copyToChannel(plane, c)
      }
      const now = this.ctx.currentTime
      // behind the picture by more than this: the oldest sound is not worth playing
      if (this.next - now > 0.35) return
      if (this.next < now + 0.015) this.next = now + 0.07
      const src = this.ctx.createBufferSource()
      src.buffer = buf
      src.connect(this.gain)
      src.start(this.next)
      this.next += buf.duration
    } finally {
      data.close()
    }
  }

  close(): void {
    try {
      this.decoder?.close()
    } catch {
      // already closed
    }
    this.gain.disconnect()
  }
}
