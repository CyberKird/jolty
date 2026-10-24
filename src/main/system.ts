import { execFile, spawn } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'
import type { SystemCheck } from '@shared/types'
import { browserMode } from './browser'
import { csc } from './computer/helper'
import { nativeBrowser } from './jbrowser/native'
import * as local from './local'
import { opencodeExecutable } from './engines/opencode-runtime'
import { installOpencode } from './engines/opencode-install'
import { claudeExecutable, codexExecutable } from './runtime'
import { tr } from '@shared/i18n'

const isWin = process.platform === 'win32'

function run(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve) => execFile(cmd, args, { timeout: 8000, windowsHide: true }, (err, out) => resolve(err ? '' : String(out))))
}

async function gitBash(): Promise<string | undefined> {
  if (!isWin) return (await run('which', ['git'])).trim() || undefined
  const where = (await run('where', ['git'])).split('\n')[0]?.trim()
  const candidates = [
    process.env.CLAUDE_CODE_GIT_BASH_PATH,
    where ? path.join(path.dirname(path.dirname(where)), 'bin', 'bash.exe') : undefined,
    'C:\\Program Files\\Git\\bin\\bash.exe',
    path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Git', 'bin', 'bash.exe')
  ]
  return candidates.find((c) => c && fs.existsSync(c))
}

async function vcRuntime(): Promise<boolean> {
  if (!isWin) return true
  const out = await run('reg', ['query', 'HKLM\\SOFTWARE\\Microsoft\\VisualStudio\\14.0\\VC\\Runtimes\\x64', '/v', 'Installed'])
  return /Installed\s+REG_DWORD\s+0x1/i.test(out)
}

function settingsRedirect(): string | undefined {
  try {
    const s = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.claude', 'settings.json'), 'utf8'))
    return s?.env?.ANTHROPIC_BASE_URL
  } catch {
    return undefined
  }
}

export async function check(): Promise<SystemCheck[]> {
  const claude = claudeExecutable()
  const codex = codexExecutable()
  const bash = await gitBash()
  const vc = await vcRuntime()
  const ollama = await local.status()
  const redirect = settingsRedirect()
  const opencode = opencodeExecutable()
  await nativeBrowser.start()
  const ext = nativeBrowser.status()
  const checks: SystemCheck[] = [
    { id: 'claude', label: tr("Claude Code (inclus în Jolty)"), ok: Boolean(claude), detail: claude || tr("Binarul inclus lipsește: reinstalează Jolty.") },
    { id: 'codex', label: tr("Codex (inclus în Jolty)"), ok: Boolean(codex), detail: codex || tr("Binarul inclus lipsește: reinstalează Jolty.") },
    {
      id: 'git',
      label: 'Git for Windows',
      ok: Boolean(bash),
      detail: bash ? bash : tr("Claude Code folosește Git Bash pentru comenzi pe Windows."),
      fixLabel: bash ? undefined : tr("Instalează Git")
    },
    {
      id: 'vcredist',
      label: 'Microsoft Visual C++ Runtime',
      ok: vc,
      detail: vc ? tr("Instalat") : tr("Necesar pentru Codex și pentru multe unelte de dezvoltare."),
      fixLabel: vc ? undefined : tr("Instalează runtime-ul")
    },
    {
      id: 'ollama',
      label: tr("Ollama (modele locale)"),
      ok: ollama.running,
      optional: true,
      detail: ollama.running ? tr("Rulează (versiunea {version}), {length} modele", { version: ollama.version, length: ollama.models.length }) : ollama.installed ? tr("Instalat, dar nu rulează: pornește aplicația Ollama.") : tr("Opțional: pentru modele care rulează pe PC-ul tău."),
      fixLabel: ollama.installed ? undefined : tr("Instalează Ollama")
    },
    {
      id: 'opencode',
      label: 'OpenCode',
      ok: Boolean(opencode),
      optional: true,
      detail: opencode || tr("Opțional: agentul OpenCode, cu modelele lui gratuite."),
      fixLabel: opencode ? undefined : tr("Instalează OpenCode")
    }
  ]
  // the computer helper builds itself on first use, with the compiler Windows ships
  if (isWin) {
    const compiler = fs.existsSync(csc())
    checks.push({
      id: 'computer',
      label: tr("Control al PC-ului"),
      ok: compiler,
      detail: compiler ? tr("Asistentul se construiește singur la prima folosire.") : tr("Lipsește .NET Framework 4 (csc.exe), așa că controlul PC-ului nu poate porni. Activează-l din Funcții Windows.")
    })
  }
  // only the default way of connecting needs Jolty's own extension
  if (browserMode() === 'jolty') {
    checks.splice(4, 0, {
      id: 'extension',
      label: tr("Extensia Jolty"),
      ok: ext.connected,
      detail: ext.connected ? tr("Conectată la browser (versiunea {v})", { v: ext.version || '?' }) : ext.installed ? tr("Instalată, dar browserul nu e conectat. Deschide browserul sau apasă pe iconița extensiei și pe Reconectează.") : tr("Nu e instalată încă în browser."),
      fixLabel: ext.connected ? undefined : ext.installed ? tr("Deschide pagina de extensii") : tr("Instalează extensia")
    })
  }
  if (redirect) {
    checks.push({
      id: 'redirect',
      label: tr("Setări Claude Code"),
      ok: false,
      detail: tr("~/.claude/settings.json trimite Claude Code la {redirect} pentru toate profilurile. Jolty gestionează singur modelele; șterge ANTHROPIC_BASE_URL din blocul „env” (sau rulează „ai-mode sub”).", { redirect }),
      fixLabel: tr("Deschide settings.json")
    })
  }
  return checks
}

