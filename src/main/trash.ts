// Conversations the user removed this run. The transcript and the metadata move to <data>/trash so "Reopen closed" can bring
// them back; nothing stays in memory. The folder is wiped when Jolty closes and at the next start (a crash cannot leave it).
import fs from 'fs'
import path from 'path'
import type { ChatItem, ClosedSession, SessionMeta } from '@shared/types'
import { dataDir, loadSessions, saveSessions, saveTranscript, slimTranscript } from './store'

/** how many removed conversations stay restorable; older ones are gone for good */
export const KEEP = 20

interface Entry {
  meta: SessionMeta
  deletedAt: number
  transcript: ChatItem[]
}

const dir = (): string => path.join(dataDir(), 'trash')
const fileOf = (id: string): string => path.join(dir(), `${id.replace(/[^\w-]/g, '_')}.json`)

function read(f: string): Entry | undefined {
  try {
    return JSON.parse(fs.readFileSync(f, 'utf8')) as Entry
  } catch {
    return undefined
  }
}

function entries(): { file: string; entry: Entry }[] {
  let names: string[] = []
  try {
    names = fs.readdirSync(dir())
  } catch {
    return []
  }
  return names.flatMap((n) => {
    const file = path.join(dir(), n)
    const entry = n.endsWith('.json') ? read(file) : undefined
    return entry ? [{ file, entry }] : []
  })
}

/** Keeps a removed conversation; returns the ones that fell out of the limit, for the caller to finish (their worktree). */
export function stash(meta: SessionMeta, transcript: ChatItem[]): SessionMeta[] {
  fs.mkdirSync(dir(), { recursive: true })
  // the same slimming as the saved transcript: tool images are not kept
  fs.writeFileSync(fileOf(meta.id), JSON.stringify({ meta, deletedAt: Date.now(), transcript: slimTranscript(transcript) } satisfies Entry))
  return entries()
    .sort((a, b) => b.entry.deletedAt - a.entry.deletedAt)
    .slice(KEEP)
    .map((e) => {
      fs.rmSync(e.file, { force: true })
      return e.entry.meta
    })
}

export function closed(): ClosedSession[] {
  return entries()
    .map(({ entry: e }) => ({ id: e.meta.id, title: e.meta.title, cwd: e.meta.cwd, deletedAt: e.deletedAt }))
    .sort((a, b) => b.deletedAt - a.deletedAt)
}

/** Puts the conversation back (the newest removed one when no id): same id, same last-activity time. */
export function restore(id?: string): SessionMeta {
  const target = id ?? closed()[0]?.id
  const f = target && fileOf(target)
  const entry = f ? read(f) : undefined
  if (!f || !entry) throw new Error('Nothing to reopen')
  saveTranscript(entry.meta.id, entry.transcript)
  const all = loadSessions().filter((s) => s.id !== entry.meta.id)
  saveSessions([...all, entry.meta])
  fs.rmSync(f, { force: true })
  return entry.meta
}

/**
 * Wipes the folder; `keepWorktrees` leaves a metadata-only file for the conversations that own a git worktree, so the
 * next start can still clean the worktree. Returns the metas of every wiped conversation.
 */
export function purge(keepWorktrees = false): SessionMeta[] {
  return entries().map(({ file, entry }) => {
    if (keepWorktrees && entry.meta.worktree) fs.writeFileSync(file, JSON.stringify({ ...entry, transcript: [] }))
    else fs.rmSync(file, { force: true })
    return entry.meta
  })
}
