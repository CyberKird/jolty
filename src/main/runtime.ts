import fs from 'fs'
import os from 'os'
import path from 'path'
import type { Profile } from '@shared/types'
import { getSecret, loadSettings, profileDir } from './store'

const isWin = process.platform === 'win32'

/** Inside a packaged app, binaries live in app.asar.unpacked, not in the asar archive. */
function unpacked(p: string): string {
  return p.replace(/app\.asar([\\/])/, 'app.asar.unpacked$1')
}

function packageDir(name: string): string | undefined {
  try {
    return path.dirname(require.resolve(`${name}/package.json`))
  } catch {
    return undefined
  }
}

/** The official Claude Code binary shipped with the Agent SDK, unless the user picked another one. */
export function claudeExecutable(): string | undefined {
  const custom = loadSettings().claudePath
  if (custom && fs.existsSync(custom)) return custom
  const dir = packageDir(`@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}`)
  if (!dir) return undefined
  const bin = unpacked(path.join(dir, isWin ? 'claude.exe' : 'claude'))
  return fs.existsSync(bin) ? bin : undefined
}

const CODEX_TRIPLES: Record<string, string> = {
  'linux-x64': 'x86_64-unknown-linux-musl',
  'linux-arm64': 'aarch64-unknown-linux-musl',
  'darwin-x64': 'x86_64-apple-darwin',
  'darwin-arm64': 'aarch64-apple-darwin',
  'win32-x64': 'x86_64-pc-windows-msvc',
  'win32-arm64': 'aarch64-pc-windows-msvc'
}

/** The official Codex binary shipped with @openai/codex, unless the user picked another one. */
export function codexExecutable(): string | undefined {
  const custom = loadSettings().codexPath
  if (custom && fs.existsSync(custom)) return custom
  const key = `${process.platform}-${process.arch}`
  const triple = CODEX_TRIPLES[key]
  const dir = packageDir(`@openai/codex-${key}`)
  if (!triple || !dir) return undefined
  const bin = unpacked(path.join(dir, 'vendor', triple, 'bin', isWin ? 'codex.exe' : 'codex'))
  return fs.existsSync(bin) ? bin : undefined
}

/** Extra PATH entries Codex expects (bundled ripgrep). */
function codexPathDirs(exe: string): string[] {
  const dir = path.join(path.dirname(path.dirname(exe)), 'codex-path')
  return fs.existsSync(dir) ? [dir] : []
}

/**
 * Inherited variables that would tie an engine to someone else's login or session: anything from a
 * parent Claude Code / Codex process (for example when Jolty is started from their terminal) and
 * provider keys. Each profile sets exactly what it needs instead.
 */
function isInheritedAuthVar(name: string): boolean {
  const n = name.toUpperCase()
  return n === 'CLAUDECODE' || n.startsWith('CLAUDE_') || n.startsWith('ANTHROPIC_') || n.startsWith('CODEX_') || n.startsWith('OPENAI_')
}

function baseEnv(): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !isInheritedAuthVar(k)) env[k] = v
  return env
}

export function claudeEnv(profile: Profile, model?: string): Record<string, string> {
  const env = baseEnv()
  env.CLAUDE_AGENT_SDK_CLIENT_APP = 'jolty/0.1.0'
  const dir = profileDir(profile)
  if (dir) env.CLAUDE_CONFIG_DIR = dir
  const secret = getSecret(profile.id)
  if (profile.auth === 'apiKey' && secret) env.ANTHROPIC_API_KEY = secret
  if (profile.auth === 'endpoint') {
    if (profile.baseUrl) env.ANTHROPIC_BASE_URL = profile.baseUrl
    if (secret) env.ANTHROPIC_AUTH_TOKEN = secret
    // Background tasks and subagents ask for Claude model aliases; send them to the chosen model too.
    const m = model || profile.models?.[0]
    if (m) {
      env.ANTHROPIC_MODEL = m
      env.ANTHROPIC_DEFAULT_OPUS_MODEL = m
      env.ANTHROPIC_DEFAULT_SONNET_MODEL = m
      env.ANTHROPIC_DEFAULT_HAIKU_MODEL = m
      env.CLAUDE_CODE_SUBAGENT_MODEL = m
    }
  }
  return env
}

export function codexEnv(profile: Profile, exe: string): Record<string, string> {
  const env = baseEnv()
  const dir = profileDir(profile)
  if (dir) env.CODEX_HOME = dir
  const extra = codexPathDirs(exe)
  if (extra.length) env.PATH = [...extra, env.PATH || env.Path || ''].join(path.delimiter)
  return env
}

// ---------------------------------------------------------------------------
// Shared "brain": extra profiles see the same instructions, skills and settings
// as the default ~/.claude and ~/.codex folders.
// ---------------------------------------------------------------------------
function linkDir(target: string, link: string): void {
  if (!fs.existsSync(target) || fs.existsSync(link)) return
  try {
    fs.symlinkSync(target, link, isWin ? 'junction' : 'dir')
  } catch {
    // not fatal: the profile just won't see the shared skills
  }
}

function copyIfMissing(src: string, dest: string): void {
  if (fs.existsSync(src) && !fs.existsSync(dest)) fs.copyFileSync(src, dest)
}

export function prepareProfileDir(profile: Profile): void {
  const dir = profileDir(profile)
  if (!dir) return
  fs.mkdirSync(dir, { recursive: true })
  const home = os.homedir()
  if (profile.engine === 'claude') {
    const mainDir = path.join(home, '.claude')
    const claudeMd = path.join(dir, 'CLAUDE.md')
    if (!fs.existsSync(claudeMd)) fs.writeFileSync(claudeMd, '@~/.claude/CLAUDE.md\n')
    copyIfMissing(path.join(mainDir, 'settings.json'), path.join(dir, 'settings.json'))
    linkDir(path.join(mainDir, 'skills'), path.join(dir, 'skills'))
    linkDir(path.join(mainDir, 'agents'), path.join(dir, 'agents'))
    linkDir(path.join(mainDir, 'commands'), path.join(dir, 'commands'))
  } else {
    const mainDir = path.join(home, '.codex')
    const agents = path.join(mainDir, 'AGENTS.md')
    // Codex has no import syntax: refresh the copy every time the profile starts.
    if (fs.existsSync(agents)) fs.copyFileSync(agents, path.join(dir, 'AGENTS.md'))
    copyIfMissing(path.join(mainDir, 'config.toml'), path.join(dir, 'config.toml'))
  }
}

/** Warn when ~/.claude/settings.json redirects Claude Code (it overrides what Jolty sets). */
export function claudeSettingsOverride(profile: Profile): string | undefined {
  const dir = profileDir(profile) || path.join(os.homedir(), '.claude')
  try {
    const s = JSON.parse(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8'))
    const url = s?.env?.ANTHROPIC_BASE_URL
    if (url) return `settings.json din ${dir} trimite Claude Code la ${url} (de ex. de la ai-brain). Rulează „ai-mode sub” sau șterge ANTHROPIC_BASE_URL din settings.json.`
  } catch {
    // no settings file
  }
  return undefined
}
