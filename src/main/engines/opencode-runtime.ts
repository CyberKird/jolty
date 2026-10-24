import { execFile } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'
import type { PermissionMode } from '@shared/types'
import { BROWSER_BLOCKED_TOOLS, BROWSER_READ_TOOLS, BROWSER_SERVER, browserPrompt } from '../browser'
import { COMPUTER_ACT_TOOLS, COMPUTER_READ_TOOLS, COMPUTER_SERVER, computerPrompt } from '../computer/names'
import { dataDir, loadSettings } from '../store'
import { JsonRpcProcess } from './jsonrpc'
import { tr } from '@shared/i18n'

const EXE = process.platform === 'win32' ? 'opencode.exe' : 'opencode'

/** opencode.exe next to a launcher, as the npm package lays it out (the .cmd shims cannot be spawned directly). */
function nextToLauncher(dir: string): string | undefined {
  const roots = [path.join(dir, 'node_modules', 'opencode-ai', 'node_modules'), path.join(dir, 'node_modules'), path.join(dir, '..')]
  for (const root of roots) {
    if (!fs.existsSync(root)) continue
    for (const name of fs.readdirSync(root)) {
      if (!name.startsWith('opencode-') || name === 'opencode-ai') continue
      const file = path.join(root, name, 'bin', EXE)
      if (fs.existsSync(file)) return file
    }
  }
  return undefined
}

export function opencodeExecutable(): string | undefined {
  const custom = loadSettings().opencodePath
  if (custom) return fs.existsSync(custom) ? custom : undefined
  const dirs = (process.env.PATH || process.env.Path || '').split(path.delimiter).filter(Boolean)
  dirs.push(path.join(os.homedir(), '.opencode', 'bin'))
  for (const dir of dirs) {
    const direct = path.join(dir, EXE)
    if (fs.existsSync(direct) && fs.statSync(direct).isFile()) return direct
    if (fs.existsSync(path.join(dir, 'opencode.cmd'))) {
      const found = nextToLauncher(dir)
      if (found) return found
    }
  }
  return undefined
}

/** opencode asks for approvals through its own permission config, so the Jolty mode is passed in as config. */
export function opencodePermissions(mode: PermissionMode, protectSecrets = true): Record<string, 'ask' | 'allow'> {
  // "no questions" also covers folders outside the project (opencode's own auth.json, ~/.config) and its repeated-call guard
  const base: Record<string, 'ask' | 'allow'> =
    mode === 'full' ? { edit: 'allow', bash: 'allow', external_directory: 'allow', doom_loop: 'allow' } : mode === 'autoEdit' ? { edit: 'allow', bash: 'ask' } : { edit: 'ask', bash: 'ask' }
  // opencode asks before reading .env files on its own: that is the "ask before touching secret files" setting, so it follows it
  return protectSecrets ? base : { ...base, read: 'allow' }
}

type Rule = 'ask' | 'allow' | 'deny'

/** The browser's tools by name (opencode calls MCP tools `<server>_<tool>`): looking is free, acting asks in Manual mode. */
function browserRules(mode: PermissionMode): Record<string, Rule> {
  const acting: Rule = mode === 'ask' || mode === 'plan' ? 'ask' : 'allow'
  return {
    [`${BROWSER_SERVER}_*`]: acting,
    ...Object.fromEntries(BROWSER_READ_TOOLS.map((t) => [`${BROWSER_SERVER}_${t}`, 'allow' as Rule])),
    ...Object.fromEntries(BROWSER_BLOCKED_TOOLS.map((t) => [`${BROWSER_SERVER}_${t}`, 'deny' as Rule]))
  }
}

/** Computer use: outside Manual mode every tool is allowed, because Jolty's server asks the user per application. */
function computerRules(mode: PermissionMode): Record<string, Rule> {
  const rule: Rule = mode === 'ask' ? 'ask' : 'allow'
  return Object.fromEntries([...COMPUTER_READ_TOOLS, ...COMPUTER_ACT_TOOLS].map((t) => [`${COMPUTER_SERVER}_${t}`, rule]))
}

/** opencode has no system prompt over ACP: the browser and computer instructions go in as an instructions file. */
function toolInstructions(browser: boolean, computer: boolean): string {
  const file = path.join(dataDir(), 'opencode-tools.md')
  fs.writeFileSync(file, [browser ? browserPrompt() : '', computer ? computerPrompt() : ''].filter(Boolean).join('\n\n') + '\n')
  return file
}