/** `start` goes through ShellExecute, so installers that need admin rights get the UAC prompt. */
function startDetached(args: string): void {
  spawn('cmd.exe', ['/d', '/s', '/c', `"start ${args}"`], { detached: true, stdio: 'ignore', windowsVerbatimArguments: true }).unref()
}

/** winget ships with Windows 10 1809+ but is missing on some PCs (LTSC, stripped images), so the official installer is the fallback. */
export async function install(id: string, title: string, installerUrl: () => Promise<string>, args: string): Promise<void> {
  if (!isWin) throw new Error(tr("Instalarea automată e disponibilă doar pe Windows"))
  if ((await run('where', ['winget'])).trim()) return startDetached(`"${title}" winget install -e --id ${id} --accept-source-agreements --accept-package-agreements`)
  const res = await fetch(await installerUrl())
  if (!res.ok) throw new Error(`${title}: HTTP ${res.status}`)
  const file = path.join(os.tmpdir(), `jolty-${id}.exe`)
  fs.writeFileSync(file, Buffer.from(await res.arrayBuffer()))
  startDetached(`"" "${file}" ${args}`)
}

async function gitInstallerUrl(): Promise<string> {
  const rel = (await (await fetch('https://api.github.com/repos/git-for-windows/git/releases/latest')).json()) as { assets: { name: string; browser_download_url: string }[] }
  const asset = rel.assets.find((a) => /^Git-.*-64-bit\.exe$/.test(a.name))
  if (!asset) throw new Error('Git for Windows installer not found')
  return asset.browser_download_url
}

export async function fix(id: string, openPath: (p: string) => Promise<string>): Promise<void> {
  if (id === 'git') await install('Git.Git', 'Jolty - instalare Git', gitInstallerUrl, '/SILENT')
  else if (id === 'vcredist') {
    // the installer ships Microsoft's redistributable; winget is only the fallback
    const bundled = path.join(process.resourcesPath || '', 'redist', 'vc_redist.x64.exe')
    if (isWin && fs.existsSync(bundled)) startDetached(`"" "${bundled}" /install /passive /norestart`)
    else await install('Microsoft.VCRedist.2015+.x64', 'Jolty - instalare Visual C++', async () => 'https://aka.ms/vs/17/release/vc_redist.x64.exe', '/install /passive /norestart')
  }
  else if (id === 'ollama') await install('Ollama.Ollama', 'Jolty - instalare Ollama', async () => 'https://ollama.com/download/OllamaSetup.exe', '/SILENT')
  else if (id === 'opencode') await installOpencode()
  else if (id === 'extension') await nativeBrowser.installAndOpen()
  else if (id === 'redirect') await openPath(path.join(os.homedir(), '.claude', 'settings.json'))
}
