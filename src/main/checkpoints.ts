// File undo for the engines that keep no copies of their own (Codex, OpenCode, Hermes): before each message the folder is
// committed to a shadow git repo that lives in Jolty's data folder, never inside the project. Undo puts the folder back to
// that commit. Claude Code has its own checkpoints (claude.ts rewind), so it does not come through here.
// shortcut: files of a nested git repo are not followed (git sees a gitlink) and big media/archives are skipped; upgrade if undo is wanted there.
import { execFile } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { tr } from '@shared/i18n'

const SKIP = [
  'node_modules/', '.git/', '.venv/', 'venv/', '__pycache__/', 'dist/', 'build/', 'out/', '.next/', 'target/', '.gradle/', '.cache/',
  '*.mp4', '*.mov', '*.mkv', '*.avi', '*.wav', '*.mp3', '*.zip', '*.7z', '*.rar', '*.iso', '*.exe', '*.dll', '*.blend', '*.psd', '*.prproj', '*.safetensors', '*.ckpt', '*.gguf', '*.glb', '*.fbx'
]
const LIMIT_MS = 15000
const ref = (itemId: string): string => `refs/jolty/${itemId.replace(/[^\w-]/g, '_')}`

function git(gitDir: string, cwd: string, args: string[]): Promise<string> {
  const base = ['--git-dir', gitDir, '--work-tree', cwd, '-c', 'core.autocrlf=false', '-c', 'core.safecrlf=false', '-c', 'core.quotepath=off', '-c', 'gc.auto=0', '-c', 'user.name=Jolty', '-c', 'user.email=jolty@localhost']
  return new Promise((resolve, reject) => {
    execFile('git', [...base, ...args], { cwd, timeout: LIMIT_MS, windowsHide: true, maxBuffer: 32 * 1024 * 1024 }, (err, out, errOut) => {
      if (!err) return resolve(String(out))
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return reject(new Error(tr("Git nu e instalat sau nu e în PATH.")))
      reject(new Error(String(errOut || err.message).trim()))
    })
  })
}

/** a folder that is too big or too personal to copy on every message */
function tooWide(cwd: string): boolean {
  const here = path.resolve(cwd)
  return here === path.parse(here).root || here === path.resolve(os.homedir())
}

const repoOf = (dataDir: string, sessionId: string): string => path.join(dataDir, 'checkpoints', `${sessionId.replace(/[^\w-]/g, '_')}.git`)

async function open(dataDir: string, sessionId: string, cwd: string): Promise<string> {
  const dir = repoOf(dataDir, sessionId)
  if (!fs.existsSync(path.join(dir, 'HEAD'))) {
    fs.mkdirSync(dir, { recursive: true })
    await git(dir, cwd, ['init', '-q'])
    fs.mkdirSync(path.join(dir, 'info'), { recursive: true })
    fs.writeFileSync(path.join(dir, 'info', 'exclude'), SKIP.join('\n') + '\n')
  }
  // a snapshot cut short by the time limit leaves its lock behind
  fs.rmSync(path.join(dir, 'index.lock'), { force: true })
  await git(dir, cwd, ['add', '-A'])
  return dir
}

/** Saves the folder as it is now, under the id of the message about to be sent. Never throws: a message must go out even when this cannot. */
export async function snapshot(dataDir: string, sessionId: string, cwd: string, itemId: string): Promise<void> {
  try {
    if (!fs.existsSync(cwd) || tooWide(cwd)) return
    const dir = await open(dataDir, sessionId, cwd)
    await git(dir, cwd, ['commit', '-q', '--allow-empty', '--no-verify', '-m', itemId])
    await git(dir, cwd, ['update-ref', ref(itemId), 'HEAD'])
  } catch (err) {
    console.warn('[checkpoints] snapshot failed:', err instanceof Error ? err.message : err)
  }
}

export interface Change {
  files: string[]
  insertions: number
  deletions: number
}

async function known(dir: string, cwd: string, itemId: string): Promise<void> {
  try {
    await git(dir, cwd, ['rev-parse', '--verify', '-q', ref(itemId)])
  } catch {
    throw new Error(tr("Nu există o copie a fișierelor pentru acest mesaj (de exemplu, a fost trimis înainte de actualizarea Jolty)."))
  }
}

/** What undoing to the state before this message would change; with `apply` it does it. */
export async function rewind(dataDir: string, sessionId: string, cwd: string, itemId: string, apply: boolean): Promise<Change> {
  if (!fs.existsSync(path.join(repoOf(dataDir, sessionId), 'HEAD'))) {
    throw new Error(tr("Nu există o copie a fișierelor pentru acest mesaj (de exemplu, a fost trimis înainte de actualizarea Jolty)."))
  }
  if (!fs.existsSync(cwd)) throw new Error(tr("Folderul {path} nu mai există.", { path: cwd }))
  const dir = await open(dataDir, sessionId, cwd)
  await known(dir, cwd, itemId)
  const change: Change = { files: [], insertions: 0, deletions: 0 }
  // the index now holds the folder as it is, so the difference to the saved commit is what undo would touch
  for (const line of (await git(dir, cwd, ['diff', '--cached', '--no-renames', '--numstat', '-z', ref(itemId)])).split('\0')) {
    const m = /^(\d+|-)\t(\d+|-)\t(.+)$/s.exec(line)
    if (!m) continue
    change.files.push(m[3])
    // numstat is the folder against the saved commit; undo goes the other way, so added and removed lines swap
    change.deletions += m[1] === '-' ? 0 : Number(m[1])
    change.insertions += m[2] === '-' ? 0 : Number(m[2])
  }
  if (apply && change.files.length) await git(dir, cwd, ['read-tree', '--reset', '-u', ref(itemId)])
  return change
}

/** Removes the copies of a chat that is gone. */
export function drop(dataDir: string, sessionId: string): void {
  fs.rmSync(repoOf(dataDir, sessionId), { recursive: true, force: true })
}
