// "Reference in conversation": another conversation, written as one Markdown file the model can open when it needs it. Only the path
// travels with the message (a few words), so pointing at a long conversation costs nothing until the model actually reads it.
import fs from 'fs'
import path from 'path'
import type { ChatItem, SessionMeta } from '@shared/types'

const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n)}…` : s)

/** The conversation's messages in order; tool runs are one line each (their output is what makes a transcript huge and is rarely what is wanted). */
export function referenceMarkdown(meta: Pick<SessionMeta, 'title' | 'cwd'>, items: ChatItem[]): string {
  const out = [`# ${meta.title}`, `Project folder: ${meta.cwd}`, '']
  const files = new Set<string>()
  for (const it of items) {
    if (it.kind === 'user' && it.text.trim()) out.push('## User', it.text.trim(), '')
    else if (it.kind === 'assistant' && it.text.trim()) out.push('## Assistant', it.text.trim(), '')
    else if (it.kind === 'tool') {
      out.push(`- tool ${it.name}: ${clip(it.command || it.title, 160)}${it.status === 'error' ? ' (failed)' : ''}`)
      for (const d of it.diffs || []) files.add(d.path)
    }
  }
  if (files.size) out.push('', '## Files changed in this conversation', ...[...files].slice(0, 60).map((f) => `- ${f}`))
  return out.join('\n') + '\n'
}

/** Writes the file (the same one again when asked twice) and returns where it is. */
export function writeReference(dataDir: string, meta: Pick<SessionMeta, 'id' | 'title' | 'cwd'>, items: ChatItem[]): string {
  const dir = path.join(dataDir, 'references')
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, `${meta.id.replace(/[^\w-]/g, '_')}.md`)
  fs.writeFileSync(file, referenceMarkdown(meta, items))
  return file
}
