// The PC's screen (and sound) as H.264 and Opus, made in a hidden window with Chromium's own capture and WebCodecs, so the
// video is encoded on the graphics chip and a phone can play it smoothly. The window is ours, loads only a file we write,
// and the chunks come back over IPC to remote-screen.ts, which sends them to the phones.
import { app, BrowserWindow, desktopCapturer, ipcMain, session } from 'electron'
import fs from 'fs'
import path from 'path'
import type { DisplayInfo } from './computer/geometry'
import type { ScreenVideo, VideoChunk, VideoStart } from './remote-screen'

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

async function start(o) {
  await stop()
  const stream = await navigator.mediaDevices.getDisplayMedia({
    video: { width: { ideal: o.width, max: o.width }, height: { ideal: o.height, max: o.height }, frameRate: { ideal: o.fps, max: o.fps } },
    audio: o.audio ? { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 2 } : false
  })
  const vt = stream.getVideoTracks()[0]
  const set = vt.getSettings()
  const width = even(set.width || o.width)
  const height = even(set.height || o.height)
  const s = (st = { stream, dead: false, key: true, lastKeyAt: 0, last: null, bps: o.bitrate, size: { width, height } })
  const codec = width * height > 1920 * 1088 ? 'avc1.640032' : 'avc1.64002A'
  const configure = async () => {
    const cfg = { codec, width, height, bitrate: s.bps, framerate: o.fps, latencyMode: 'realtime', bitrateMode: 'variable', avc: { format: 'annexb' }, hardwareAcceleration: 'prefer-hardware' }
    const hw = await VideoEncoder.isConfigSupported(cfg)
    if (!hw.supported) cfg.hardwareAcceleration = 'no-preference'
    s.venc.configure(cfg)
  }
  s.configure = configure
  s.venc = new VideoEncoder({
    output: (c) => {
      const b = new Uint8Array(c.byteLength)
      c.copyTo(b)
      window.encSend('v', c.type === 'key', c.timestamp, b)
    },
    error: (e) => window.encSend('e', false, 0, new TextEncoder().encode(String(e && e.message || e)))
  })
  await configure()

  s.vr = new MediaStreamTrackProcessor({ track: vt }).readable.getReader()
  s.n = { got: 0, sent: 0, skipped: 0 }
  s.stats = setInterval(() => { console.log('enc-stats ' + JSON.stringify({ ...s.n, q: s.venc.encodeQueueSize })); s.n = { got: 0, sent: 0, skipped: 0 } }, 1000)
  ;(async () => {
    while (!s.dead) {
      let r
      try { r = await s.vr.read() } catch { break }
      if (r.done) break
      const f = r.value
      s.n.got++
      if (s.venc.state !== 'configured' || s.venc.encodeQueueSize > 3) { s.n.skipped++; f.close(); continue }
      s.n.sent++
      const now = performance.now()
      const key = s.key || now - s.lastKeyAt > 2000
      if (key) { s.key = false; s.lastKeyAt = now }
      s.venc.encode(f, { keyFrame: key })
      // kept so a phone that asks for a whole picture gets one even when the screen is standing still
      if (s.last) s.last.close()
      s.last = f
    }
  })()

  const at = stream.getAudioTracks()[0]
  if (at) {
    s.ar = new MediaStreamTrackProcessor({ track: at }).readable.getReader()
    ;(async () => {
      while (!s.dead) {
        let r
        try { r = await s.ar.read() } catch { break }
        if (r.done) break
        const d = r.value
        if (!s.aenc) {
          s.aenc = new AudioEncoder({
            output: (c) => { const b = new Uint8Array(c.byteLength); c.copyTo(b); window.encSend('a', true, c.timestamp, b) },
            error: () => {}
          })
          s.aenc.configure({ codec: 'opus', sampleRate: 48000, numberOfChannels: Math.min(2, d.numberOfChannels), bitrate: 96000 })
          s.channels = Math.min(2, d.numberOfChannels)
        }
        if (s.aenc.state === 'configured' && d.sampleRate === 48000 && d.numberOfChannels === s.channels) s.aenc.encode(d)
        d.close()
      }
    })()
  }
  return { codec, width, height, audio: Boolean(at) }
}

window.__enc = {
  start,
  stop,
  async bitrate(bps) {
    if (!st) return
    st.bps = bps
    st.key = true
    try { await st.configure() } catch {}
  },
  key() {
    if (!st) return
    st.key = true
    // a still screen sends no new picture: the last one is sent again, whole
    if (st.last && st.venc.state === 'configured' && st.venc.encodeQueueSize < 3) {
      try { st.venc.encode(st.last, { keyFrame: true }); st.key = false; st.lastKeyAt = performance.now() } catch {}
    }
  }
}
</script>`

/** Dimensions the capture is asked for: the display, scaled to fit what a phone can use. */
function fit(d: DisplayInfo, edge: number): { width: number; height: number } {
  const s = Math.min(1, edge / Math.max(d.w, d.h))
  return { width: Math.max(2, Math.round(d.w * s)), height: Math.max(2, Math.round(d.h * s)) }
}

export class EncoderHost implements ScreenVideo {
  private win?: BrowserWindow
  private loading?: Promise<void>
  private video?: (c: VideoChunk) => void
  private audio?: (c: { ts: number; data: Buffer }) => void
  private target?: DisplayInfo
  private wantAudio = false
  private idle?: NodeJS.Timeout
  private bound = false

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
    const ses = session.fromPartition('jolty-encoder')
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
    // JOLTY_DEBUG_ENC=1: what the encoder page measures goes to the log
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

  async start(display: DisplayInfo, opts: { audio: boolean }): Promise<VideoStart> {
    this.target = display
    this.wantAudio = opts.audio
    const win = await this.window()
    const size = fit(display, 1920)
    return this.run<VideoStart>(win, `window.__enc.start(${JSON.stringify({ ...size, fps: 60, bitrate: 6_000_000, audio: opts.audio && process.platform === 'win32' })})`)
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

  bitrate(bps: number): void {
    if (this.win && !this.win.isDestroyed()) void this.run(this.win, `window.__enc.bitrate(${Math.round(bps)})`).catch(() => undefined)
  }

  /** The window goes; the app is quitting or nobody has watched for a while. */
  dispose(): void {
    if (this.idle) clearTimeout(this.idle)
    this.idle = undefined
    if (this.win && !this.win.isDestroyed()) this.win.destroy()
    this.win = undefined
  }
}
