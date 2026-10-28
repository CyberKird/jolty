import { execFile } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { Readable } from 'stream'
import { pipeline } from 'stream/promises'
import { tr } from '@shared/i18n'

// OpenCode 1 stays on 1.19.4 and lost the free models, so Jolty installs OpenCode 2 from the update server.
// The "baseline" build is for CPUs without AVX2, so it is the fallback.
const BASE = 'https://opencode.ai/update/api/latest/cli/opencode/'
const ZIPS = ['opencode-windows-x64.zip', 'opencode-windows-x64-baseline.zip']

/** Where OpenCode's own install script puts the binary; opencodeExecutable() already looks here. */
export const opencodeHome = (): string => path.join(os.homedir(), '.opencode', 'bin')

function run(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) =>
    execFile(cmd, args, { timeout: 60000, windowsHide: true }, (err, out, errOut) => (err ? reject(new Error(String(errOut || err.message).slice(0, 300))) : resolve(String(out))))
  )
}

function findExe(dir: string): string | undefined {
  for (const f of fs.readdirSync(dir, { recursive: true }) as string[]) if (path.basename(f).toLowerCase() === 'opencode.exe') return path.join(dir, f)
  return undefined
}

/** Downloads OpenCode into `dir` (no Node or npm needed), checks that it starts, and returns the path. */
export async function installOpencode(dir = opencodeHome()): Promise<string> {
  if (process.platform !== 'win32') throw new Error(tr("Instalarea automată e disponibilă doar pe Windows"))
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'jolty-opencode-'))
  let last = ''
  try {
    for (const name of ZIPS) {
      const zip = path.join(work, name)
      const res = await fetch(BASE + name)
      if (!res.ok || !res.body) throw new Error(`OpenCode: HTTP ${res.status}`)
      await pipeline(Readable.fromWeb(res.body as never), fs.createWriteStream(zip))
      const out = path.join(work, name.replace(/\.zip$/, ''))
      fs.mkdirSync(out)
      // System32 tar reads zip files; Git Bash's does not
      await run(path.join(process.env.WINDIR || 'C:\\Windows', 'System32', 'tar.exe'), ['-xf', zip, '-C', out])
      const found = findExe(out)
      if (!found) throw new Error('OpenCode: opencode.exe not found in the download')
      fs.mkdirSync(dir, { recursive: true })
      const target = path.join(dir, 'opencode.exe')
      fs.copyFileSync(found, target)
      try {
        await run(target, ['--version'])
        return target
      } catch (e) {
        last = (e as Error).message
      }
    }
    throw new Error(`OpenCode: the download does not start on this PC${last ? ` (${last})` : ''}`)
  } finally {
    fs.rmSync(work, { recursive: true, force: true })
  }
}