/**
 * The thinking levels of each model ("variants" in opencode's own words): they differ per model, some have
 * low/high/max, some five levels, some none. ACP only reports them once a model is selected, so the picker
 * reads them in one go from `opencode models --verbose`.
 */
export function opencodeVariants(): Promise<Map<string, string[]>> {
  const exe = opencodeExecutable()
  if (!exe) return Promise.reject(new Error(tr("OpenCode nu este instalat. Instalează-l din Verificare sistem sau alege opencode.exe în Setări.")))
  return new Promise((resolve, reject) => {
    execFile(exe, ['models', '--verbose'], { windowsHide: true, timeout: 60000, maxBuffer: 64 * 1024 * 1024, env: { ...process.env, OPENCODE_CONFIG_CONTENT: '{"autoupdate":false}' } }, (error, stdout) => {
      if (error) return reject(error)
      const out = new Map<string, string[]>()
      // each model is its id on a line of its own, then its JSON
      const parts = stdout.split(/^(\S+\/\S+)\r?\n/m)
      for (let i = 1; i < parts.length; i += 2) {
        try { out.set(parts[i], Object.keys(JSON.parse(parts[i + 1]).variants || {})) } catch { /* a model with unreadable details just has no levels */ }
      }
      resolve(out)
    })
  })
}

/**
 * One question to one OpenCode model, no tools: for the composer's "Improve message". OpenCode has no ACP call for a
 * single answer without a chat, so `opencode run` does it and the session it leaves behind is deleted again.
 */
export function opencodeOnce(prompt: string, model: string): Promise<string> {
  const exe = opencodeExecutable()
  if (!exe) return Promise.reject(new Error(tr("OpenCode nu este instalat. Instalează-l din Verificare sistem sau alege opencode.exe în Setări.")))
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) if (value !== undefined && !/^(CLAUDECODE|CLAUDE_.*|ANTHROPIC_.*|CODEX_.*|OPENAI_.*|ELECTRON_RUN_AS_NODE)$/i.test(key)) env[key] = value
  // the user's ~/.claude rules and memory are for coding agents, they would leak into the rewrite
  env.OPENCODE_DISABLE_CLAUDE_CODE = '1'
  env.OPENCODE_CONFIG_CONTENT = JSON.stringify({ autoupdate: false, permission: { edit: 'deny', bash: 'deny', webfetch: 'deny' } })
  return new Promise((resolve, reject) => {
    const child = execFile(exe, ['run', '-m', model, '--format', 'json', '--dir', os.tmpdir(), prompt], { windowsHide: true, timeout: 120000, maxBuffer: 16 * 1024 * 1024, env }, (error, stdout) => {
      let text = ''
      let session = ''
      let failure = ''
      for (const line of String(stdout).split(/\r?\n/)) {
        try {
          const event = JSON.parse(line)
          session = session || event.sessionID || ''
          if (event.type === 'text' && typeof event.part?.text === 'string') text += event.part.text
          if (event.type === 'error') failure = event.error?.data?.message || event.error?.message || JSON.stringify(event.error || event).slice(0, 200)
        } catch { /* not an event line */ }
      }
      if (session) execFile(exe, ['session', 'delete', session], { windowsHide: true, timeout: 30000, env }, () => undefined)
      if (text.trim()) return resolve(text.trim())
      reject(new Error(failure || error?.message || tr("descrierea nu a primit răspuns")))
    })
    // `opencode run` reads a piped stdin to the end before it starts: with the pipe left open it waits for ever
    child.stdin?.end()
  })
}

export function launchOpencode(mode: PermissionMode = 'ask', browser = false, computer = false): JsonRpcProcess {
  const exe = opencodeExecutable()
  if (!exe) throw new Error(tr("OpenCode nu este instalat. Instalează-l din Verificare sistem sau alege opencode.exe în Setări."))
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && !/^(CLAUDECODE|CLAUDE_.*|ANTHROPIC_.*|CODEX_.*|OPENAI_.*|ELECTRON_RUN_AS_NODE)$/i.test(key)) env[key] = value
  }
  env.OPENCODE_CONFIG_CONTENT = JSON.stringify({
    permission: { ...opencodePermissions(mode, loadSettings().protectSecretFiles !== false), ...(browser ? browserRules(mode) : {}), ...(computer ? computerRules(mode) : {}) },
    ...(browser || computer ? { instructions: [toolInstructions(browser, computer)] } : {}),
    autoupdate: false
  })
  return new JsonRpcProcess(exe, ['acp'], env, { jsonrpc: true, label: 'OpenCode' })
}
