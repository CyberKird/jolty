// Search over the user's earlier Jolty conversations, for the model (Hermes calls it session search).
// Only what was said is indexed (user and assistant text, not tool output), kept per transcript file and
// rebuilt when the file changes, so a search after the first one reads only the chats that moved.
import fs from 'fs'
import type { ChatItem, SessionMeta } from '@shared/types'
import { loadTranscript, transcriptFile } from './store'

export interface Turn {
  role: 'user' | 'assistant'
  text: string
}

/** What a conversation was about and how it ended, so a search result tells enough without reading the chat. */
export interface Digest {
  /** the first thing the user asked */
  ask: string
  /** how the last answer began (empty when the chat ends on the user's message) */
  end: string
}

interface Doc {
  key: string
  turns: Turn[]
  digest: Digest
  /** each turn folded (see fold), same length as the original, so a match points into the original text */
  folded: string[]
}

export interface Hit {
  meta: SessionMeta
  score: number
  snippets: string[]
  digest?: Digest
  /** false: an imported conversation Jolty has not read yet, only its title was searched */
  indexed: boolean
}

const memo = new Map<string, string>()

/** Lower case without diacritics ("Pădure" -> "padure"), one character for one, so positions line up with the original. */
export function fold(s: string): string {
  return s.replace(/[^a-z0-9 \n]/g, (c) => {
    let f = memo.get(c)
    if (f === undefined) {
      f = c.normalize('NFD')[0].toLowerCase()
      if (f.length !== 1) f = c
      memo.set(c, f)
    }
    return f
  })
}

const clean = (s: string): string => s.replace(/\s+/g, ' ').trim()

const ASK_MAX = 220
const END_MAX = 420
/** An answer shorter than this is "Done." and the like: the one before it says more. */
const END_MIN = 60

/** Text with the markdown dressing (bold marks, heading hashes) taken off, cut at a word. */
function brief(s: string, max: number): string {
  const t = clean(s.replace(/\*\*|^#{1,6}\s+/gm, ''))
  if (t.length <= max) return t
  const cut = t.slice(0, max)
  const sp = cut.lastIndexOf(' ')
  return `${(sp > max * 0.6 ? cut.slice(0, sp) : cut).replace(/[\s,;:(-]+$/, '')}...`
}

/** The engines' own notice that a plan ran out ("You've hit your session limit"): in the chat, but it says nothing about the work. */
const LIMIT_NOTICE = /^you'?ve hit your [a-z ]{0,30}limit/i

export function digestOf(all: Turn[]): Digest {
  const turns = all.filter((t) => !LIMIT_NOTICE.test(t.text.trim()))
  const first = turns.find((t) => t.role === 'user')
  let end = ''
  for (let i = turns.length - 1; i >= 0; i--) {
    if (turns[i].role !== 'assistant') continue
    const text = brief(turns[i].text, END_MAX)
    if (!end) end = text
    if (text.length >= END_MIN) {
      end = text
      break
    }
  }
  // the chat ends on the user's message: nothing answered yet, nothing to tell about the end
  return { ask: first ? brief(first.text, ASK_MAX) : '', end: turns[turns.length - 1]?.role === 'assistant' ? end : '' }
}

export function turnsOf(items: ChatItem[]): Turn[] {
  return items.flatMap((i) => ((i.kind === 'user' || i.kind === 'assistant') && i.text.trim() ? [{ role: i.kind, text: i.text }] : []))
}

// whole index in memory (text only, a few tens of MB for hundreds of chats); SQLite FTS if it ever gets slow
const cache = new Map<string, Doc>()

function doc(id: string): Doc | undefined {
  let st: fs.Stats
  try {
    st = fs.statSync(transcriptFile(id))
  } catch {
    return undefined
  }
  const key = `${st.mtimeMs}:${st.size}`
  const hit = cache.get(id)
  if (hit?.key === key) return hit
  const turns = turnsOf(loadTranscript(id))
  const d = { key, turns, digest: digestOf(turns), folded: turns.map((t) => fold(t.text)) }
  cache.set(id, d)
  return d
}

/** The saved conversation's turns, or undefined when Jolty has no transcript for it. */
export function savedTurns(id: string): Turn[] | undefined {
  return doc(id)?.turns
}

export function forget(id: string): void {
  cache.delete(id)
}

function count(hay: string, needle: string, cap: number): number {
  let n = 0
  for (let i = hay.indexOf(needle); i >= 0 && n < cap; i = hay.indexOf(needle, i + needle.length)) n++
  return n
}

function snippet(turn: Turn, folded: string, terms: string[]): string {
  const at = Math.min(...terms.map((t) => folded.indexOf(t)).filter((i) => i >= 0))
  const start = Math.max(0, at - 140)
  const end = Math.min(turn.text.length, at + 220)
  return `${turn.role === 'user' ? 'User' : 'Assistant'}: ${start ? '...' : ''}${clean(turn.text.slice(start, end))}${end < turn.text.length ? '...' : ''}`
}

export function searchTerms(query: string): string[] {
  return [...new Set(fold(query).split(/[^\p{L}\p{N}_.\-/\\]+/u).filter((t) => t.length >= 2))].slice(0, 12)
}

/** Best matches first: conversations with every word beat ones with some, then by how often they come up. */
export function search(metas: SessionMeta[], query: string, limit = 8): Hit[] {
  const terms = searchTerms(query)
  if (!terms.length) return []
  const hits: Hit[] = []
  for (const meta of metas) {
    const d = doc(meta.id)
    const head = fold(`${meta.title} ${meta.cwd}`)
    let score = 0
    let matched = 0
    for (const t of terms) {
      let n = count(head, t, 5) * 3
      if (d) for (const f of d.folded) n += count(f, t, 20)
      if (!n) continue
      matched++
      // capped, so a long chat does not win on repetition alone
      score += Math.min(n, 12)
    }
    if (!matched) continue
    score *= matched / terms.length
    const snippets: string[] = []
    if (d) {
      const ranked = d.folded
        .map((f, i) => ({ i, k: terms.filter((t) => f.includes(t)).length }))
        .filter((x) => x.k)
        .sort((a, b) => b.k - a.k || a.i - b.i)
        .slice(0, 2)
        .sort((a, b) => a.i - b.i)
      for (const { i } of ranked) snippets.push(snippet(d.turns[i], d.folded[i], terms))
    }
    hits.push({ meta, score, snippets, digest: d?.digest, indexed: Boolean(d) })
  }
  // a chat moved with "Continue in" carries the old one's history: only the newest link of the chain is shown
  const continued = new Set(hits.map((h) => h.meta.handoffFrom).filter(Boolean))
  return hits
    .filter((h) => !continued.has(h.meta.id))
    .sort((a, b) => b.score - a.score || b.meta.updatedAt - a.meta.updatedAt)
    .slice(0, limit)
}

/** A conversation as plain text, from `offset` (in characters), in pages of `size`. A negative offset counts from the end: -5000 is the last 5000 characters. */
export function pageOf(turns: Turn[], offset = 0, size = 20000): { text: string; next?: number; total: number } {
  const all = turns.map((t) => `${t.role === 'user' ? '## User' : '## Assistant'}\n${t.text.trim()}`).join('\n\n')
  const from = Math.max(0, Math.min(offset < 0 ? all.length + offset : offset, all.length))
  const to = Math.min(all.length, from + size)
  return { text: all.slice(from, to), next: to < all.length ? to : undefined, total: all.length }
}
