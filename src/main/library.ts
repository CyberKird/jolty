// The Library page: what was attached to or linked in any conversation, in one place (pictures, videos, sounds, files, links), the way
// a chat app lists what a conversation holds. Built from the saved transcripts; only the names and places are listed here, the pictures
// themselves are fetched one at a time, small, when the page shows them.
import type { Library, LibraryFile } from '@shared/library'
import type { ChatItem, SessionMeta } from '@shared/types'

const MAX = 600
const URL_RE = /https?:\/\/[^\s<>"'`)\]}]+/g

/** The address, without the sentence's own punctuation after it. */
export function cleanUrl(raw: string): string {
  return raw.replace(/[.,;:!?*_]+$/, '')
}

export function hostOf(url: string): string {
  try {
    return new URL(url).host.replace(/^www\./, '')
  } catch {
    return url
  }
}

export function kindOf(mime: string): LibraryFile['kind'] {
  if (/^video\//i.test(mime)) return 'video'
  if (/^audio\//i.test(mime)) return 'audio'
  return 'file'
}

/** Newest conversations first; inside one, in the order they were sent. A link seen again keeps its newest place. */
export function buildLibrary(sessions: Pick<SessionMeta, 'id' | 'title' | 'updatedAt'>[], load: (id: string) => ChatItem[]): Library {
  const out: Library = { images: [], files: [], links: [] }
  const seen = new Set<string>()
  for (const s of [...sessions].sort((a, b) => b.updatedAt - a.updatedAt)) {
    let items: ChatItem[]
    try {
      items = load(s.id)
    } catch {
      continue
    }
    for (const it of items) {
      if (it.kind === 'user') {
        it.images?.forEach((img, index) => out.images.length < MAX && out.images.push({ sessionId: s.id, title: s.title, itemId: it.id, index, name: img.name, at: s.updatedAt }))
        for (const f of it.files || []) if (out.files.length < MAX) out.files.push({ sessionId: s.id, title: s.title, itemId: it.id, name: f.name, mime: f.mime, kind: kindOf(f.mime), at: s.updatedAt })
      }
      if ((it.kind === 'user' || it.kind === 'assistant') && it.text) {
        for (const m of it.text.matchAll(URL_RE)) {
          const url = cleanUrl(m[0])
          if (url.length < 12 || seen.has(url) || out.links.length >= MAX) continue
          seen.add(url)
          out.links.push({ sessionId: s.id, title: s.title, url, host: hostOf(url), at: s.updatedAt })
        }
      }
    }
  }
  return out
}
