// Pin, archive and reopen-closed actions for the sidebar; each one that hides something offers Undo.
import { tr } from '@shared/i18n'
import type { SessionMeta } from '@shared/types'
import { api, errMsg, useStore } from './store'

const st = (): ReturnType<typeof useStore.getState> => useStore.getState()
const fail = (err: unknown): void => st().toast(errMsg(err), true)

async function flags(ids: string[], f: { pinned?: boolean; archived?: boolean }): Promise<void> {
  await api.sessions.setFlags(ids, f)
  // the main process already sent each meta; this keeps the list right if an event was missed
  await st().loadSessions()
}

export function togglePin(s: Pick<SessionMeta, 'id' | 'pinned'>): void {
  void flags([s.id], { pinned: !s.pinned }).catch(fail)
}

export function archive(ids: string[]): void {
  if (!ids.length) return
  void flags(ids, { archived: true })
    .then(() => {
      if (ids.includes(st().activeId ?? '')) void st().openSession(undefined)
      st().toast(ids.length === 1 ? tr("Conversația a fost arhivată") : tr("{n} conversații arhivate", { n: ids.length }), false, { label: tr("Anulează"), run: () => void flags(ids, { archived: false }).catch(fail) })
    })
    .catch(fail)
}

export const unarchive = (ids: string[]): void => void flags(ids, { archived: false }).catch(fail)

/** Brings a removed conversation back (the newest when no id) and opens it. */
export function reopenClosed(id?: string, open = true): void {
  void api.sessions
    .restore(id)
    .then(async (meta) => {
      await st().loadSessions()
      if (open) await st().openSession(meta.id)
    })
    .catch(fail)
}
