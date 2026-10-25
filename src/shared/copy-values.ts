// What the chat can copy and how: pure text work, no DOM, so a node test can pin it.
import type { FileDiff } from './types'

export type ValueKind = 'url' | 'path' | 'command' | 'version' | 'hash' | 'port' | 'env' | 'flag' | 'key'

const EXT = 'ts|tsx|js|jsx|mjs|cjs|json|md|css|scss|html|py|rs|go|java|kt|cs|cpp|c|h|yml|yaml|toml|ini|env|lock|txt|log|sh|ps1|bat|cmd|sql|xml|svg|png|jpg|jpeg|gif|webp|ico|pdf|zip|csv|exe|dll|mp4|mp3|wav|lua|gd'
const LINE = '(?::\\d+(?::\\d+)?)?'
const SEG = '[\\w@.~+-]+'
const PATH = [
  new RegExp(`^(?:[a-z]:[\\\\/]|~[\\\\/]|\\.{1,2}[\\\\/]|/)[^\\s<>|"*?]+${LINE}$`, 'i'),
  new RegExp(`^${SEG}(?:[\\\\/]${SEG}){2,}[\\\\/]?${LINE}$`),
  new RegExp(`^${SEG}(?:[\\\\/]${SEG})*\\.(?:${EXT})${LINE}$`, 'i')
]
const COMMANDS = new Set('npm npx pnpm yarn bun node deno python python3 py pip pip3 uv cargo rustc go dotnet git gh docker kubectl winget choco scoop curl wget ssh scp cd ls dir cat mkdir rm cp mv echo code claude codex opencode electron-vite tsc eslint prettier vite make cmake adb ffmpeg powershell pwsh taskkill sudo apt brew'.split(' '))

/** An inline code span worth a copy chip: a path, command, URL, version, hash, port, variable, flag or quoted key. Ordinary words are not. */
export function valueKind(raw: string): ValueKind | undefined {
  const s = raw.trim()
  if (!s || s.length > 240 || /[\r\n]/.test(s)) return undefined
  if (/^https?:\/\/\S+$/i.test(s)) return 'url'
  if (/^\$ \S/.test(s) || (COMMANDS.has(s.split(/\s+/)[0]) && /^\S+\s+\S/.test(s))) return 'command'
  if (PATH.some((re) => re.test(s)) && !/^[\d/\.:-]+$/.test(s)) return 'path'
  if (/^v?\d+\.\d+(?:\.\d+){0,2}(?:[-+][\w.]+)?$/.test(s)) return 'version'
  if (/^(?=[0-9a-f-]*\d)(?=[0-9a-f-]*[a-f])(?:[0-9a-f]{7,64}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i.test(s)) return 'hash'
  if (/^(?:localhost|\d{1,3}(?:\.\d{1,3}){3}):\d{2,5}(?:\/\S*)?$|^:\d{3,5}$/.test(s)) return 'port'
  if (/^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+(?:=\S*)?$|^[A-Z][A-Z0-9_]*=\S+$|^\$[A-Z_][A-Z0-9_]*$|^%[A-Z_]+%$/.test(s)) return 'env'
  if (/^--?[a-z][\w-]*(?:=\S+)?$/i.test(s)) return 'flag'
  if (/^"[\w.$-]+"$/.test(s)) return 'key'
  return undefined
}

const PROMPT = /^\s*(?:\$|PS [^>\n]*>|[a-z]:\\[^>\n]*>)\s*/i
const SHELLS = new Set(['sh', 'bash', 'zsh', 'shell', 'console', 'shell-session', 'powershell', 'ps1', 'pwsh', 'cmd', 'bat'])
export const isShell = (lang: string): boolean => SHELLS.has(lang.toLowerCase())

/** Only the commands of a terminal block: prompt marks go, sample output lines go, a line continued with \ or ` stays whole. */
export function shellCommand(code: string): string {
  const lines = code.replace(/\s+$/, '').split('\n')
  if (!lines.some((l) => PROMPT.test(l))) return lines.join('\n')
  const out: string[] = []
  let more = false
  for (const l of lines) {
    if (PROMPT.test(l)) out.push(l.replace(PROMPT, ''))
    else if (more) out.push(l)
    else continue
    more = /[\\`^]\s*$/.test(l)
  }
  return out.join('\n')
}

/** The code blocks of a Markdown text, in order. An unclosed fence (a reply still streaming) counts, as the screen shows it. */
export function codeBlocks(md: string): { lang: string; code: string }[] {
  const out: { lang: string; code: string }[] = []
  let open: { fence: string; lang: string; lines: string[] } | undefined
  for (const line of md.split('\n')) {
    if (open) {
      const m = /^ {0,3}(`{3,}|~{3,})\s*$/.exec(line)
      if (m && m[1][0] === open.fence[0] && m[1].length >= open.fence.length) {
        out.push({ lang: open.lang, code: open.lines.join('\n') })
        open = undefined
      } else open.lines.push(line)
    } else {
      const m = /^ {0,3}(`{3,}|~{3,})\s*([^\s`]*)/.exec(line)
      if (m) open = { fence: m[1], lang: m[2], lines: [] }
    }
  }
  if (open) out.push({ lang: open.lang, code: open.lines.join('\n') })
  return out
}

