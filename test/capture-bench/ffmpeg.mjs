// What the ffmpeg path costs: ddagrab (DXGI Desktop Duplication, frames stay on the GPU) -> scale_d3d11 -> hardware H.264.
// node test/capture-bench/ffmpeg.mjs [seconds] [width] [height] [fps] [encoder]
// Prints real output frames per second (frames are only made when the screen changes: dup_frames=0) and the CPU it used.
import { execFileSync, spawn } from 'node:child_process'

const [secs = 10, w = 1920, h = 1080, fps = 60, enc = 'h264_amf'] = process.argv.slice(2).map((v, i) => (i < 4 ? Number(v) : v))
const ff = process.env.JOLTY_FFMPEG || 'ffmpeg'
const args = ['-hide_banner', '-loglevel', 'error', '-nostdin', '-init_hw_device', 'd3d11va', '-filter_complex', `ddagrab=output_idx=0:framerate=${fps}:draw_mouse=0:dup_frames=0,scale_d3d11=width=${w}:height=${h}:format=nv12`, '-c:v', enc, ...(enc === 'h264_amf' ? ['-usage', 'ultralowlatency'] : []), '-bf', '0', '-b:v', '6M', '-t', String(secs), '-f', 'flv', 'pipe:1']
const t0 = Date.now()
const child = spawn(ff, args, { stdio: ['ignore', 'pipe', 'inherit'] })
console.error(`[pid ${child.pid}]`)
let buf = Buffer.alloc(0)
let frames = 0
let firstAt = 0
let header = false
child.stdout.on('data', (d) => {
  buf = Buffer.concat([buf, d])
  // FLV: 9 byte header + 4, then tags of 11 + size + 4
  let at = 0
  if (!header) {
    if (buf.length < 13) return
    header = true
    at = 13
  }
  while (buf.length - at >= 11) {
    const size = buf.readUIntBE(at + 1, 3)
    if (buf.length - at < 11 + size + 4) break
    if (buf[at] === 9 && buf[at + 12] === 1) {
      frames++
      if (frames === 1) firstAt = Date.now() - t0
    }
    at += 11 + size + 4
  }
  buf = buf.subarray(at)
})
let cpu = 0
const probe = setTimeout(() => {
  try {
    cpu = Number(execFileSync('powershell', ['-NoProfile', '-Command', `(Get-Process -Id ${child.pid}).TotalProcessorTime.TotalMilliseconds`]).toString().trim())
  } catch {}
}, (secs - 1) * 1000)
child.on('exit', () => {
  clearTimeout(probe)
  console.log(JSON.stringify({ enc, size: `${w}x${h}`, fps, frames, outFps: Math.round((frames / secs) * 10) / 10, firstFrameMs: firstAt, cpuPctOfOneCore: Math.round((cpu / 1000 / (secs - 1)) * 1000) / 10, }))
})
