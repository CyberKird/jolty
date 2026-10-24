// The contract between the skills inventory (main/skills.ts), the share packs (main/share-pack.ts) and the pages that
// show them. Types only: no tr() texts here, the backends answer with codes and the page words them.

/** Where a skill lives: ~/.claude/skills, ~/.codex/skills, or ~/.agents/skills (mirrored plugin and shared skills). */
export type SkillHome = 'claude' | 'codex' | 'agents'

/** Where a skill came from, which decides how "up to date" is checked. */
export type SkillSource =
  | { kind: 'local' }
  | { kind: 'git'; url: string; ref?: string; subdir?: string; commit?: string }
  | { kind: 'pack'; packId: string; packName: string; author?: string; importedAt: number; hash: string }

/**
 * ok: matches its source (or nothing to compare with and nothing wrong)
 * outdated: the source has something newer
 * modified: changed here since it was installed from its source (an update would overwrite those edits)
 * unknown: the check could not run (offline, no source, private repo)
 * broken: a problem that stops it from loading
 */
export type SkillStatus = 'ok' | 'outdated' | 'modified' | 'unknown' | 'broken'

export type SkillProblem =
  | 'no-skill-md'
  | 'no-name'
  | 'no-description'
  | 'bad-frontmatter'
  | 'dead-link'
  | 'duplicate-name'
  | 'name-differs-from-folder'
  | 'too-big'

export interface SkillInfo {
  /** `${home}:${folder name}`, stable between runs */
  id: string
  name: string
  description: string
  home: SkillHome
  dir: string
  /** the folder is a symlink or junction to somewhere else */
  linked: boolean
  files: number
  bytes: number
  /** hash of the folder's files (see main/skill-fs.ts), what "modified" and pack conflicts compare */
  hash: string
  modifiedAt: number
  source: SkillSource
  status: SkillStatus
  problems: SkillProblem[]
  /** for outdated: the short id or version of what is newer */
  latest?: string
  checkedAt?: number
}

/** Shown on the "needs attention" tab: broken, outdated, modified or with problems. */
export const needsAttention = (s: SkillInfo): boolean => s.status !== 'ok' && s.status !== 'unknown' ? true : s.problems.length > 0

// ---------------------------------------------------------------- share packs

/** What a pack can carry. Secrets (API keys, tokens, cookies, passwords) are never part of any of them. */
export type PackPart = 'skills' | 'commands' | 'instructions' | 'settings' | 'profiles' | 'schedules'

/** Personal information found in an item; only the kind is ever reported, never the value. */
export type PersonalKind = 'email' | 'phone' | 'bank' | 'card' | 'home-path' | 'account-name'

/** One thing that can go into a pack, as the export page lists it. */
export interface PackItem {
  /** `${part}:${name}`, unique and stable */
  key: string
  part: PackPart
  label: string
  detail?: string
  bytes: number
  /** found by the scan; the export replaces it with placeholders (<email>, <user> ...) */
  personal?: PersonalKind[]
}

export interface ExportRequest {
  keys: string[]
  name: string
  author?: string
  note?: string
}

export interface ExportResult {
  file: string
  items: number
  bytes: number
  /** items that had personal information replaced by placeholders */
  redacted?: number
  /** files left out: credentials or too big */
  skipped?: { key: string; file: string; reason: string }[]
}

/**
 * new: not here yet
 * same: identical to what is here
 * different: exists here with other content (needs a decision)
 * newer / older: the pack's copy is newer or older than the local one (by the time recorded in the pack)
 */
export type ImportState = 'new' | 'same' | 'different' | 'newer' | 'older'

/** skip: leave mine. overwrite: replace mine (a backup is kept). copy: bring it in next to mine under another name. */
export type ImportDecision = 'skip' | 'overwrite' | 'copy'

/** What importing an item would do beyond copying files; shown as a warning because a pack comes from someone else. */
export type ImportRisk = 'runs-code' | 'changes-instructions' | 'changes-settings' | 'adds-account'

export interface ImportItem {
  key: string
  part: PackPart
  label: string
  detail?: string
  bytes: number
  state: ImportState
  /** what is here now, when state is different, newer or older */
  existing?: { modifiedAt: number; bytes: number }
  risks: ImportRisk[]
  /** the decision the page starts with: new items 'overwrite' (nothing to lose), same 'skip', others 'skip' */
  suggested: ImportDecision
}

export interface ImportPreview {
  /** the parsed pack waits in main under this id until it is applied or dropped */
  previewId: string
  name: string
  author?: string
  note?: string
  createdAt: number
  appVersion: string
  items: ImportItem[]
  /** codes for things the page should word: 'newer-app-version', 'unknown-parts', 'checksum-mismatch' ... */
  warnings: string[]
}

export interface ImportResult {
  /** the id of the backup of everything that was replaced, for pack.undo */
  importId: string
  imported: number
  skipped: number
  copied: number
  failed: { key: string; reason: string }[]
}
