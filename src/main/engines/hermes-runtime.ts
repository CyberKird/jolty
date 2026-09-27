import fs from 'fs'
import os from 'os'
import path from 'path'
import { loadSettings } from '../store'
import { JsonRpcProcess } from './jsonrpc'

export function hermesHome(): string {
  return process.env.HERMES_HOME || (process.platform === 'win32'
    ? path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'hermes')
    : path.join(os.homedir(), '.hermes'))
}

export function hermesExecutable(): string | undefined {
  const custom = loadSettings().hermesPath
  if (custom) return fs.existsSync(custom) ? custom : undefined
  const bin = process.platform === 'win32' ? 'Scripts/hermes-acp.exe' : 'bin/hermes-acp'
  const candidates = ['venv', '.venv'].map((dir) => path.join(hermesHome(), 'hermes-agent', dir, bin))
  for (const dir of (process.env.PATH || process.env.Path || '').split(path.delimiter)) {
    if (dir) candidates.push(path.join(dir, process.platform === 'win32' ? 'hermes-acp.exe' : 'hermes-acp'))
  }
  return candidates.find((file) => fs.existsSync(file) && fs.statSync(file).isFile())
}

export function launchHermes(): JsonRpcProcess {
  const exe = hermesExecutable()
  if (!exe) throw new Error('Hermes ACP nu este instalat. Instalează Hermes sau alege hermes-acp în Setări.')
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && !/^(CLAUDECODE|CLAUDE_.*|ANTHROPIC_.*|CODEX_.*|OPENAI_.*|ELECTRON_RUN_AS_NODE)$/i.test(key)) env[key] = value
  }
  return new JsonRpcProcess(exe, [], { ...env, HERMES_HOME: hermesHome(), PYTHONUTF8: '1', DO_NOT_TRACK: '1' })
}
