// The PC's screen at 60 pictures a second: ffmpeg's ddagrab (Windows Desktop Duplication, the pictures stay on the graphics
// chip), scaled there, and encoded by the chip's own H.264 encoder (AMD AMF or NVIDIA NVENC). Measured on a 4K 144 Hz PC:
// 59 pictures a second at 1080p for under 4 % of one processor core, where Chromium's capture gives 30 for about 70 %.
// Used only when an ffmpeg that can do all of it is found (JOLTY_FFMPEG, PATH, C:\ffmpeg\bin), and only while a phone
// watches; otherwise remote-video.ts does the job as before. ffmpeg cannot change its settings while it runs, so a new
// step or a whole picture on demand starts a second ffmpeg and switches over at its first whole picture (no gap).
import { execFile, spawn, type ChildProcess } from 'child_process'
import fs from 'fs'
import { performance } from 'perf_hooks'
import type { DisplayInfo } from './computer/geometry'
import type { EncoderConfig, ScreenVideo, VideoChunk, VideoStart } from './remote-screen'
import { EncoderHost } from './remote-video'

export interface FfmpegCaps {
  exe: string
  encoder: string
  /** the duplication outputs of the main graphics chip, in ddagrab's order */
  outputs: Array<{ idx: number; w: number; h: number }>
}

const run = (exe: string, args: string[], ms = 15_000): Promise<{ out: string; err: string; ok: boolean }> =>
  new Promise((resolve) => {
    execFile(exe, args, { timeout: ms, windowsHide: true, maxBuffer: 4 << 20 }, (e, out, err) => resolve({ out: String(out), err: String(err), ok: !e }))
  })

const ENCODERS = ['h264_nvenc', 'h264_amf']

/** JOLTY_DEBUG_ENC=<file>: which way the screen is encoded, and why ffmpeg was left, go to that file */
const debug = (line: string): void => {
  if (process.env.JOLTY_DEBUG_ENC) fs.appendFileSync(process.env.JOLTY_DEBUG_ENC, `${new Date().toISOString()} ${line}\n`)
}

let probing: Promise<FfmpegCaps | undefined> | undefined

/** What this PC's ffmpeg can do, found once (a few hundred ms) the first time a phone asks for video. */
export function probeFfmpeg(): Promise<FfmpegCaps | undefined> {
  probing ??= (async () => {
    if (process.platform !== 'win32' || process.env.JOLTY_FFMPEG === 'off') return undefined
    const found = (await run('where', ['ffmpeg'], 5000)).out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)
    const candidates = [process.env.JOLTY_FFMPEG, ...found, 'C:\\ffmpeg\\bin\\ffmpeg.exe'].filter((p): p is string => Boolean(p) && fs.existsSync(p as string))
    debug(`ffmpeg candidates: ${JSON.stringify(candidates)}`)
    for (const exe of [...new Set(candidates)]) {
      const filters = (await run(exe, ['-hide_banner', '-filters'])).out
      if (!/\bddagrab\b/.test(filters) || !/\bscale_d3d11\b/.test(filters)) {
        debug(`${exe}: no ddagrab or scale_d3d11 (${filters.length} bytes of filters)`)
        continue
      }
      const encoders = (await run(exe, ['-hide_banner', '-encoders'])).out
      const usable = ENCODERS.filter((e) => new RegExp(`\\b${e}\\b`).test(encoders))
      debug(`${exe}: hardware encoders listed ${JSON.stringify(usable)}`)
      for (const encoder of usable) {
        const outputs: FfmpegCaps['outputs'] = []
        for (let idx = 0; idx < 8; idx++) {
          // one small picture through the whole chain: the encoder must really open on this chip, not just be listed
          const r = await run(exe, ['-hide_banner', '-loglevel', 'verbose', '-nostdin', '-init_hw_device', 'd3d11va', '-filter_complex', `ddagrab=output_idx=${idx}:framerate=5,scale_d3d11=width=320:height=180:format=nv12`, '-frames:v', '1', ...encoderArgs(encoder, { width: 320, height: 180, fps: 5, bps: 300_000, gopSec: 1, keyOnly: false, profile: 'baseline', level: '3.0', codec: '' }), '-f', 'null', '-'])
          const m = /Opened dxgi output \d+ with dimensions (\d+)x(\d+)/.exec(r.err)
          if (!m || !r.ok) {
            if (idx === 0) debug(`${encoder} on output 0 failed: ${r.err.trim().split(/\r?\n/).slice(-3).join(' | ')}`)
            break
          }
          outputs.push({ idx, w: Number(m[1]), h: Number(m[2]) })
        }
        if (outputs.length) return { exe, encoder, outputs }
      }
    }
    return undefined
  })().then((caps) => {
    // not found: looked for again a minute later (a probe can fail while the PC is very busy)
    if (!caps) setTimeout(() => (probing = undefined), 60_000).unref?.()
    return caps
  })
  return probing
}

