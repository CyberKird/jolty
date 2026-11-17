// Measures how many frames per second Chromium's screen capture really delivers on this PC, and what it costs.
// Run by test/capture-bench/run.mjs once per variant (switches are per process). A small window animates in a corner so
// the screen changes every refresh; a hidden window captures the primary display with getDisplayMedia and counts frames
// (and optionally encodes them with WebCodecs). Nothing is clicked; the mover ignores the mouse and takes no focus.
const { app, BrowserWindow, desktopCapturer, session, screen } = require('electron')
const fs = require('fs')
const os = require('os')
const path = require('path')

// The user works on this PC: an error must never become a dialog on their screen. It is printed and the bench exits.
const fail = (what, e) => {
  process.stdout.write('BENCH-ERROR ' + what + ': ' + String((e && e.stack) || e) + '\n')
  app.exit(1)
}
process.on('uncaughtException', (e) => fail('uncaught', e))
process.on('unhandledRejection', (e) => fail('unhandled', e))
app.on('render-process-gone', (_e, _wc, d) => fail('renderer gone', d && d.reason))
app.on('child-process-gone', (_e, d) => d && d.type === 'GPU' && fail('gpu gone', d.reason))

const cfg = JSON.parse(process.env.BENCH_CFG || '{}')
for (const s of cfg.switches || []) {
  const [k, v] = s.split('=')
  if (v === undefined) app.commandLine.appendSwitch(k)
  else app.commandLine.appendSwitch(k, v)
}
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'jolty-capbench-')))

const PAGE = `<!doctype html><meta charset="utf-8"><script>
window.run = async (o) => {
  const stream = o.legacy ? await navigator.mediaDevices.getUserMedia({ audio: false, video: { mandatory: { chromeMediaSource: 'desktop', chromeMediaSourceId: o.legacy, maxWidth: 1920, maxHeight: 1080, maxFrameRate: 60, minFrameRate: 30 } } }) : await navigator.mediaDevices.getDisplayMedia({ video: o.video, audio: false })
  const vt = stream.getVideoTracks()[0]
  const r = new MediaStreamTrackProcessor({ track: vt }).readable.getReader()
  let enc, out = 0, keys = 0, bytes = 0, encMs = []
  const pend = new Map()
  if (o.encode) {
    const set = vt.getSettings()
    enc = new VideoEncoder({ output: (c) => { out++; bytes += c.byteLength; if (c.type === 'key') keys++; const t = pend.get(c.timestamp); if (t) { encMs.push(performance.now() - t); pend.delete(c.timestamp) } }, error: (e) => console.log('enc error ' + e.message) })
    const ec = { codec: (set.width * set.height > 1920 * 1088) ? 'avc1.640033' : 'avc1.64002A', width: set.width & ~1, height: set.height & ~1, bitrate: 6e6, framerate: 60, latencyMode: 'realtime', bitrateMode: 'variable', avc: { format: 'annexb' }, hardwareAcceleration: 'prefer-hardware' }
    enc.configure(ec)
  }
  const ts = []
  const t0 = performance.now()
  let first = 0
  while (performance.now() - t0 < o.ms) {
    const { value: f, done } = await r.read()
    if (done) break
    const now = performance.now()
    if (now - t0 > 1000) {
      if (!first) first = now
      ts.push(now)
      if (enc && enc.encodeQueueSize < 3) { pend.set(f.timestamp, now); enc.encode(f, { keyFrame: false }) }
    }
    f.close()
  }
  const set = vt.getSettings()
  vt.stop()
  if (enc) { await enc.flush(); enc.close() }
  const secs = (ts[ts.length - 1] - first) / 1000
  const gaps = ts.slice(1).map((t, i) => t - ts[i]).sort((a, b) => a - b)
  const pct = (p) => gaps.length ? Math.round(gaps[Math.min(gaps.length - 1, Math.floor(gaps.length * p))] * 10) / 10 : 0
  encMs.sort((a, b) => a - b)
  return { fps: Math.round(((ts.length - 1) / secs) * 10) / 10, gapP50: pct(0.5), gapP95: pct(0.95), w: set.width, h: set.height, reqFps: set.frameRate, encOut: o.encode ? Math.round((out / secs) * 10) / 10 : undefined, encKeys: keys, kbps: o.encode ? Math.round((bytes * 8) / secs / 1000) : undefined, encP50: encMs.length ? Math.round(encMs[encMs.length >> 1] * 10) / 10 : undefined }
}
</script>`

