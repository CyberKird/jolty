// What an incremental backup takes, so a new PC opens where the old one stopped. An allow list, not a deny list:
// a new kind of file stays out until it is added here on purpose.
//   data folder: settings, profiles (without keys), chats and their transcripts, schedules, ledgers, references,
//     use time and usage, recently deleted chats, skill sources, backup fields that are not secret; and each
//     profile's own engine folder (Claude/Codex history, its CLAUDE.md, settings, memory, plugins, plans)
//   home folder: the engine files of chats that run in the default ~/.claude or ~/.codex (only those of chats Jolty
//     knows, not the whole history of the CLI)
//   left out: keys and logins (secrets.json is tied to this PC's keychain; .credentials.json, auth.json and the like
//     would sign the old PC out when tokens rotate), caches, logs, downloaded models, browser profiles, worktrees,
//     paired phones, this PC's backup accounts.
import fs from 'fs/promises'
import path from 'path'
import type { Source } from './vault-write'

const TOP_FILES = new Set([
  'settings.json',
  'profiles.json',
  'sessions.json',
  'schedules.json',
  'use-time.json',
  'usage.jsonl',
  'backup-config.json',
  'skill-sources.json',
  'skill-status.json'
])
const TOP_DIRS = new Set(['transcripts', 'ledgers', 'references', 'trash', 'profiles'])
/** folders that are caches, logs or tied to this PC, at any depth inside a profile's engine folder */
const SKIP_DIRS = new Set(['node_modules', '.git', 'shell-snapshots', 'session-env', 'statsig', 'cache', 'caches', 'logs', 'log', 'debug', 'telemetry', 'tmp', 'temp', 'ide', 'backups', '.tmp'])
/** logins and tokens: never uploaded, even encrypted */
const SECRET = /(^\.credentials\.json$|^auth\.json$|^oauth_creds\.json$|^google_accounts\.json$|credential|token|\.pem$|\.key$)/i
const JUNK = /(\.tmp$|\.lock$|\.bak|\.log$|~$)/i
/** one file over this is left out (a stray video in a chat folder, say) */
export const FILE_MAX = 256 * 1024 * 1024

async function walk(dir: string, prefix: string, out: Source[], depth = 0): Promise<void> {
  if (depth > 24) return
  let list: import('fs').Dirent[]
  try {
    list = await fs.readdir(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const e of list) {
    // links and junctions are never followed: they point outside what is ours
    if (e.isSymbolicLink()) continue
    const abs = path.join(dir, e.name)
    const p = `${prefix}/${e.name}`
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name.toLowerCase())) await walk(abs, p, out, depth + 1)
    } else if (e.isFile() && !SECRET.test(e.name) && !JUNK.test(e.name)) {
      const st = await fs.stat(abs).catch(() => null)
      if (st && st.size <= FILE_MAX) out.push({ p, abs, size: st.size, mtime: Math.round(st.mtimeMs) })
    }
  }
}

export interface ScopeInput {
  data: string
  home: string
  /** chats: which engine session each one has, and whether its profile uses the default folder */
  chats: { engine: string; engineSessionId?: string; defaultDir: boolean }[]
}

/** Engine files of chats in the default folders (~/.claude/projects/<dir>/<id>.jsonl, ~/.codex/sessions/.../*<id>.jsonl). */
async function homeFiles(input: ScopeInput, out: Source[]): Promise<void> {
  const claudeIds = new Set(input.chats.filter((c) => c.defaultDir && c.engine === 'claude' && c.engineSessionId).map((c) => c.engineSessionId!))
  const codexIds = input.chats.filter((c) => c.defaultDir && c.engine === 'codex' && c.engineSessionId).map((c) => c.engineSessionId!)
  if (claudeIds.size) {
    const root = path.join(input.home, '.claude', 'projects')
    const dirs = await fs.readdir(root, { withFileTypes: true }).catch(() => [])
    for (const d of dirs) {
      if (!d.isDirectory()) continue
      const inDir = await fs.readdir(path.join(root, d.name), { withFileTypes: true }).catch(() => [])
      for (const e of inDir) {
        const id = e.name.replace(/\.jsonl$/, '')
        if (!claudeIds.has(id)) continue
        const prefix = `home/.claude/projects/${d.name}`
        // <id>.jsonl is the chat; a folder <id>/ holds its subagents and tool results
        if (e.isDirectory()) await walk(path.join(root, d.name, e.name), `${prefix}/${e.name}`, out)
        else if (e.isFile()) {
          const st = await fs.stat(path.join(root, d.name, e.name)).catch(() => null)
          if (st && st.size <= FILE_MAX) out.push({ p: `${prefix}/${e.name}`, abs: path.join(root, d.name, e.name), size: st.size, mtime: Math.round(st.mtimeMs) })
        }
      }
    }
  }
  if (codexIds.length) {
    const found: Source[] = []
    await walk(path.join(input.home, '.codex', 'sessions'), 'home/.codex/sessions', found)
    for (const s of found) if (codexIds.some((id) => s.p.includes(id))) out.push(s)
  }
}

/** Every file of the backup, sorted by path (the order is part of a version's fingerprint). */
export async function listScope(input: ScopeInput): Promise<Source[]> {
  const out: Source[] = []
  const top = await fs.readdir(input.data, { withFileTypes: true }).catch(() => [])
  for (const e of top) {
    if (e.isSymbolicLink()) continue
    const abs = path.join(input.data, e.name)
    if (e.isFile() && TOP_FILES.has(e.name)) {
      const st = await fs.stat(abs).catch(() => null)
      if (st && st.size <= FILE_MAX) out.push({ p: `data/${e.name}`, abs, size: st.size, mtime: Math.round(st.mtimeMs) })
    } else if (e.isDirectory() && TOP_DIRS.has(e.name)) {
      await walk(abs, `data/${e.name}`, out)
    }
  }
  await homeFiles(input, out)
  return out.sort((a, b) => (a.p < b.p ? -1 : a.p > b.p ? 1 : 0))
}
