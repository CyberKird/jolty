// Obsidian as a quiet background tool: while Jolty runs, Obsidian runs too, hidden (no window, no taskbar
// button), and one shortcut shows or hides it. Local only (no Obsidian Sync); the vault is zipped into a folder
// at start and at quit. Off unless `obsidianVault` is set in settings.
import { execFile, spawn } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'

const KEEP = 14
export const SHORTCUT = 'CommandOrControl+Alt+O'

let pid: number | undefined

const exePath = (): string => path.join(process.env.LOCALAPPDATA ?? '', 'Programs', 'Obsidian', 'Obsidian.exe')

const run = (file: string, args: string[]): Promise<string> =>
  new Promise((resolve) => execFile(file, args, { windowsHide: true }, (_e, out) => resolve(String(out ?? ''))))

/**
 * Starts Obsidian with no visible window (windowsHide sets the first ShowWindow to hidden). An Obsidian the
 * user already opened is left alone, a second launch would only open another window in it.
 */
export async function start(): Promise<void> {
  if (process.platform !== 'win32' || !fs.existsSync(exePath())) return
  if ((await run('tasklist', ['/FI', 'IMAGENAME eq Obsidian.exe', '/NH'])).includes('Obsidian.exe')) return
  const child = spawn(exePath(), [], { detached: true, stdio: 'ignore', windowsHide: true })
  child.on('error', () => undefined)
  child.unref()
  pid = child.pid
}

/** Closes the Obsidian Jolty started. A plain close request is ignored while its window is hidden, so it is forced; Obsidian saves as you type. */
export async function stop(): Promise<void> {
  if (pid) await run('taskkill', ['/PID', String(pid), '/T', '/F'])
  pid = undefined
}

/** Shows Obsidian if it is hidden, hides it if it is shown. */
export function toggle(): Promise<string> {
  // MainWindowHandle is 0 for a hidden window, so the window is found by enumerating the process's top-level windows
  const script = `
Add-Type @"
using System; using System.Text; using System.Collections.Generic; using System.Runtime.InteropServices;
public class W {
  public delegate bool CB(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] static extern bool EnumWindows(CB cb, IntPtr l);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint p);
  [DllImport("user32.dll")] static extern int GetWindowTextLength(IntPtr h);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr h, int c);
  [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr h);
  public static void Toggle(uint pid) {
    IntPtr found = IntPtr.Zero;
    EnumWindows((h, l) => { uint p; GetWindowThreadProcessId(h, out p); if (p == pid && GetWindowTextLength(h) > 0) { found = h; return false; } return true; }, IntPtr.Zero);
    if (found == IntPtr.Zero) return;
    if (IsWindowVisible(found)) ShowWindow(found, 0); else { ShowWindow(found, 9); SetForegroundWindow(found); }
  }
}
"@
$main = Get-CimInstance Win32_Process -Filter "Name='Obsidian.exe'" | Where-Object { $_.CommandLine -notmatch '--type=' } | Select-Object -First 1
if ($main) { [W]::Toggle([uint32]$main.ProcessId) }
`
  return run('powershell', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')])
}

/** Zips the vault to `<dir>/<name>-YYYY-MM-DD.zip` (one per day, the last write of the day wins) and keeps the newest KEEP. */
export async function backup(vault: string, dir: string, day = new Date().toISOString().slice(0, 10)): Promise<string | undefined> {
  if (!fs.existsSync(vault)) return undefined
  fs.mkdirSync(dir, { recursive: true })
  const name = path.basename(vault)
  const zip = path.join(dir, `${name}-${day}.zip`)
  // .trash and workspace.json are Obsidian's own scratch, not notes
  // Windows' own bsdtar writes zip; a GNU tar earlier on PATH (Git for Windows) does not
  await run(path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe'), ['-a', '-c', '-f', zip, '--exclude', '.trash', '--exclude', 'workspace.json', '-C', vault, '.'])
  if (!fs.existsSync(zip)) return undefined
  const mine = new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}-\\d{4}-\\d{2}-\\d{2}\\.zip$`)
  for (const old of fs.readdirSync(dir).filter((f) => mine.test(f)).sort().slice(0, -KEEP)) fs.rmSync(path.join(dir, old), { force: true })
  return zip
}

export const defaultBackupDir = (): string => path.join(os.homedir(), '.claude', 'backups', 'obsidian')