app.whenReady().then(async () => {
  const d = screen.getPrimaryDisplay()
  const wa = d.workArea
  // the moving bar: a full redraw of 640x360 every refresh
  const mover = new BrowserWindow({ x: wa.x + 40, y: wa.y + 40, width: 640, height: 360, show: true, frame: false, alwaysOnTop: true, focusable: false, skipTaskbar: true, webPreferences: { backgroundThrottling: false } })
  mover.setIgnoreMouseEvents(true)
  await mover.loadURL('data:text/html,<body style="margin:0;background:%23111"><div id=b style="position:absolute;top:0;width:90px;height:100%25;background:%23d4ff00"></div><script>let x=0;window.n=0;function f(){window.n++;x=(x+9)%25560;b.style.left=x+"px";requestAnimationFrame(f)}f()</script>')
  const ses = session.fromPartition('capbench')
  ses.setDisplayMediaRequestHandler((_req, cb) => {
    void desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 1, height: 1 } }).then((all) => {
      cb({ video: all.find((s) => s.display_id === String(d.id)) || all[0] })
    })
  })
  const dir = app.getPath('userData')
  fs.writeFileSync(path.join(dir, 'p.html'), PAGE)
  const win = new BrowserWindow({ show: false, webPreferences: { session: ses, backgroundThrottling: false } })
  win.webContents.on('console-message', (e) => process.stderr.write('page: ' + (e.message ?? '') + '\n'))
  await win.loadFile(path.join(dir, 'p.html'))
  // CPU of every process while it runs (percent of one core, summed)
  const cum0 = new Map(app.getAppMetrics().map((p) => [p.pid, p.cpu.cumulativeCPUUsage || 0]))
  if (cfg.legacy) cfg.run.legacy = (await desktopCapturer.getSources({ types: ['screen'] })).find((s) => s.display_id === String(d.id)).id
  if (cfg.moverOnly) {
    const c0 = new Map(app.getAppMetrics().map((p) => [p.pid, p.cpu.cumulativeCPUUsage || 0]))
    const s0 = Date.now()
    await new Promise((r) => setTimeout(r, cfg.moverOnly))
    const cpu = {}
    for (const p of app.getAppMetrics()) cpu[p.type] = Math.round(((cpu[p.type] || 0) + ((p.cpu.cumulativeCPUUsage || 0) - (c0.get(p.pid) || 0)) / ((Date.now() - s0) / 1000) * 100) * 10) / 10
    process.stdout.write('RESULT ' + JSON.stringify({ name: cfg.name, cpu }) + '\n')
    mover.destroy()
    win.destroy()
    return app.quit()
  }
  const n0 = await mover.webContents.executeJavaScript('window.n')
  const t0 = Date.now()
  const res = await win.webContents.executeJavaScript(`window.run(${JSON.stringify(cfg.run)})`, true)
  const moverFps = Math.round(((await mover.webContents.executeJavaScript('window.n')) - n0) / ((Date.now() - t0) / 1000))
  const m = app.getAppMetrics()
  const cpu = {}
  const secs = (Date.now() - t0) / 1000
  for (const p of m) cpu[p.type] = Math.round(((cpu[p.type] || 0) + ((p.cpu.cumulativeCPUUsage || 0) - (cum0.get(p.pid) || 0)) / secs * 100) * 10) / 10
  process.stdout.write('RESULT ' + JSON.stringify({ name: cfg.name, moverFps, ...res, cpu, hz: d.displayFrequency, phys: Math.round(d.size.width * d.scaleFactor) + 'x' + Math.round(d.size.height * d.scaleFactor) }) + '\n')
  mover.destroy()
  win.destroy()
  app.quit()
})
