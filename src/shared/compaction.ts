// What the interface knows about a conversation being compacted: it shows a pill while `active` and the result for a
// few seconds after. Pure, so the rules (a stuck pill must never stay) are testable.
export interface CompactState {
  active: boolean
  /** tokens in the context before and after, when the engine says */
  before?: number
  after?: number
  failed?: boolean
  /** when it last changed, for the brief result */
  at: number
}

export type CompactEvent = { active: boolean; before?: number; after?: number; failed?: boolean }

/** How long the result stays after a compaction ends. */
export const RESULT_MS = 7000

export function reduceCompaction(prev: CompactState | undefined, e: CompactEvent, now = Date.now()): CompactState {
  // the end of a compaction keeps the size the start reported when the end brings none
  return { active: e.active, before: e.before ?? prev?.before, after: e.after, failed: e.failed, at: now }
}

/** A turn that is no longer running has no compaction going on: the pill goes, a result already shown stays. */
export function settleCompaction(prev: CompactState | undefined, now = Date.now()): CompactState | undefined {
  return prev?.active ? { active: false, failed: true, at: now } : prev
}

/** What to draw: the working pill, the brief result, or nothing. */
export function compactView(s: CompactState | undefined, now = Date.now()): 'working' | 'done' | 'failed' | undefined {
  if (!s) return undefined
  if (s.active) return 'working'
  return now - s.at < RESULT_MS ? (s.failed ? 'failed' : 'done') : undefined
}
