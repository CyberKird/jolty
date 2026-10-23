// The pure part of the model watch: what is new, what is updated, how long a badge lasts.
// No Electron and no network here, so test/model-watch-test.ts can run it as it is.
import type { ModelOption } from '@shared/types'

export const FLAG_DAYS = 7
const MAX_PER_SOURCE = 500
const MAX_TEXT = 200

export type Flag = 'new' | 'updated'

/** What one source lists for one model today. `version` is whatever changes when the model behind the name does. */
export interface Observed {
  id: string
  label: string
  version?: string
}

export interface SeenModel extends Observed {
  /** when Jolty first saw this id */
  first: number
  flag?: Flag
  /** when the flag was set */
  at?: number
}

/** Per source (a profile id, or "ollama"): the models Jolty has seen. A source that is absent was never recorded. */
export type SeenFile = Record<string, SeenModel[]>

export interface Observation {
  next: SeenModel[]
  fresh: Observed[]
  changed: Observed[]
}

const clip = (s: unknown): string => String(s ?? '').slice(0, MAX_TEXT)

/**
 * Diffs what a source lists now against what was recorded. The first time a source is seen it is only recorded.
 * Models are never forgotten: one that drops out of the list for a day and returns is not new again.
 * An empty list (the listing failed quietly) changes nothing.
 */
export function observe(prev: SeenModel[] | undefined, current: Observed[], now: number): Observation {
  const list = current
    .filter((m) => m && typeof m.id === 'string' && m.id && m.id.length <= MAX_TEXT)
    .filter((m, i, all) => all.findIndex((x) => x.id === m.id) === i)
    .slice(0, MAX_PER_SOURCE)
    .map((m) => ({ id: m.id, label: clip(m.label || m.id), version: m.version === undefined ? undefined : clip(m.version) }))
  if (!list.length) return { next: prev || [], fresh: [], changed: [] }
  if (!prev) return { next: list.map((m) => ({ ...m, first: now })), fresh: [], changed: [] }
  const seenNow = new Map(list.map((m) => [m.id, m]))
  const fresh: Observed[] = []
  const changed: Observed[] = []
  // a missing version never counts as a change: a source that stops sending it keeps the version it had
  const next = prev.map((old) => {
    const m = seenNow.get(old.id)
    if (!m || (old.label === m.label && (m.version === undefined || old.version === m.version))) return old
    changed.push(m)
    return { ...old, label: m.label, version: m.version ?? old.version, flag: 'updated' as const, at: now }
  })
  const known = new Set(prev.map((m) => m.id))
  for (const m of list) {
    if (known.has(m.id)) continue
    fresh.push(m)
    next.push({ ...m, first: now, flag: 'new', at: now })
  }
  return { next: next.slice(0, MAX_PER_SOURCE), fresh, changed }
}

/** The badge a model carries today: a flag lasts FLAG_DAYS from when it was set. */
export function flagOf(rec: SeenModel | undefined, now: number): Flag | undefined {
  if (!rec?.flag || rec.at === undefined) return undefined
  return now - rec.at < FLAG_DAYS * 864e5 ? rec.flag : undefined
}

/** Puts the badges on a list the picker is about to show. */
export function withBadges(models: ModelOption[], seen: SeenModel[] | undefined, now: number): ModelOption[] {
  if (!seen) return models
  const byId = new Map(seen.map((m) => [m.id, m]))
  return models.map((m) => {
    const badge = flagOf(byId.get(m.id), now)
    return badge ? { ...m, badge } : m
  })
}

/** A model list from an OpenAI-style `GET /models`: { data: [{ id, name? }] }. Anything else is an empty list. */
export function parseProviderList(raw: unknown): Observed[] {
  const data = (raw as { data?: unknown } | null)?.data
  if (!Array.isArray(data)) return []
  const out: Observed[] = []
  for (const m of data) {
    const { id, name } = (m && typeof m === 'object' ? m : {}) as Record<string, unknown>
    if (typeof id === 'string' && id) out.push({ id, label: typeof name === 'string' && name ? name : id })
  }
  return out
}

/** Ollama's `GET /api/tags`: the digest changes when a tag is pulled again and the model behind it is newer. */
export function parseOllamaTags(raw: unknown): Observed[] {
  const models = (raw as { models?: unknown } | null)?.models
  if (!Array.isArray(models)) return []
  const out: Observed[] = []
  for (const m of models) {
    const { name, digest } = (m && typeof m === 'object' ? m : {}) as Record<string, unknown>
    if (typeof name === 'string' && name) out.push({ id: name, label: name, version: typeof digest === 'string' ? digest.slice(0, 12) : undefined })
  }
  return out
}