/** The duplication output showing `d`: matched by size, in order among displays of the same size. */
export function outputFor(caps: FfmpegCaps, displays: DisplayInfo[], d: DisplayInfo): number | undefined {
  const same = displays.filter((x) => x.w === d.w && x.h === d.h)
  const outs = caps.outputs.filter((o) => o.w === d.w && o.h === d.h)
  // as many outputs of that size as displays: the order is the same; otherwise it cannot be told which is which
  if (!outs.length || outs.length !== same.length) return undefined
  // by id: the list may be a fresh copy of the displays, not the objects `d` came from
  return outs[same.findIndex((x) => x.id === d.id)]?.idx
}

export function encoderArgs(encoder: string, c: EncoderConfig): string[] {
  const gop = c.keyOnly ? 1 : Math.max(1, Math.round(c.gopSec * c.fps))
  const bps = String(Math.round(c.bps))
  const common = ['-bf', '0', '-g', String(gop), '-b:v', bps, '-maxrate', String(Math.round(c.bps * 1.5)), '-bufsize', String(Math.round(c.bps / 2))]
  if (encoder === 'h264_nvenc') return ['-c:v', 'h264_nvenc', '-preset', 'p1', '-tune', 'ull', '-zerolatency', '1', '-rc', 'cbr', '-delay', '0', '-profile:v', c.profile, '-level', c.level, ...common]
  return ['-c:v', 'h264_amf', '-usage', 'ultralowlatency', '-quality', 'speed', '-rc', 'vbr_peak', '-profile:v', c.profile === 'baseline' ? 'constrained_baseline' : c.profile, '-level', c.level, ...common]
}

/** FLV tags in, H.264 Annex B pictures out (parameter sets in front of every whole picture). */
export class FlvToAnnexB {
  private buf: Buffer = Buffer.alloc(0)
  private header = false
  private params: Buffer = Buffer.alloc(0)
  private lenSize = 4

  constructor(private out: (c: { key: boolean; data: Buffer }) => void) {}

  push(d: Buffer): void {
    this.buf = this.buf.length ? Buffer.concat([this.buf, d]) : d
    let at = 0
    if (!this.header) {
      if (this.buf.length < 13) return
      this.header = true
      at = this.buf.readUInt32BE(5) + 4
    }
    while (this.buf.length - at >= 11) {
      const size = this.buf.readUIntBE(at + 1, 3)
      if (this.buf.length - at < 11 + size + 4) break
      if (this.buf[at] === 9 && size > 5) this.tag(this.buf.subarray(at + 11, at + 11 + size))
      at += 11 + size + 4
    }
    this.buf = this.buf.subarray(at)
  }

  private tag(t: Buffer): void {
    if ((t[0] & 0x0f) !== 7) return
    const key = t[0] >> 4 === 1
    if (t[1] === 0) return this.config(t.subarray(5))
    if (t[1] !== 1) return
    const parts: Buffer[] = []
    const start = Buffer.from([0, 0, 0, 1])
    let hasSps = false
    for (let at = 5; at + this.lenSize <= t.length; ) {
      const n = t.readUIntBE(at, this.lenSize)
      at += this.lenSize
      if (n <= 0 || at + n > t.length) break
      const unit = t.subarray(at, at + n)
      if ((unit[0] & 0x1f) === 7) hasSps = true
      parts.push(start, unit)
      at += n
    }
    if (!parts.length) return
    this.out({ key, data: Buffer.concat(key && !hasSps ? [this.params, ...parts] : parts) })
  }

  /** AVCDecoderConfigurationRecord: the parameter sets, kept for every whole picture */
  private config(r: Buffer): void {
    if (r.length < 7) return
    this.lenSize = (r[4] & 3) + 1
    const parts: Buffer[] = []
    const start = Buffer.from([0, 0, 0, 1])
    let at = 6
    for (let i = 0, n = r[5] & 0x1f; i < n && at + 2 <= r.length; i++) {
      const len = r.readUInt16BE(at)
      parts.push(start, r.subarray(at + 2, at + 2 + len))
      at += 2 + len
    }
    for (let i = 0, n = r[at++] ?? 0; i < n && at + 2 <= r.length; i++) {
      const len = r.readUInt16BE(at)
      parts.push(start, r.subarray(at + 2, at + 2 + len))
      at += 2 + len
    }
    this.params = Buffer.concat(parts)
  }
}

