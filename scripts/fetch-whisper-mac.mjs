// Downloads the macOS whisper-cli (Metal) built by .github/workflows/whisper.yml into build/whisper-mac, for voice input.
// A missing asset only warns: the app then builds without dictation (voice.ts reports it as not included).
import { execFileSync } from 'child_process'
import fs from 'fs'
import path from 'path'

const tag = 'whisper-v1.9.5'
const arch = process.arch === 'arm64' ? 'arm64' : 'x64'
const dir = path.resolve('build/whisper-mac')
const exe = path.join(dir, 'whisper-cli')
// electron-builder copies this folder whether or not the download worked
fs.mkdirSync(dir, { recursive: true })

if (fs.existsSync(exe) && fs.statSync(exe).size > 1e5) {
  console.log('whisper-cli already present')
} else {
  const res = await fetch(`https://github.com/CyberKird/jolty/releases/download/${tag}/whisper-metal-mac-${arch}.zip`, { redirect: 'follow' })
  if (!res.ok) {
    console.warn(`whisper-cli for macOS ${arch} not available (${res.status}): building without voice input. Run the whisper workflow first.`)
  } else {
    const zip = path.join(dir, 'whisper.zip')
    fs.writeFileSync(zip, Buffer.from(await res.arrayBuffer()))
    // unzip keeps the executable bit
    execFileSync('unzip', ['-o', zip, '-d', dir])
    fs.rmSync(zip)
    fs.chmodSync(exe, 0o755)
    console.log('whisper-cli downloaded')
  }
}
