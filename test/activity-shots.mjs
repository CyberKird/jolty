// Screenshots and cost of the activity board (ActivityGraph, Liquid) from the dev gallery (test/activity-gallery), no app data needed.
//   node test/activity-shots.mjs shots   [LABEL=before] [SHOTS=out-test/activity]  every theme x widths
//   node test/activity-shots.mjs perf    [LABEL=before]                             GPU 3D % + CPU % per state, one small window
// Builds the gallery first (vite). One Electron process, one window, closed at the end.
import { execFileSync, spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import http from 'node:http'

const root = path.resolve(import.meta.dirname, '..')
const mode = process.argv[2] || 'shots'
const label = process.env.LABEL || 'now'
const shots = path.resolve(process.env.SHOTS || path.join(root, 'out-test/activity'))
fs.mkdirSync(shots, { recursive: true })

if (!process.env.NOBUILD) execFileSync(process.execPath, [path.join(root, 'node_modules/vite/bin/vite.js'), 'build', '--config', 'test/activity-gallery/vite.config.mjs', '--logLevel', 'warn'], { cwd: root, stdio: 'inherit' })
// served over http (module scripts do not load from file:)
const dir = path.join(root, 'out-test/activity-gallery')
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.woff': 'font/woff', '.svg': 'image/svg+xml', '.png': 'image/png' }
const server = http.createServer((req, res) => {
  const f = path.join(dir, decodeURIComponent(new URL(req.url, 'http://x').pathname))
  if (!f.startsWith(dir) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) return res.writeHead(404).end()
  res.writeHead(200, { 'content-type': types[path.extname(f)] || 'application/octet-stream' }).end(fs.readFileSync(f))
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const page = `http://127.0.0.1:${server.address().port}/index.html`
const THEMES = (process.env.THEMES || 'volt,glass,frost').split(',')

const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE
const electron = path.join(root, 'node_modules/electron/dist/electron.exe')
const userData = fs.mkdtempSync(path.join(process.env.TEMP || '/tmp', 'jolty-agshots-'))

function run(extra) {
  return new Promise((resolve, reject) => {
    const p = spawn(electron, [path.join(root, 'test/activity-gallery/shot-main.cjs'), '--user-data-dir=' + userData], { env: { ...env, ...extra }, stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    p.stdout.on('data', (d) => (out += d))
    p.stderr.on('data', (d) => process.stderr.write(d))
    const kill = setTimeout(() => p.kill(), 300000)
    p.on('exit', (c) => {
      clearTimeout(kill)
      c === 0 ? resolve(out) : reject(new Error('electron exit ' + c + '\n' + out))
    })
  })
}

if (mode === 'shots') {
  const jobs = []
  const sizes = (process.env.WIDTHS || '372,360,390,430').split(',').map(Number)
  for (const t of THEMES)
    for (const w of sizes) jobs.push({ url: `${page}?theme=${t}&w=${w}`, w, h: 1180, out: path.join(shots, `${label}-${t}-${w}.png`) })
  for (const t of THEMES) jobs.push({ url: `${page}?theme=${t}&w=372&lp=1`, w: 372, h: 1180, out: path.join(shots, `${label}-${t}-lowpower.png`) })
  // the first page of a fresh process paints late (fonts): give it longer
  if (jobs[0]) jobs[0].wait = 4000
  await run({ JOBS: JSON.stringify(jobs), DSF: process.env.DSF || '2' })
  console.log('shots in', shots)
} else {
  const results = []
  for (const t of (process.env.THEMES || 'volt').split(','))
    for (const state of (process.env.STATES || 'blank,idle,run').split(',')) {
      const out = await run({ PERF: JSON.stringify({ url: `${page}?theme=${t}&w=372&state=${state}`, w: 420, h: 520, seconds: Number(process.env.SECONDS || 10), label: `${t}-${state}` }), DSF: '1.5' })
      const line = out.split('\n').find((l) => l.startsWith('PERF '))
      if (line) results.push(JSON.parse(line.slice(5)))
    }
  for (const r of results) console.log(`${r.label.padEnd(12)} gpu3d ${String(r.gpu3d).padStart(6)} %   cpu ${String(r.cpuTotal).padStart(6)} %  ${r.cpu.map((c) => c.type[0] + ':' + c.cpu).join(' ')}`)
  fs.writeFileSync(path.join(shots, `perf-${label}.json`), JSON.stringify(results, null, 1))
}
fs.rmSync(userData, { recursive: true, force: true })
server.close()
