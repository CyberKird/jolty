// Electron main for test/activity-shots.mjs: one window, reused for every job, closed at the end.
// JOBS (env, JSON): [{ url, w, h, out, wait }] screenshots; PERF (env, JSON): { url, w, h, seconds } measures CPU per process,
// GPU 3D engine use of this app's processes (Windows counter) and the page's frame rate, printed as one JSON line.
const { app, BrowserWindow } = require('electron')
const fs = require('fs')
const path = require('path')
const { execFileSync } = require('child_process')

process.on('uncaughtException', (e) => {
  console.error('MAIN ERROR', e)
  app.exit(1)
})
app.commandLine.appendSwitch('force-device-scale-factor', process.env.DSF || '1')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function gpu3d(pids, samples) {
  // the Windows counter for the 3D engine, summed over this app's processes, averaged over a few samples
  const ps = path.join(__dirname, 'gpu.ps1')
  try {
    const out = execFileSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ps, pids.join(','), String(samples)], { encoding: 'utf8', timeout: 60000 })
    return Number(out.trim())
  } catch (e) {
    return -1
  }
}

app.whenReady().then(async () => {
  const jobs = JSON.parse(process.env.JOBS || '[]')
  const perf = process.env.PERF ? JSON.parse(process.env.PERF) : null
  const win = new BrowserWindow({ show: false, x: 40, y: 40, width: 600, height: 900, paintWhenInitiallyHidden: true, webPreferences: { backgroundThrottling: false } })
  win.webContents.on('render-process-gone', (_e, d) => {
    console.error('RENDERER GONE', d)
    app.exit(1)
  })
  win.webContents.on('console-message', (_e, level, msg) => level >= 2 && console.error('PAGE', msg))
  for (const j of jobs) {
    win.setContentSize(j.w, j.h)
    await win.loadURL(j.url)
    await sleep(j.wait || 1600)
    const img = await win.webContents.capturePage()
    fs.writeFileSync(j.out, img.toPNG())
    console.log('shot', j.out)
  }
  if (perf) {
    win.setContentSize(perf.w, perf.h)
    win.showInactive()
    await win.loadURL(perf.url)
    await sleep(3000)
    // CPU: app.getAppMetrics percentCPUUsage is since the previous call
    app.getAppMetrics()
    const pids = app.getAppMetrics().map((m) => m.pid)
    const g = gpu3d(pids, Math.max(3, Math.round(perf.seconds / 2)))
    const m = app.getAppMetrics().map((x) => ({ type: x.type, cpu: Math.round(x.cpu.percentCPUUsage * 10) / 10 }))
    const total = Math.round(m.reduce((a, x) => a + x.cpu, 0) * 10) / 10
    console.log('PERF', JSON.stringify({ label: perf.label, gpu3d: g, cpuTotal: total, cpu: m }))
  }
  win.destroy()
  app.quit()
})
