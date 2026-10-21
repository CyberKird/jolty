// Downloads Microsoft's Visual C++ runtime installer into build/redist so the Windows setup can ship it.
import { execFileSync } from 'child_process'
import fs from 'fs'
import path from 'path'

const url = 'https://aka.ms/vs/17/release/vc_redist.x64.exe'
const target = path.resolve('build/redist/vc_redist.x64.exe')

if (fs.existsSync(target) && fs.statSync(target).size > 1e6) {
  console.log('vc_redist.x64.exe already present')
} else {
  fs.mkdirSync(path.dirname(target), { recursive: true })
  const res = await fetch(url, { redirect: 'follow' })
  if (!res.ok) throw new Error(`download failed: ${res.status} ${res.statusText}`)
  const data = Buffer.from(await res.arrayBuffer())
  // a real installer is a Windows executable of several megabytes
  if (data.length < 1e6 || data.toString('latin1', 0, 2) !== 'MZ') throw new Error('the download is not the VC++ installer')
  fs.writeFileSync(target, data)
  console.log(`vc_redist.x64.exe downloaded (${(data.length / 1e6).toFixed(1)} MB)`)
}

// whisper-cli built with Vulkan by .github/workflows/whisper.yml, for voice input in the composer
const whisperTag = 'whisper-v1.9.5'
const whisperExe = path.resolve('build/whisper/whisper-cli.exe')
if (fs.existsSync(whisperExe) && fs.statSync(whisperExe).size > 1e6) {
  console.log('whisper-cli.exe already present')
} else {
  const dir = path.dirname(whisperExe)
  fs.mkdirSync(dir, { recursive: true })
  const res = await fetch(`https://github.com/CyberKird/jolty/releases/download/${whisperTag}/whisper-vulkan-win-x64.zip`, { redirect: 'follow' })
  if (!res.ok) throw new Error(`whisper download failed: ${res.status} ${res.statusText}`)
  const zip = path.join(dir, 'whisper.zip')
  fs.writeFileSync(zip, Buffer.from(await res.arrayBuffer()))
  // Windows' own tar reads zip files (a Git Bash or MSYS tar first on PATH does not)
  execFileSync(path.join(process.env.SystemRoot || 'C:/Windows', 'System32', 'tar.exe'), ['-xf', zip, '-C', dir])
  fs.rmSync(zip)
  if (fs.readFileSync(whisperExe).toString('latin1', 0, 2) !== 'MZ') throw new Error('whisper-cli.exe is not a Windows executable')
  console.log('whisper-cli.exe downloaded')
}
