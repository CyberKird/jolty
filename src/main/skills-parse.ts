// Pure helpers for the skills inventory: the SKILL.md frontmatter and the checks on what a user or a remote can hand
// us (git urls, refs, subfolders). No fs, no network, so the tests can hit every odd case directly.

export interface Frontmatter {
  /** false when the file has no frontmatter block at all */
  present: boolean
  /** true when the block is there but cannot be read (no closing ---, unterminated quote, stray line) */
  bad: boolean
  name?: string
  description?: string
}

const KEY = /^([A-Za-z0-9_.-]+):(?:\s+(.*)|\s*)$/

function unquote(v: string, rest: string[]): { value: string; bad: boolean } {
  const q = v[0]
  // a quoted scalar may run over several lines; join them the way YAML folds them
  let text = v
  let i = 0
  const closes = (s: string): boolean => (q === "'" ? /(^|[^'])('')*'\s*(#.*)?$/.test(s.slice(1)) : /(^|[^\\])(\\\\)*"\s*(#.*)?$/.test(s.slice(1)))
  while (!closes(text) && i < rest.length) text += ' ' + rest[i++].trim()
  if (!closes(text)) return { value: '', bad: true }
  const body = text.slice(1, text.lastIndexOf(q))
  if (q === "'") return { value: body.replace(/''/g, "'"), bad: false }
  const esc: Record<string, string> = { n: '\n', t: '\t', '"': '"', '\\': '\\', '/': '/', r: '' }
  return { value: body.replace(/\\(.)/g, (_m, c: string) => esc[c] ?? c), bad: false }
}

/** Reads name and description from a SKILL.md the way the agents do: BOM, CRLF, quotes, folded and literal blocks. */
export function parseFrontmatter(raw: string): Frontmatter {
  const text = raw.replace(/^﻿/, '').replace(/\r\n?/g, '\n')
  if (!/^---[ \t]*\n/.test(text)) return { present: false, bad: false }
  const lines = text.split('\n')
  const end = lines.findIndex((l, i) => i > 0 && /^(---|\.\.\.)[ \t]*$/.test(l))
  if (end < 0) return { present: true, bad: true }
  const body = lines.slice(1, end)
  const out: Frontmatter = { present: true, bad: false }
  for (let i = 0; i < body.length; i++) {
    const line = body[i]
    if (!line.trim() || /^\s*#/.test(line) || /^\s/.test(line) || /^- /.test(line) || line === '-') continue
    const m = KEY.exec(line)
    if (!m) {
      out.bad = true
      continue
    }
    const key = m[1]
    const v = (m[2] ?? '').trim()
    // the lines that belong to this key: indented or blank, up to the next key
    let j = i + 1
    while (j < body.length && (!body[j].trim() || /^\s/.test(body[j]))) j++
    const cont = body.slice(i + 1, j)
    let value: string
    if (/^[>|][+-]?\d*\s*(#.*)?$/.test(v)) {
      const indent = Math.min(...cont.filter((l) => l.trim()).map((l) => /^\s*/.exec(l)![0].length))
      const ls = cont.map((l) => l.slice(Number.isFinite(indent) ? indent : 0))
      // folded (>): lines join with a space, a blank line stays a line break
      value = v[0] === '|' ? ls.join('\n') : ls.reduce((acc, l) => (!l ? acc + '\n' : acc && !acc.endsWith('\n') ? `${acc} ${l}` : acc + l), '')
    } else if (v.startsWith('"') || v.startsWith("'")) {
      const r = unquote(v, cont)
      if (r.bad) out.bad = true
      value = r.value
    } else {
      // a plain scalar folds its indented continuation lines into one line
      value = [v.replace(/\s+#.*$/, ''), ...cont.map((l) => l.trim()).filter(Boolean)].join(' ').trim()
    }
    if (key === 'name') out.name = value.trim() || undefined
    if (key === 'description') out.description = value.trim() || undefined
    i = j - 1
  }
  return out
}

/** https only; file:// only under JOLTY_TEST; ssh (git@host:path) only when it comes from a remote already on disk. */
export function validGitUrl(url: unknown, allowSsh = false): url is string {
  if (typeof url !== 'string' || url.length > 500 || url.startsWith('-') || /[\s\0]/.test(url)) return false
  if (allowSsh && /^[A-Za-z0-9._-]+@[A-Za-z0-9.-]+:[A-Za-z0-9._~/-]+$/.test(url) && !url.includes('..')) return true
  try {
    const u = new URL(url)
    if (u.protocol === 'file:') return !!process.env.JOLTY_TEST
    if (allowSsh && u.protocol === 'ssh:') return !u.password
    return u.protocol === 'https:' && !u.username && !u.password && !!u.hostname
  } catch {
    return false
  }
}

export function validRef(ref: unknown): ref is string {
  return typeof ref === 'string' && ref.length > 0 && ref.length < 200 && /^[A-Za-z0-9._/-]+$/.test(ref) && !ref.startsWith('-') && !ref.includes('..') && !ref.startsWith('/') && !ref.endsWith('/') && !ref.endsWith('.lock') && !ref.includes('//')
}

export function validSubdir(sub: unknown): sub is string {
  if (typeof sub !== 'string' || !sub || sub.length > 300 || /[\0:\\]/.test(sub) || sub.startsWith('/') || sub.startsWith('-')) return false
  return sub.split('/').every((p) => p && p !== '.' && p !== '..' && !p.startsWith('-'))
}

export const validCommit = (c: unknown): c is string => typeof c === 'string' && /^[0-9a-f]{7,64}$/i.test(c)
