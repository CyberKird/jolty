// Plays the PC's screen as video and its sound, on the phone, with WebCodecs: the chunks that come over the connection are
// H.264 (a whole picture, then changes) and Opus. A browser without WebCodecs gets JPEG pictures instead (the page asks for
// video only when `canPlayVideo` says it can).

export const BIN_JPEG = 1
export const BIN_VIDEO = 2
export const BIN_AUDIO = 3

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

/** Whether this browser has the pieces; whether it decodes the stream is found out when it does, and the page falls back to pictures if not. */
export async function canPlayVideo(): Promise<boolean> {
  try {
    return localStorage.getItem('jolty-screen-novideo') !== '1' && typeof VideoDecoder !== 'undefined' && typeof EncodedVideoChunk !== 'undefined'
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

/** Draws decoded pictures on a canvas, the newest one at each screen refresh; what arrived too late is thrown away, not queued. */
export class VideoPlayer {
  private decoder?: VideoDecoder
  private pending?: VideoFrame
  private raf = 0
  private gotKey = false
  private ctx: CanvasRenderingContext2D | null
  /** pictures decoded in the last second */
  fps = 0
  private decoded = 0
  private clock = setInterval(() => {
    this.fps = this.decoded
    this.decoded = 0
  }, 1000)

  private config?: { description: Uint8Array; codec: string }
  private errors = 0
  private born = Date.now()

  constructor(
    private canvas: HTMLCanvasElement,
    /** the decoder lost its place: ask the PC for a whole picture */
    private needKey: () => void,
    /** this browser cannot decode the stream: the page asks for pictures instead */
    private failed: () => void
  ) {
    this.ctx = canvas.getContext('2d', { alpha: false, desynchronized: true })
  }

  private open(): void {
    if (!this.config) return
    this.gotKey = false
    this.decoder = new VideoDecoder({
      output: (frame) => {
        this.errors = 0
        this.decoded++
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
    try {
      this.decoder.configure({ codec: this.config.codec, description: this.config.description, optimizeForLatency: true, hardwareAcceleration: 'prefer-hardware' })
    } catch {
      this.failed()
    }
  }

  private reopen(): void {
    try {
      this.decoder?.close()
    } catch {
      // already closed
    }
    this.open()
    this.needKey()
  }

  feed(key: boolean, ts: number, annexb: Uint8Array): void {
    const nals = splitNals(annexb)
    // the first whole picture carries what the decoder needs to be set up
    if (key && !this.config) {
      this.config = avcDescription(nals)
      if (!this.config) return
      this.open()
    }
    const d = this.decoder
    if (!d || d.state !== 'configured') return
    // nothing can be shown before a whole picture
    if (!this.gotKey && !key) return
    const data = toAvcc(nals)
    // a phone that cannot keep up must not fall behind more and more: it starts again from the next whole picture
    if (d.decodeQueueSize > 10) {
      this.reopen()
      return
    }
    if (key) this.gotKey = true
    try {
      d.decode(new EncodedVideoChunk({ type: key ? 'key' : 'delta', timestamp: ts, data }))
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
  }

  close(): void {
    clearInterval(this.clock)
    if (this.raf) cancelAnimationFrame(this.raf)
    this.pending?.close()
    try {
      this.decoder?.close()
    } catch {
      // already closed
    }
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
