// Runs test/capture-bench/main.cjs once per variant and prints a table: real capture fps, frame gaps, encoder output and CPU.
// node test/capture-bench/run.mjs [filter]
import { spawn } from 'node:child_process'
import path from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const electron = require('electron')
const main = path.resolve('test/capture-bench/main.cjs')
const W1080 = { width: { ideal: 1920, max: 1920 }, height: { ideal: 1080, max: 1080 } }
const W720 = { width: { ideal: 1280, max: 1280 }, height: { ideal: 720, max: 720 } }
const FULL = { width: { ideal: 3840, max: 3840 }, height: { ideal: 2160, max: 2160 } }
const fr = (n) => ({ frameRate: { ideal: n, max: n } })
const CPU100 = 'webrtc-max-cpu-consumption-percentage=100'
const variants = [
  { name: 'legacy chromeMediaSource 1080p60', legacy: true, switches: [], run: { ms: 6000 } },
  { name: 'mover only', moverOnly: 30000, switches: [], run: {} },
  { name: 'no-wgc 1080p60', switches: ['disable-features=AllowWgcScreenCapturer'], run: { video: { ...W1080, ...fr(60) }, ms: 6000 } },
  { name: 'no-zerohz 1080p60', switches: ['disable-features=AllowWgcZeroHz,AllowDxgiGdiZeroHz'], run: { video: { ...W1080, ...fr(60) }, ms: 6000 } },
  { name: '1080p144', switches: [], run: { video: { ...W1080, ...fr(144) }, ms: 6000 } },
  { name: 'baseline 1080p60 (as shipped)', switches: [], run: { video: { ...W1080, ...fr(60) }, ms: 6000 } },
  { name: '1080p60 cpu100', switches: [CPU100], run: { video: { ...W1080, ...fr(60) }, ms: 6000 } },
  { name: '720p60', switches: [], run: { video: { ...W720, ...fr(60) }, ms: 6000 } },
  { name: '720p60 cpu100', switches: [CPU100], run: { video: { ...W720, ...fr(60) }, ms: 6000 } },
  { name: '4K60', switches: [], run: { video: { ...FULL, ...fr(60) }, ms: 6000 } },
  { name: '4K60 cpu100', switches: [CPU100], run: { video: { ...FULL, ...fr(60) }, ms: 6000 } },
  { name: '1080p60 wgc', switches: ['enable-features=AllowWgcScreenCapturer'], run: { video: { ...W1080, ...fr(60) }, ms: 6000 } },
  { name: '1080p60 wgc cpu100', switches: ['enable-features=AllowWgcScreenCapturer', CPU100], run: { video: { ...W1080, ...fr(60) }, ms: 6000 } },
  { name: '1080p60 cpu100 + encode', switches: [CPU100], run: { video: { ...W1080, ...fr(60) }, ms: 6000, encode: true } },
  { name: 'baseline 1080p60 + encode', switches: [], run: { video: { ...W1080, ...fr(60) }, ms: 6000, encode: true } },
  { name: '1080p30 cpu100 + encode', switches: [CPU100], run: { video: { ...W1080, ...fr(30) }, ms: 6000, encode: true } }
]
const filter = process.argv[2] ? new RegExp(process.argv[2], 'i') : undefined

for (const v of variants.filter((x) => !filter || filter.test(x.name))) {
  const env = { ...process.env, BENCH_CFG: JSON.stringify(v) }
  delete env.ELECTRON_RUN_AS_NODE
  const child = spawn(electron, [main], { env, stdio: ['ignore', 'pipe', 'pipe'] })
  console.error(`[pid ${child.pid}] ${v.name}`)
  let out = ''
  child.stdout.on('data', (b) => (out += b))
  child.stderr.on('data', (b) => /page:|error/i.test(String(b)) && process.stderr.write(String(b)))
  const killer = setTimeout(() => child.kill(), 40000)
  await new Promise((r) => child.on('exit', r))
  clearTimeout(killer)
  for (const l of out.split('\n').filter((x) => x.startsWith('BENCH-ERROR '))) console.error(l)
  const line = out.split('\n').find((l) => l.startsWith('RESULT '))
  console.log(line ? line.slice(7) : JSON.stringify({ name: v.name, error: 'no result' }))
}