interface Proc {
  child: ChildProcess
  config: string
}

/** Video only; the sound comes from a Chromium window that captures nothing else (see ScreenVideoAuto). */
export class FfmpegVideo {
  private active?: Proc
  private next?: Proc
  private caps?: FfmpegCaps
  private output = 0
  private cfg?: EncoderConfig
  private video?: (c: VideoChunk) => void
  private failed?: (why: string) => void
  private lastSpawn = 0
  private later?: NodeJS.Timeout
  private deaths: number[] = []
  private running = false
  private keyed = false
  private lastKeyAt = 0

  onVideo(cb: (c: VideoChunk) => void): void {
    this.video = cb
  }

  /** ffmpeg keeps failing (the screen was locked, the display changed): the caller moves to the other encoder */
  onFail(cb: (why: string) => void): void {
    this.failed = cb
  }

  /** Whether ffmpeg can show `d`; resolves to its output, or undefined. */
  async canShow(displays: DisplayInfo[], d: DisplayInfo): Promise<boolean> {
    this.caps = await probeFfmpeg()
    if (!this.caps) return false
    const o = outputFor(this.caps, displays, d)
    if (o === undefined) return false
    this.output = o
    return true
  }

  async start(config: EncoderConfig): Promise<VideoStart> {
    if (!this.caps) throw new Error('ffmpeg is not available')
    this.stop()
    this.running = true
    this.cfg = config
    this.keyed = false
    const p = this.spawn(config)
    this.active = p
    // the first picture, or the reason there is none
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => resolve(), 4000)
      p.child.once('exit', (code) => {
        clearTimeout(t)
        reject(new Error(`ffmpeg stopped (${code})`))
      })
      p.child.stdout?.once('data', () => {
        clearTimeout(t)
        resolve()
      })
    })
    return { codec: 'avc1.4D0028', width: config.width, height: config.height, audio: false }
  }

  configure(c: EncoderConfig): void {
    this.cfg = c
    this.swap(250)
  }

  keyframe(): void {
    // a fresh ffmpeg (or one that just made a whole picture) is about to give what is asked for anyway
    if (!this.keyed || Date.now() - this.lastKeyAt < 500) return
    this.swap(0)
  }

  /** A second ffmpeg with the new settings; the first stays until the second has its first whole picture. */
  private swap(wait: number): void {
    if (!this.running || !this.cfg) return
    if (this.later) return
    // starting an ffmpeg costs a few hundred ms of one core: at most one every 1.5 s
    const due = Math.max(wait, this.lastSpawn + 1500 - Date.now())
    this.later = setTimeout(() => {
      this.later = undefined
      if (!this.running || !this.cfg) return
      if (this.next) this.kill(this.next)
      this.next = this.spawn(this.cfg)
    }, due)
  }

  private spawn(c: EncoderConfig): Proc {
    const caps = this.caps!
    this.lastSpawn = Date.now()
    const args = ['-hide_banner', '-loglevel', 'error', '-nostdin', '-fflags', 'nobuffer', '-init_hw_device', 'd3d11va', '-filter_complex', `ddagrab=output_idx=${this.output}:framerate=${c.fps}:draw_mouse=0:dup_frames=0,scale_d3d11=width=${c.width}:height=${c.height}:format=nv12`, ...encoderArgs(caps.encoder, c), '-flush_packets', '1', '-f', 'flv', 'pipe:1']
    const child = spawn(caps.exe, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    const p: Proc = { child, config: JSON.stringify(c) }
    let err = ''
    child.stderr?.on('data', (d) => (err = (err + String(d)).slice(-2000)))
    const parse = new FlvToAnnexB((ch) => {
      if (p === this.next) {
        if (!ch.key) return
        // the new one has its first whole picture: it takes over
        if (this.active) this.kill(this.active)
        this.active = p
        this.next = undefined
      }
      if (p !== this.active) return
      if (ch.key) {
        this.keyed = true
        this.lastKeyAt = Date.now()
      }
      this.video?.({ key: ch.key, ts: Math.round(performance.now() * 1000), data: ch.data })
    })
    child.stdout?.on('data', (d: Buffer) => parse.push(d))
    child.on('exit', (code) => {
      debug(`ffmpeg ${child.pid} exited ${code}: ${err.trim().split(/\r?\n/).pop() ?? ''}`)
      if (p === this.next) this.next = undefined
      if (p !== this.active) return
      this.active = undefined
      if (!this.running) return
      const now = Date.now()
      this.deaths = [...this.deaths.filter((t) => now - t < 15_000), now]
      if (this.deaths.length >= 3) {
        this.stop()
        this.failed?.(err.trim().split(/\r?\n/).pop() || 'ffmpeg stopped')
        return
      }
      // the duplication is lost now and then (a secure desktop, a mode change): it starts again
      setTimeout(() => {
        if (this.running && !this.active && this.cfg) this.active = this.spawn(this.cfg)
      }, 800)
    })
    return p
  }

  private kill(p: Proc): void {
    p.child.removeAllListeners('exit')
    if (p.child.exitCode === null) p.child.kill()
  }

  stop(): void {
    this.running = false
    if (this.later) clearTimeout(this.later)
    this.later = undefined
    for (const p of [this.active, this.next]) if (p) this.kill(p)
    this.active = this.next = undefined
  }

  /** process ids running now (tests make sure none is left) */
  pids(): number[] {
    return [this.active, this.next].filter((p): p is Proc => Boolean(p)).map((p) => p.child.pid ?? 0)
  }
}

