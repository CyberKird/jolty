import type { ChatItem } from './types'

/** One hit of the find bar: the item it is in (index in the transcript) and which occurrence inside that item. */
export interface FindMatch {
  item: number
  nth: number
}

/** What the find bar searches in an item: what the reader sees of a message, a tool's title and command. */
export function itemText(it: ChatItem): string {
  if (it.kind === 'user' || it.kind === 'assistant') return it.text
  if (it.kind === 'tool') return [it.title, it.command].filter(Boolean).join('\n')
  return ''
}

/** Where `query` starts in `text`, ignoring case; hits do not overlap. */
export function offsetsOf(text: string, query: string): number[] {
  if (!query) return []
  const hay = text.toLowerCase()
  const needle = query.toLowerCase()
  const out: number[] = []
  for (let at = hay.indexOf(needle); at >= 0; at = hay.indexOf(needle, at + needle.length)) out.push(at)
  return out
}

// shortcut: counts in the raw markdown, so a hit inside link syntax counts but shows no highlight; strip markdown first if it matters
export function findMatches(items: readonly ChatItem[], query: string): FindMatch[] {
  if (!query) return []
  const out: FindMatch[] = []
  items.forEach((it, item) => {
    const n = offsetsOf(itemText(it), query).length
    for (let nth = 0; nth < n; nth++) out.push({ item, nth })
  })
  return out
}

/** The next (dir 1) or previous (dir -1) hit, wrapping at both ends. */
export function stepMatch(current: number, total: number, dir: 1 | -1): number {
  return total ? (current + dir + total) % total : 0
}

/** How many chunks of older messages the window needs so that `index` is in it (see useWindowedItems). */
export function chunksToReach(index: number, base: number, chunk: number): number {
  return Math.max(1, Math.ceil((base - index) / chunk))
}
