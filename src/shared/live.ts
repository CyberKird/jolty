import type { PermissionRequest, SessionMeta } from './types'

export type LiveState = 'waiting' | 'running' | 'done'
export interface LiveRow {
  session: SessionMeta
  state: LiveState
  /** 1 for a session started by a lead that is in the list too */
  depth: number
}

interface LiveInput {
  sessions: Pick<SessionMeta, 'id' | 'parentId' | 'createdAt'>[]
  status: Record<string, 'idle' | 'running' | 'error'>
  permissions: Record<string, PermissionRequest[]>
  unseen: Record<string, true>
}

/**
 * The conversations to keep in sight: waiting for the user's answer first, then working, then finished and not yet
 * looked at. Order inside a group is by start, so rows do not jump while they work; sessions a lead started follow it.
 */
export function liveRows<S extends LiveInput['sessions'][number]>(s: Omit<LiveInput, 'sessions'> & { sessions: S[] }): { session: S; state: LiveState; depth: number }[] {
  const rank = { waiting: 0, running: 1, done: 2 }
  type Row = { session: S; state: LiveState; depth: number }
  const rows: Row[] = []
  for (const session of s.sessions) {
    const state: LiveState | undefined = s.permissions[session.id]?.length ? 'waiting' : s.status[session.id] === 'running' ? 'running' : s.unseen[session.id] ? 'done' : undefined
    if (state) rows.push({ session, state, depth: 0 })
  }
  const ids = new Set(rows.map((r) => r.session.id))
  const byStart = (a: Row, b: Row): number => rank[a.state] - rank[b.state] || a.session.createdAt - b.session.createdAt
  const roots = rows.filter((r) => !r.session.parentId || !ids.has(r.session.parentId)).sort(byStart)
  return roots.flatMap((r) => [r, ...rows.filter((k) => k.session.parentId === r.session.id).sort(byStart).map((k) => ({ ...k, depth: 1 }))])
}
