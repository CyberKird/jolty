// Downloads Microsoft's Visual C++ runtime installer into build/redist so the Windows setup can ship it.
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
