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
export function opencodePermissions(mode: PermissionMode): { edit: 'ask' | 'allow'; bash: 'ask' | 'allow' } {
  if (mode === 'full') return { edit: 'allow', bash: 'allow' }
  if (mode === 'autoEdit') return { edit: 'allow', bash: 'ask' }
  return { edit: 'ask', bash: 'ask' }
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

export function launchOpencode(mode: PermissionMode = 'ask', browser = false, computer = false): JsonRpcProcess {
  const exe = opencodeExecutable()
  if (!exe) throw new Error(tr("OpenCode nu este instalat. Instalează-l (npm i -g opencode-ai) sau alege opencode.exe în Setări."))
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && !/^(CLAUDECODE|CLAUDE_.*|ANTHROPIC_.*|CODEX_.*|OPENAI_.*|ELECTRON_RUN_AS_NODE)$/i.test(key)) env[key] = value
  }
  env.OPENCODE_CONFIG_CONTENT = JSON.stringify({
    permission: { ...opencodePermissions(mode), ...(browser ? browserRules(mode) : {}), ...(computer ? computerRules(mode) : {}) },
    ...(browser || computer ? { instructions: [toolInstructions(browser, computer)] } : {}),
    autoupdate: false
  })
  return new JsonRpcProcess(exe, ['acp'], env, { jsonrpc: true, label: 'OpenCode' })
}
