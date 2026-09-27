import type { FileDiff } from '@shared/types'

const MAX_DIFF_LINES = 400

function prefixLines(text: string, prefix: string): string[] {
  return String(text ?? '').split('\n').map((l) => prefix + l)
}

function clip(lines: string[]): string {
  if (lines.length <= MAX_DIFF_LINES) return lines.join('\n')
  return [...lines.slice(0, MAX_DIFF_LINES), `... (${lines.length - MAX_DIFF_LINES} linii ascunse)`].join('\n')
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : ''
}

/** Diffs for Claude Code's file tools, built from their inputs. */
export function claudeToolDiffs(name: string, input: Record<string, unknown>): FileDiff[] | undefined {
  const file = str(input.file_path) || str(input.notebook_path)
  if (name === 'Edit') {
    return [{ path: file, kind: 'update', diff: clip([...prefixLines(str(input.old_string), '-'), ...prefixLines(str(input.new_string), '+')]) }]
  }
  if (name === 'MultiEdit' && Array.isArray(input.edits)) {
    const lines: string[] = []
    for (const e of input.edits as Record<string, unknown>[]) {
      if (lines.length) lines.push('@@')
      lines.push(...prefixLines(str(e.old_string), '-'), ...prefixLines(str(e.new_string), '+'))
    }
    return [{ path: file, kind: 'update', diff: clip(lines) }]
  }
  if (name === 'Write') {
    return [{ path: file, kind: 'add', diff: clip(prefixLines(str(input.content), '+')) }]
  }
  return undefined
}

/** One-line human title for a tool call. */
export function claudeToolTitle(name: string, input: Record<string, unknown>): string {
  switch (name) {
    case 'Bash':
      return `$ ${str(input.command)}`
    case 'Read':
      return `Citește ${str(input.file_path)}`
    case 'Edit':
    case 'MultiEdit':
      return `Editează ${str(input.file_path)}`
    case 'Write':
      return `Scrie ${str(input.file_path)}`
    case 'NotebookEdit':
      return `Editează ${str(input.notebook_path)}`
    case 'Glob':
      return `Caută fișiere ${str(input.pattern)}`
    case 'Grep':
      return `Caută "${str(input.pattern)}"`
    case 'WebFetch':
      return `Deschide ${str(input.url)}`
    case 'WebSearch':
      return `Caută pe web: ${str(input.query)}`
    case 'Task':
    case 'Agent':
      return `Subagent: ${str(input.description) || str(input.subagent_type)}`
    case 'TodoWrite':
      return 'Actualizează lista de sarcini'
    case 'ExitPlanMode':
      return 'Planul e gata'
    default:
      return name.startsWith('mcp__') ? name.replace(/^mcp__/, '').replace('__', ' / ') : name
  }
}

/** Text content of a tool_result block. */
export function toolResultText(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((c) => (c && typeof c === 'object' && (c as { type?: string }).type === 'text' ? String((c as { text?: string }).text ?? '') : ''))
      .filter(Boolean)
      .join('\n')
  }
  return content == null ? '' : JSON.stringify(content)
}

export function truncate(text: string, max = 20000): string {
  return text.length > max ? text.slice(0, max) + `\n... (${text.length - max} caractere ascunse)` : text
}
