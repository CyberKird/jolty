import type { PermissionRequest, SessionMeta } from './types'

/** Pinned ones first, archived ones apart; every list keeps the order it came in. */
export function splitSessions<S extends Pick<SessionMeta, 'pinned' | 'archived'>>(list: S[]): { pinned: S[]; rest: S[]; archived: S[] } {
  return { pinned: list.filter((s) => s.pinned && !s.archived), rest: list.filter((s) => !s.pinned && !s.archived), archived: list.filter((s) => s.archived) }
}

/** Runs nobody types in anymore: scheduled-task runs and sessions a lead started, once they stopped and wait for nothing. */
export function finishedToArchive<S extends Pick<SessionMeta, 'id' | 'pinned' | 'archived' | 'scheduled' | 'parentId' | 'temporary'>>(
  list: S[],
  status: Record<string, 'idle' | 'running' | 'error'>,
  permissions: Record<string, PermissionRequest[] | undefined>
): S[] {
  return list.filter((s) => (s.scheduled || s.parentId) && !s.pinned && !s.archived && !s.temporary && status[s.id] !== 'running' && !permissions[s.id]?.length)
}
