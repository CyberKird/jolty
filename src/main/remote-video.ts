// The PC's screen (and sound) as H.264 and Opus, made in a hidden window with Chromium's own capture and WebCodecs, so the
// video is encoded on the graphics chip and a phone can play it smoothly. The window is ours, loads only a file we write,
// and the chunks come back over IPC to remote-screen.ts, which sends them to the phones.
// Measured on a 4K 144 Hz PC: Chromium's capture gives about 30 pictures a second whatever it is asked for, so this is the
// fallback; remote-ffmpeg.ts makes 60 when the PC has what it needs. With `videoOff` this window only carries the sound.
import { app, BrowserWindow, desktopCapturer, ipcMain, session } from 'electron'
import fs from 'fs'
import path from 'path'
import type { DisplayInfo } from './computer/geometry'
import type { EncoderConfig, ScreenVideo, VideoChunk, VideoStart } from './remote-screen'

const PRELOAD = `const { contextBridge, ipcRenderer } = require('electron')
contextBridge.exposeInMainWorld('encSend', (kind, key, ts, bytes) => ipcRenderer.send('jolty-enc', kind, key, ts, bytes))
`

const PAGE = `<!doctype html><meta charset="utf-8"><title>Jolty screen encoder</title><script>
let st = null
const even = (n) => Math.max(2, Math.round(n / 2) * 2)

async function stop() {
  const s = st
  st = null
  if (!s) return
  s.dead = true
  clearInterval(s.stats)
  try { s.stream.getTracks().forEach((t) => t.stop()) } catch {}
  try { s.vr && s.vr.cancel() } catch {}
  try { s.ar && s.ar.cancel() } catch {}
  try { s.venc && s.venc.state !== 'closed' && s.venc.close() } catch {}
  try { s.aenc && s.aenc.state !== 'closed' && s.aenc.close() } catch {}
  try { s.last && s.last.close() } catch {}
}

function limits(c) {
  // no minimum: a minimum the screen cannot meet makes the capture fail
  return { width: { ideal: c.width, max: c.width }, height: { ideal: c.height, max: c.height }, frameRate: { ideal: c.fps, max: c.fps } }
}

async function start(o) {
  await stop()
  const c = o.config
  const stream = await navigator.mediaDevices.getDisplayMedia({
    // only the sound is wanted: the picture is kept as small and as rare as the capture allows
    video: o.videoOff ? { width: { max: 320 }, height: { max: 320 }, frameRate: { max: 1 } } : limits(c),
    audio: o.audio ? { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 2 } : false
  })
  const vt = stream.getVideoTracks()[0]
  const set = vt.getSettings()
  const s = (st = { stream, vt, dead: false, key: true, lastKeyAt: 0, lastTs: -1e12, last: null, cfg: c, encW: 0, encH: 0, encBps: 0, encFps: 0 })
  const at = stream.getAudioTracks()[0]
  if (at) sound(s, at)
  if (o.videoOff) return { codec: '', width: 0, height: 0, audio: Boolean(at) }

  const codecFor = (w, h) => (w * h > 1920 * 1088 ? 'avc1.640033' : 'avc1.64002A')
  // the encoder follows the pictures it is given (their size changes with the step) and the step's bitrate and rate;
  // a new size is a new stream (a whole picture), a new bitrate is not
  s.configure = async (w, h) => {
    const cfg = { codec: codecFor(w, h), width: w, height: h, bitrate: s.cfg.bps, framerate: s.cfg.fps, latencyMode: 'realtime', bitrateMode: 'variable', avc: { format: 'annexb' }, hardwareAcceleration: 'prefer-hardware' }
    const hw = await VideoEncoder.isConfigSupported(cfg)
    if (!hw.supported) cfg.hardwareAcceleration = 'no-preference'
    if (w !== s.encW || h !== s.encH) s.key = true
    s.venc.configure(cfg)
    s.encW = w
    s.encH = h
    s.encBps = s.cfg.bps
    s.encFps = s.cfg.fps
  }
  s.venc = new VideoEncoder({
    output: (ch) => {
      const b = new Uint8Array(ch.byteLength)
      ch.copyTo(b)
      window.encSend('v', ch.type === 'key', ch.timestamp, b)
    },
    error: (e) => window.encSend('e', false, 0, new TextEncoder().encode(String((e && e.message) || e)))
  })
  const width = even(set.width || c.width)
  const height = even(set.height || c.height)
  await s.configure(width, height)

  s.vr = new MediaStreamTrackProcessor({ track: vt }).readable.getReader()
  s.n = { got: 0, sent: 0, skipped: 0 }
  s.stats = setInterval(() => { console.log('enc-stats ' + JSON.stringify({ ...s.n, q: s.venc.encodeQueueSize, w: s.encW, h: s.encH, fps: s.cfg.fps, bps: s.cfg.bps })); s.n = { got: 0, sent: 0, skipped: 0 } }, 1000)
  ;(async () => {
    while (!s.dead) {
      let r
      try { r = await s.vr.read() } catch { break }
      if (r.done) break
      const f = r.value
      s.n.got++
      // the step's rate: pictures that come sooner are let go (latency first: the newest is the one that matters)
      const early = f.timestamp - s.lastTs < 1e6 / s.cfg.fps - 4000
      if (early || s.venc.encodeQueueSize > 2) { s.n.skipped++; f.close(); continue }
      const w = even(f.displayWidth)
      const h = even(f.displayHeight)
      if (w !== s.encW || h !== s.encH || s.cfg.bps !== s.encBps || s.cfg.fps !== s.encFps) {
        try { await s.configure(w, h) } catch { f.close(); continue }
      }
      if (s.venc.state !== 'configured') { s.n.skipped++; f.close(); continue }
      s.n.sent++
      s.lastTs = f.timestamp
      const now = performance.now()
      const key = s.key || s.cfg.keyOnly || now - s.lastKeyAt > s.cfg.gopSec * 1000
      if (key) { s.key = false; s.lastKeyAt = now }
      s.venc.encode(f, { keyFrame: key })
      // kept so a phone that asks for a whole picture gets one even when the screen is standing still
      if (s.last) s.last.close()
      s.last = f
    }
  })()
  return { codec: codecFor(width, height), width, height, audio: Boolean(at) }
}

function sound(s, at) {
  s.ar = new MediaStreamTrackProcessor({ track: at }).readable.getReader()
  ;(async () => {
    while (!s.dead) {
      let r
      try { r = await s.ar.read() } catch { break }
      if (r.done) break
      const d = r.value
      if (!s.aenc) {
        s.aenc = new AudioEncoder({
          output: (ch) => { const b = new Uint8Array(ch.byteLength); ch.copyTo(b); window.encSend('a', true, ch.timestamp, b) },
          error: () => {}
        })
        // 64 kbit/s: clear enough for a PC's sound, and little on a link that also carries the picture
        s.aenc.configure({ codec: 'opus', sampleRate: 48000, numberOfChannels: Math.min(2, d.numberOfChannels), bitrate: 64000 })
        s.channels = Math.min(2, d.numberOfChannels)
      }
      if (s.aenc.state === 'configured' && d.sampleRate === 48000 && d.numberOfChannels === s.channels) s.aenc.encode(d)
      d.close()
    }
  })()
}

window.__enc = {
  start,
  stop,
  configure(c) {
    if (!st) return
    st.cfg = c
    // the capture itself gets smaller and rarer with the step, which is also what costs the PC least
    if (st.vt && st.venc) st.vt.applyConstraints(limits(c)).catch(() => {})
  },
  key() {
    if (!st || !st.venc) return
    st.key = true
    // a still screen sends no new picture: the last one is sent again, whole
    if (st.last && st.venc.state === 'configured' && st.venc.encodeQueueSize < 3 && st.last.displayWidth === st.encW) {
      try { st.venc.encode(st.last, { keyFrame: true }); st.key = false; st.lastKeyAt = performance.now() } catch {}
    }
  }
}
</script>`

