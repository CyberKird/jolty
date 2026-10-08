import { execFile, spawn } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'
import type { SystemCheck } from '@shared/types'
import * as local from './local'
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
    }
  ]
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

function winget(id: string, title: string): void {
  if (!isWin) throw new Error(tr("Instalarea automată e disponibilă doar pe Windows"))
  startDetached(`"${title}" winget install -e --id ${id} --accept-source-agreements --accept-package-agreements`)
}

export async function fix(id: string, openPath: (p: string) => Promise<string>): Promise<void> {
  if (id === 'git') winget('Git.Git', 'Jolty - instalare Git')
  else if (id === 'vcredist') {
    // the installer ships Microsoft's redistributable; winget is only the fallback
    const bundled = path.join(process.resourcesPath || '', 'redist', 'vc_redist.x64.exe')
    if (isWin && fs.existsSync(bundled)) startDetached(`"" "${bundled}" /install /passive /norestart`)
    else winget('Microsoft.VCRedist.2015+.x64', 'Jolty - instalare Visual C++')
  }
  else if (id === 'ollama') local.installOllama()
  else if (id === 'redirect') await openPath(path.join(os.homedir(), '.claude', 'settings.json'))
}
