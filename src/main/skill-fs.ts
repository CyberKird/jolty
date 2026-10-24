// What the skills inventory and the share packs both need: where skills live, a hash of a skill folder, and the
// record of where each one came from (kept in Jolty's data folder, so the skill folders stay clean).
import { createHash } from 'crypto'
import fs from 'fs'
import os from 'os'
import path from 'path'
import type { SkillHome, SkillSource } from '@shared/skills'
import { dataDir } from './store'

export function skillRoot(home: SkillHome): string {
  return path.join(os.homedir(), home === 'claude' ? '.claude' : home === 'codex' ? '.codex' : '.agents', 'skills')
}

const SKIP = new Set(['.git', 'node_modules', '__pycache__', '.DS_Store'])

/** Files of a skill folder, sorted, as relative paths with forward slashes. Links inside are not followed. */
export function skillFiles(dir: string): string[] {
  const out: string[] = []
  const walk = (rel: string): void => {
    for (const e of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
      if (SKIP.has(e.name)) continue
      const r = rel ? `${rel}/${e.name}` : e.name
      if (e.isDirectory()) walk(r)
      else if (e.isFile()) out.push(r)
    }
  }
  walk('')
  return out.sort()
}

/** Same content, same hash, wherever the folder is. */
export function hashSkillDir(dir: string): string {
  const h = createHash('sha1')
  for (const f of skillFiles(dir)) h.update(f).update('\0').update(fs.readFileSync(path.join(dir, f))).update('\0')
  return h.digest('hex')
}

const SOURCES = 'skill-sources.json'

export function readSources(): Record<string, SkillSource> {
  try {
    return JSON.parse(fs.readFileSync(path.join(dataDir(), SOURCES), 'utf8')) as Record<string, SkillSource>
  } catch {
    return {}
  }
}

/** Remembers where the skill with this id (`home:folder`) came from. */
export function writeSource(id: string, source: SkillSource | undefined): void {
  const all = readSources()
  if (source) all[id] = source
  else delete all[id]
  fs.mkdirSync(dataDir(), { recursive: true })
  fs.writeFileSync(path.join(dataDir(), SOURCES), JSON.stringify(all, null, 2))
}

/** The names skillFiles and hashSkillDir leave out, for walks that must see the same files. */
export const skippedNames: ReadonlySet<string> = SKIP
