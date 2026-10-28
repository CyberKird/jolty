import { Archive, ArchiveRestore, ChevronRight, MessageSquare, Trash2 } from 'lucide-react'
import { useState } from 'react'
import { tr } from '@shared/i18n'
import type { SessionMeta } from '@shared/types'
import { timeAgo, useStore } from '../store'
import { unarchive } from '../organize'
import { Collapse } from './Collapse'
import { showMenu } from './ContextMenu'

/** Archived conversations at the bottom of the list: closed by default, each one can be opened, unarchived or removed. */
export function ArchivedSection({ list, onRemove }: { list: SessionMeta[]; onRemove: (id: string) => void }) {
  const [open, setOpen] = useState(false)
  const activeId = useStore((st) => (st.page === 'chat' ? st.activeId : undefined))
  const openSession = useStore((st) => st.openSession)
  if (!list.length) return null
  return (
    <div className="session-group archived">
      <button className="archived-head" aria-expanded={open} onClick={() => setOpen(!open)}>
        <ChevronRight size={12} className="chev" />
        <Archive size={12} />
        {tr("Arhivate")}
        <span className="count">{list.length}</span>
      </button>
      <Collapse open={open}>
        {list.map((s) => (
          <div
            key={s.id}
            className={`session-item archived ${activeId === s.id ? 'active' : ''}`}
            role="button"
            tabIndex={0}
            onClick={() => void openSession(s.id)}
            onContextMenu={(e) =>
              showMenu(e, [
                { label: tr("Deschide conversația"), icon: MessageSquare, run: () => void openSession(s.id) },
                { label: tr("Dezarhivează"), icon: ArchiveRestore, run: () => unarchive([s.id]) },
                'sep',
                { label: tr("Scoate din Jolty"), icon: Trash2, run: () => onRemove(s.id) }
              ])
            }
          >
            <span className="title">{s.title}</span>
            <span className="when">{timeAgo(s.updatedAt)}</span>
            <button
              className="row-act"
              title={tr("Dezarhivează")}
              onClick={(e) => {
                e.stopPropagation()
                unarchive([s.id])
              }}
            >
              <ArchiveRestore size={13} />
            </button>
            <button
              className="del"
              title={tr("Scoate din Jolty (sesiunea rămâne în Claude Code / Codex)")}
              onClick={(e) => {
                e.stopPropagation()
                onRemove(s.id)
              }}
            >
              <Trash2 size={13} />
            </button>
          </div>
        ))}
      </Collapse>
    </div>
  )
}
