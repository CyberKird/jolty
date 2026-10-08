import fs from 'fs'
import os from 'os'
import path from 'path'
import type { Profile } from '@shared/types'
import { getSecret, loadSettings, profileDir } from './store'
import { tr } from '@shared/i18n'

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

/** No telemetry, error reports, feedback surveys or other non-essential traffic from either engine. */
const PRIVATE_ENV: Record<string, string> = {
  DO_NOT_TRACK: '1',
  DISABLE_TELEMETRY: '1',
  DISABLE_ERROR_REPORTING: '1',
  DISABLE_BUG_COMMAND: '1',
  DISABLE_FEEDBACK_COMMAND: '1',
  CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY: '1',
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1'
}

/** Codex config overrides with the same effect (checked against `codex app-server --strict-config`). */
export const CODEX_PRIVATE_ARGS = ['-c', 'analytics.enabled=false', '-c', 'feedback.enabled=false', '-c', 'otel.exporter="none"', '-c', 'otel.log_user_prompt=false']

function baseEnv(): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !isInheritedAuthVar(k)) env[k] = v
  return { ...env, ...PRIVATE_ENV }
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

function readJsonFile(file: string): Record<string, unknown> | undefined {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return undefined
  }
}

/**
 * User-level MCP servers live in ~/.claude.json, next to the login. A profile with its own config
 * folder has its own .claude.json, so the servers are copied in (same names follow the main file;
 * servers added only to this profile stay).
 */
function syncMcpServers(dir: string): void {
  const main = readJsonFile(path.join(os.homedir(), '.claude.json'))?.mcpServers as Record<string, unknown> | undefined
  if (!main || !Object.keys(main).length) return
  const file = path.join(dir, '.claude.json')
  const own = readJsonFile(file)
  if (fs.existsSync(file) && !own) return // unreadable: never overwrite the profile's login
  const config = own || {}
  const merged = { ...((config.mcpServers as Record<string, unknown>) || {}), ...main }
  if (JSON.stringify(merged) === JSON.stringify(config.mcpServers)) return
  const tmp = `${file}.${process.pid}.tmp`
  fs.writeFileSync(tmp, JSON.stringify({ ...config, mcpServers: merged }, null, 2))
  fs.renameSync(tmp, file)
}

/** Settings that make the extra Claude accounts behave like the main one; env (endpoints, keys) is never copied. */
const SHARED_SETTINGS = ['enabledPlugins', 'extraKnownMarketplaces', 'hooks'] as const

/**
 * Brings the main ~/.claude/settings.json plugins, marketplaces and hooks into a profile's settings.json on
 * every start (the main account wins on the same names; entries only the profile has stay).
 */
export function syncSettings(mainFile: string, file: string): boolean {
  const main = readJsonFile(mainFile)
  if (!main) return false
  const own = readJsonFile(file)
  if (fs.existsSync(file) && !own) return false // unreadable: never overwrite it
  const next: Record<string, unknown> = { ...(own || {}) }
  for (const key of SHARED_SETTINGS) {
    const m = main[key]
    if (!m || typeof m !== 'object') continue
    next[key] = { ...((next[key] as Record<string, unknown>) || {}), ...(m as Record<string, unknown>) }
  }
  if (JSON.stringify(next) === JSON.stringify(own || {})) return false
  const tmp = `${file}.${process.pid}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2))
  fs.renameSync(tmp, file)
  return true
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
    try {
      syncSettings(path.join(mainDir, 'settings.json'), path.join(dir, 'settings.json'))
    } catch {
      // the profile still starts with its own settings
    }
    linkDir(path.join(mainDir, 'skills'), path.join(dir, 'skills'))
    linkDir(path.join(mainDir, 'agents'), path.join(dir, 'agents'))
    linkDir(path.join(mainDir, 'commands'), path.join(dir, 'commands'))
    linkDir(path.join(mainDir, 'plugins'), path.join(dir, 'plugins'))
    try {
      syncMcpServers(dir)
    } catch {
      // the profile still works without the shared MCP servers
    }
  } else {
    const mainDir = path.join(home, '.codex')
    const agents = path.join(mainDir, 'AGENTS.md')
    // Codex has no import syntax: refresh the copy every time the profile starts.
    if (fs.existsSync(agents)) fs.copyFileSync(agents, path.join(dir, 'AGENTS.md'))
    copyIfMissing(path.join(mainDir, 'config.toml'), path.join(dir, 'config.toml'))
    copyIfMissing(path.join(mainDir, 'hooks.json'), path.join(dir, 'hooks.json'))
    linkDir(path.join(mainDir, 'skills'), path.join(dir, 'skills'))
    linkDir(path.join(mainDir, 'plugins'), path.join(dir, 'plugins'))
  }
}

/** Warn when ~/.claude/settings.json redirects Claude Code (it overrides what Jolty sets). */
export function claudeSettingsOverride(profile: Profile): string | undefined {
  const dir = profileDir(profile) || path.join(os.homedir(), '.claude')
  try {
    const s = JSON.parse(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8'))
    const url = s?.env?.ANTHROPIC_BASE_URL
    if (url) return tr("settings.json din {dir} trimite Claude Code la {url} (de ex. de la ai-brain). Rulează „ai-mode sub” sau șterge ANTHROPIC_BASE_URL din settings.json.", { dir, url })
  } catch {
    // no settings file
  }
  return undefined
}