/** ffmpeg for the picture when it can, Chromium otherwise (and for the sound always). */
export class ScreenVideoAuto implements ScreenVideo {
  private ff = new FfmpegVideo()
  private chrome = new EncoderHost()
  private sound = new EncoderHost(true)
  private using?: 'ff' | 'chrome'
  private video?: (c: VideoChunk) => void
  private audio?: (c: { ts: number; data: Buffer }) => void
  private last?: { display: DisplayInfo; opts: { audio: boolean; config: EncoderConfig } }

  constructor(private displays: () => DisplayInfo[]) {
    const v = (c: VideoChunk): void => this.video?.(c)
    const a = (c: { ts: number; data: Buffer }): void => this.audio?.(c)
    this.ff.onVideo((c) => this.using === 'ff' && v(c))
    this.chrome.onVideo((c) => this.using === 'chrome' && v(c))
    this.chrome.onAudio((c) => this.using === 'chrome' && a(c))
    this.sound.onAudio((c) => this.using === 'ff' && a(c))
    this.ff.onFail((why) => {
      debug(`ffmpeg gave up (${why}), Chromium capture takes over`)
      // ffmpeg gave up while a phone watched: the same phone goes on with Chromium's capture
      if (this.using !== 'ff' || !this.last) return
      this.sound.stop()
      this.using = 'chrome'
      void this.chrome.start(this.last.display, this.last.opts).then(() => this.chrome.keyframe(), () => undefined)
    })
  }

  available(): boolean {
    return true
  }

  onVideo(cb: (c: VideoChunk) => void): void {
    this.video = cb
  }

  onAudio(cb: (c: { ts: number; data: Buffer }) => void): void {
    this.audio = cb
  }

  async start(display: DisplayInfo, opts: { audio: boolean; config: EncoderConfig }): Promise<VideoStart> {
    this.stop()
    this.last = { display, opts }
    const can = await this.ff.canShow(this.displays(), display).catch((e) => (debug(`ffmpeg probe failed: ${e}`), false))
    if (can) {
      try {
        this.using = 'ff'
        const started = await this.ff.start(opts.config)
        const sound = opts.audio ? await this.sound.start(display, opts).catch((e) => (debug(`sound capture failed: ${e}`), undefined)) : undefined
        debug(`ffmpeg video on display ${display.index}, sound ${Boolean(sound?.audio)}`)
        return { ...started, audio: Boolean(sound?.audio) }
      } catch (e) {
        debug(`ffmpeg start failed: ${e}`)
        this.ff.stop()
        this.sound.stop()
      }
    } else debug(`ffmpeg not usable for display ${display.index} (${display.w}x${display.h})`)
    this.using = 'chrome'
    return this.chrome.start(display, opts)
  }

  stop(): void {
    this.ff.stop()
    this.sound.stop()
    this.chrome.stop()
    this.using = undefined
  }

  keyframe(): void {
    if (this.using === 'ff') this.ff.keyframe()
    else this.chrome.keyframe()
  }

  configure(c: EncoderConfig): void {
    if (this.last) this.last.opts.config = c
    if (this.using === 'ff') this.ff.configure(c)
    else this.chrome.configure(c)
  }

  dispose(): void {
    this.ff.stop()
    this.chrome.dispose()
    this.sound.dispose()
  }
}
