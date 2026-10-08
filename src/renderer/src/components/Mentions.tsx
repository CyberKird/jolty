// "/" for skills and commands at the start of a message, "@" for project files anywhere, like Claude Code.
import { File, Sparkles, SquareSlash } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import type { SlashItem } from '@shared/types'
import { api } from '../store'
import { tr } from '@shared/i18n'

interface Token {
  kind: '/' | '@'
  query: string
  start: number
  end: number
}

export interface MentionItem {
  key: string
  label: string
  detail?: string
  icon: 'skill' | 'command' | 'file'
  insert: string
}

/** The "/" or "@" word the caret is in, if any. */
function tokenAt(text: string, caret: number): Token | undefined {
  const before = text.slice(0, caret)
  const m = /(^|\s)([/@])([^\s]*)$/.exec(before)
  if (!m) return undefined
  const start = before.length - m[2].length - m[3].length
  if (m[2] === '/' && before.slice(0, start).trim()) return undefined
  return { kind: m[2] as '/' | '@', query: m[3].toLowerCase(), start, end: caret }
}

const slashCache = new Map<string, Promise<SlashItem[]>>()
const fileCache = new Map<string, Promise<string[]>>()

export function useMentions(text: string, caret: number, cwd?: string) {
  const token = useMemo(() => tokenAt(text, caret), [text, caret])
  const [slash, setSlash] = useState<SlashItem[]>([])
  const [files, setFiles] = useState<string[]>([])
  const [index, setIndex] = useState(0)
  const [closedAt, setClosedAt] = useState<number>()

  useEffect(() => {
    if (token?.kind !== '/') return
    const k = cwd || ''
    if (!slashCache.has(k)) slashCache.set(k, api.composer.slash(cwd).catch(() => []))
    void slashCache.get(k)!.then(setSlash)
  }, [token?.kind, cwd])
  useEffect(() => {
    if (token?.kind !== '@' || !cwd) return
    if (!fileCache.has(cwd)) fileCache.set(cwd, api.composer.files(cwd).catch(() => []))
    void fileCache.get(cwd)!.then(setFiles)
  }, [token?.kind, cwd])

  const items: MentionItem[] = useMemo(() => {
    if (!token) return []
    const q = token.query
    if (token.kind === '/') {
      return slash
        .filter((s) => !q || s.name.toLowerCase().includes(q))
        .sort((a, b) => Number(!a.name.toLowerCase().startsWith(q)) - Number(!b.name.toLowerCase().startsWith(q)))
        .slice(0, 8)
        .map((s) => ({ key: `${s.kind}:${s.name}`, label: `/${s.name}`, detail: s.description || (s.scope === 'proiect' ? tr("din proiect") : undefined), icon: s.kind, insert: `/${s.name} ` }))
    }
    const base = (p: string): string => p.slice(p.lastIndexOf('/') + 1).toLowerCase()
    return files
      .filter((f) => !q || f.toLowerCase().includes(q))
      .sort((a, b) => Number(!base(a).startsWith(q)) - Number(!base(b).startsWith(q)) || a.length - b.length)
      .slice(0, 8)
      .map((f) => ({ key: f, label: f.slice(f.lastIndexOf('/') + 1), detail: f.includes('/') ? f.slice(0, f.lastIndexOf('/')) : undefined, icon: 'file' as const, insert: `@${f} ` }))
  }, [token, slash, files])

  useEffect(() => setIndex(0), [token?.kind, token?.query])
  const open = Boolean(token && items.length && closedAt !== token.start)
  return {
    open,
    items,
    index,
    move: (d: number) => setIndex((i) => (i + d + items.length) % items.length),
    close: () => setClosedAt(token?.start),
    /** the text with the chosen item in place of the token, and where the caret goes */
    apply: (item: MentionItem): { text: string; caret: number } => {
      const t = token!
      const next = text.slice(0, t.start) + item.insert + text.slice(t.end)
      return { text: next, caret: t.start + item.insert.length }
    }
  }
}

export function MentionMenu({ items, index, onPick, onHover }: { items: MentionItem[]; index: number; onPick: (i: MentionItem) => void; onHover: (i: number) => void }) {
  return (
    <div className="mentions" role="listbox" aria-label={tr("Sugestii")}>
      {items.map((it, i) => (
        <button
          key={it.key}
          role="option"
          aria-selected={i === index}
          className={`mention ${i === index ? 'on' : ''}`}
          onMouseDown={(e) => e.preventDefault()}
          onMouseEnter={() => onHover(i)}
          onClick={() => onPick(it)}
        >
          {it.icon === 'file' ? <File size={14} /> : it.icon === 'skill' ? <Sparkles size={14} /> : <SquareSlash size={14} />}
          <span className="mention-label">{it.label}</span>
          {it.detail && <span className="mention-detail">{it.detail}</span>}
        </button>
      ))}
      <div className="mentions-hint">{tr("↑↓ alegi · Enter sau Tab pui · Esc închizi")}</div>
    </div>
  )
}