export type TableFormat = 'md' | 'tsv' | 'csv'

export function tableText(rows: string[][], fmt: TableFormat): string {
  const clean = (c: string): string => c.replace(/\s+/g, ' ').trim()
  const grid = rows.map((r) => r.map(clean))
  if (fmt === 'tsv') return grid.map((r) => r.join('\t')).join('\n')
  if (fmt === 'csv') return grid.map((r) => r.map((c) => (/[",\n]/.test(c) ? `"${c.replace(/"/g, '""')}"` : c)).join(',')).join('\n')
  const line = (r: string[]): string => `| ${r.map((c) => c.replace(/\|/g, '\\|')).join(' | ')} |`
  return grid.length ? [line(grid[0]), line(grid[0].map(() => '---')), ...grid.slice(1).map(line)].join('\n') : ''
}

/** Several files get their path above the diff, as the diff view shows it. */
export function diffText(diffs: FileDiff[]): string {
  return diffs.map((d) => (/^(---|diff )/.test(d.diff) ? d.diff : `${d.path}\n${d.diff}`)).join('\n\n')
}

/** What a Write or Edit put on disk: the model's own text when it sent one, else the added lines of the diff. */
export function newContent(input: unknown, diffs?: FileDiff[]): string {
  const i = (input || {}) as Record<string, unknown>
  const s = (v: unknown): string => (typeof v === 'string' ? v : '')
  if (s(i.content)) return s(i.content)
  if (s(i.new_string)) return s(i.new_string)
  if (Array.isArray(i.edits)) {
    const parts = i.edits.map((e) => s((e as Record<string, unknown>)?.new_string)).filter(Boolean)
    if (parts.length) return parts.join('\n')
  }
  if (s(i.new_source)) return s(i.new_source)
  return (diffs || [])
    .flatMap((d) => d.diff.split('\n').filter((l) => l.startsWith('+') && !l.startsWith('+++')).map((l) => l.slice(1)))
    .join('\n')
}

/** The same path as Explorer's "Copy as path": absolute and in double quotes. */
export function quotePath(p: string): string {
  return `"${p.replace(/"/g, '')}"`
}

/** A path written in chat with an optional :line suffix, joined to the folder the conversation works in when it is relative. */
export function resolvePath(raw: string, cwd?: string): string | undefined {
  const p = raw.replace(/:\d+(?::\d+)?$/, '')
  if (/^[a-z]:[\\/]/i.test(p)) return p.replace(/\//g, '\\')
  if (p.startsWith('/')) return p
  if (!cwd || p.startsWith('~')) return undefined
  const sep = cwd.includes('\\') ? '\\' : '/'
  return cwd.replace(/[\\/]+$/, '') + sep + p.replace(/^\.[\\/]/, '').replace(/[\\/]/g, sep)
}
