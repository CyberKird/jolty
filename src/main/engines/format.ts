import type { FileDiff } from '@shared/types'
import { tr } from '@shared/i18n'

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
      return tr("Citește {str}", { str: str(input.file_path) })
    case 'Edit':
    case 'MultiEdit':
      return tr("Editează {str}", { str: str(input.file_path) })
    case 'Write':
      return tr("Scrie {str}", { str: str(input.file_path) })
    case 'NotebookEdit':
      return tr("Editează {str}", { str: str(input.notebook_path) })
    case 'Glob':
      return tr("Caută fișiere {str}", { str: str(input.pattern) })
    case 'Grep':
      return tr("Caută \"{str}\"", { str: str(input.pattern) })
    case 'WebFetch':
      return tr("Deschide {str}", { str: str(input.url) })
    case 'WebSearch':
      return tr("Caută pe web: {str}", { str: str(input.query) })
    case 'Task':
    case 'Agent':
      return `Subagent: ${str(input.description) || str(input.subagent_type)}`
    case 'TodoWrite':
      return tr("Actualizează lista de sarcini")
    case 'ExitPlanMode':
      return tr("Planul e gata")
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

/** Base64 image blocks of a tool result as data: URLs, so the chat can show what the agent looked at. */
export function toolResultImages(content: unknown): string[] | undefined {
  if (!Array.isArray(content)) return undefined
  const urls = content.flatMap((c) => {
    const src = (c as { type?: string; source?: { type?: string; media_type?: string; data?: string } })?.source
    return (c as { type?: string }).type === 'image' && src?.type === 'base64' && /^image\/(png|jpeg|gif|webp)$/.test(String(src.media_type)) && src.data
      ? [`data:${src.media_type};base64,${src.data}`]
      : []
  })
  return urls.length ? urls : undefined
}

export function truncate(text: string, max = 20000): string {
  return text.length > max ? text.slice(0, max) + `\n... (${text.length - max} caractere ascunse)` : text
}
