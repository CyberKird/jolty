// What the composer offers after "/" (skills and commands) and "@" (project files).
import { execFile } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'
import type { SlashItem } from '@shared/types'

function frontmatter(file: string): { name?: string; description?: string } {
  try {
    const head = fs.readFileSync(file, 'utf8').slice(0, 4000)
    const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(head)
    if (!m) return {}
    const get = (k: string): string | undefined => new RegExp(`^${k}:\\s*(.+)$`, 'm').exec(m[1])?.[1]?.trim().replace(/^["']|["']$/g, '')
    return { name: get('name'), description: get('description') }
  } catch {
    return {}
  }
}

function dirs(p: string): string[] {
  try {
    return fs.readdirSync(p, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name)
  } catch {
    return []
  }
}

function mdFiles(p: string): string[] {
  try {
    return fs.readdirSync(p).filter((f) => f.endsWith('.md'))
  } catch {
    return []
  }
}

/** Skills and slash commands from ~/.claude and the project's .claude, project first. */
export function slashItems(cwd?: string): SlashItem[] {
  const roots = [...(cwd ? [{ dir: path.join(cwd, '.claude'), scope: 'proiect' as const }] : []), { dir: path.join(os.homedir(), '.claude'), scope: 'global' as const }]
  const seen = new Set<string>()
  const out: SlashItem[] = []
  for (const { dir, scope } of roots) {
    for (const d of dirs(path.join(dir, 'skills'))) {
      const fm = frontmatter(path.join(dir, 'skills', d, 'SKILL.md'))
      const name = fm.name || d
      if (seen.has(name)) continue
      seen.add(name)
      out.push({ name, description: (fm.description || '').slice(0, 200), kind: 'skill', scope })
    }
    for (const f of mdFiles(path.join(dir, 'commands'))) {
      const name = f.replace(/\.md$/, '')
      if (seen.has(name)) continue
      seen.add(name)
      out.push({ name, description: (frontmatter(path.join(dir, 'commands', f)).description || '').slice(0, 200), kind: 'command', scope })
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name))
}

const SKIP = new Set(['node_modules', '.git', 'dist', 'out', 'build', '.next', '.venv', '__pycache__', 'target'])
const fileCache = new Map<string, { at: number; files: string[] }>()

function walk(root: string, max = 4000): string[] {
  const out: string[] = []
  const stack = ['']
  while (stack.length && out.length < max) {
    const rel = stack.pop()!
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(path.join(root, rel), { withFileTypes: true })
    } catch {
      continue
    }
    for (const e of entries) {
      if (e.name.startsWith('.') && e.name !== '.claude') continue
      const p = rel ? `${rel}/${e.name}` : e.name
      if (e.isDirectory()) {
        if (!SKIP.has(e.name)) stack.push(p)
      } else out.push(p)
    }
  }
  return out
}

/** Project files for "@": git's list when it is a repository (respects .gitignore), else a bounded walk. */
export function projectFiles(cwd: string): Promise<string[]> {
  const hit = fileCache.get(cwd)
  if (hit && Date.now() - hit.at < 30000) return Promise.resolve(hit.files)
  return new Promise((resolve) => {
    execFile('git', ['ls-files', '--cached', '--others', '--exclude-standard'], { cwd, timeout: 5000, windowsHide: true, maxBuffer: 16 * 1024 * 1024 }, (err, out) => {
      const files = err ? walk(cwd) : String(out).split('\n').filter(Boolean).slice(0, 20000)
      fileCache.set(cwd, { at: Date.now(), files })
      resolve(files)
    })
  })
}