export class EncoderHost implements ScreenVideo {
  private win?: BrowserWindow
  private loading?: Promise<void>
  private video?: (c: VideoChunk) => void
  private audio?: (c: { ts: number; data: Buffer }) => void
  private target?: DisplayInfo
  private wantAudio = false
  private idle?: NodeJS.Timeout
  private bound = false

  /** `videoOff`: only the PC's sound is captured here (the picture comes from elsewhere). */
  constructor(private videoOff = false) {}

  available(): boolean {
    return true
  }

  onVideo(cb: (c: VideoChunk) => void): void {
    this.video = cb
  }

  onAudio(cb: (c: { ts: number; data: Buffer }) => void): void {
    this.audio = cb
  }

  private async window(): Promise<BrowserWindow> {
    if (this.idle) clearTimeout(this.idle)
    this.idle = undefined
    if (this.win && !this.win.isDestroyed()) {
      await this.loading
      return this.win
    }
    const dir = path.join(app.getPath('userData'), 'remote-encoder')
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'preload.js'), PRELOAD)
    fs.writeFileSync(path.join(dir, 'index.html'), PAGE)
    // each window has its own session: the capture handler below answers for this one only
    const ses = session.fromPartition(this.videoOff ? 'jolty-encoder-sound' : 'jolty-encoder')
    ses.setDisplayMediaRequestHandler((_request, callback) => {
      void desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 1, height: 1 } }).then((all) => {
        const d = this.target
        const src = d ? all.find((s) => s.display_id === String(d.id)) || all[d.index] : all[0]
        callback(src ? { video: src, ...(this.wantAudio && process.platform === 'win32' ? { audio: 'loopback' as const } : {}) } : {})
      })
    })
    const win = new BrowserWindow({
      show: false,
      width: 320,
      height: 200,
      webPreferences: { session: ses, preload: path.join(dir, 'preload.js'), contextIsolation: true, sandbox: true, nodeIntegration: false, backgroundThrottling: false }
    })
    // JOLTY_DEBUG_ENC=<file>: what the encoder page measures goes to that file
    if (process.env.JOLTY_DEBUG_ENC) win.webContents.on('console-message', (e) => fs.appendFileSync(process.env.JOLTY_DEBUG_ENC as string, String((e as unknown as { message?: string }).message ?? '') + '\n'))
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    win.webContents.on('will-navigate', (e) => e.preventDefault())
    this.win = win
    if (!this.bound) {
      this.bound = true
      ipcMain.on('jolty-enc', (e, kind: string, key: boolean, ts: number, bytes: Uint8Array) => {
        // only our own hidden window may speak on this channel
        if (!this.win || this.win.isDestroyed() || e.sender !== this.win.webContents) return
        const data = Buffer.from(bytes)
        if (kind === 'v') this.video?.({ key, ts, data })
        else if (kind === 'a') this.audio?.({ ts, data })
      })
    }
    this.loading = win.loadFile(path.join(dir, 'index.html')).then(() => undefined)
    await this.loading
    return win
  }

  private run<T>(win: BrowserWindow, code: string): Promise<T> {
    // true: the page may start a capture without a click, which Chromium otherwise asks for
    return win.webContents.executeJavaScript(code, true) as Promise<T>
  }

  async start(display: DisplayInfo, opts: { audio: boolean; config: EncoderConfig }): Promise<VideoStart> {
    this.target = display
    this.wantAudio = opts.audio
    const win = await this.window()
    return this.run<VideoStart>(win, `window.__enc.start(${JSON.stringify({ config: opts.config, videoOff: this.videoOff, audio: opts.audio && process.platform === 'win32' })})`)
  }

  stop(): void {
    const win = this.win
    if (!win || win.isDestroyed()) return
    void this.run(win, 'window.__enc.stop()').catch(() => undefined)
    // kept a little while: a phone that comes back soon starts at once
    if (this.idle) clearTimeout(this.idle)
    this.idle = setTimeout(() => this.dispose(), 20_000)
  }

  keyframe(): void {
    if (this.win && !this.win.isDestroyed()) void this.run(this.win, 'window.__enc.key()').catch(() => undefined)
  }

  configure(c: EncoderConfig): void {
    if (this.win && !this.win.isDestroyed()) void this.run(this.win, `window.__enc.configure(${JSON.stringify(c)})`).catch(() => undefined)
  }

  /** The window goes; the app is quitting or nobody has watched for a while. */
  dispose(): void {
    if (this.idle) clearTimeout(this.idle)
    this.idle = undefined
    if (this.win && !this.win.isDestroyed()) this.win.destroy()
    this.win = undefined
  }
}
