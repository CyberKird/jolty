import { Archive, FolderOpen, GitBranch, GitMerge, Link, Loader2, MessageSquare, MessageSquareDashed, Pencil, Pin, PinOff, Trash2 } from 'lucide-react'
import { useState } from 'react'
import { tr } from '@shared/i18n'
import type { SessionMeta } from '@shared/types'
import { api, timeAgo, useStore } from '../store'
import { archive, togglePin } from '../organize'
import { copyItem, showMenu, type Entry } from './ContextMenu'
import { BranchButton, openMerge } from './MergePanel'

/** One conversation in the sidebar list: open, rename (double click), pin, archive, remove. */
export function SessionRow({ s, onRemove }: { s: SessionMeta; onRemove: (id: string) => void }) {
  const active = useStore((st) => st.page === 'chat' && st.activeId === s.id)
  const running = useStore((st) => st.status[s.id] === 'running')
  const color = useStore((st) => st.profiles.find((p) => p.id === s.profileId)?.color)
  const compacting = useStore((st) => st.compactions[s.id]?.active)
  const openSession = useStore((st) => st.openSession)
  const [renaming, setRenaming] = useState(false)

  const rename = async (title: string): Promise<void> => {
    setRenaming(false)
    if (!title.trim()) return
    await api.sessions.rename(s.id, title)
    await useStore.getState().loadSessions()
  }

  // a temporary chat leaves nothing behind, so it cannot be pinned or archived
  const organize: Entry[] = s.temporary
    ? []
    : [
        { label: s.pinned ? tr("Elimină fixarea") : tr("Fixează sus"), icon: s.pinned ? PinOff : Pin, run: () => togglePin(s) },
        { label: tr("Arhivează"), icon: Archive, run: () => archive([s.id]) },
        'sep'
      ]

  return (
    <div
      className={`session-item ${active ? 'active' : ''}`}
      onClick={() => void openSession(s.id)}
      onContextMenu={(e) =>
        showMenu(e, [
          { label: tr("Deschide conversația"), icon: MessageSquare, run: () => void openSession(s.id) },
          { label: tr("Redenumește"), icon: Pencil, run: () => setRenaming(true) },
          copyItem(tr("Copiază titlul"), s.title),
          'sep',
          ...organize,
          { label: tr("Arată folderul în Explorer"), icon: FolderOpen, run: () => void api.app.revealPath(s.cwd) },
          copyItem(tr("Copiază calea folderului"), s.cwd, Link),
          ...(s.worktree ? [{ label: tr("Asistent de merge"), icon: GitMerge, run: () => openMerge(s.id) }, copyItem(tr("Copiază numele branch-ului"), s.worktree.branch, GitBranch)] : []),
          'sep',
          { label: tr("Scoate din Jolty"), icon: Trash2, run: () => onRemove(s.id) }
        ])
      }
      role="button"
      tabIndex={0}
    >
      <span className={`dot ${running ? 'running' : ''}`} style={{ background: color }} />
      {compacting && <Loader2 size={11} className="spin compact-dot" aria-label={tr("Compactez conversația...")} />}
      <BranchButton s={s} />
      {renaming ? (
        <input
          className="title-edit"
          autoFocus
          defaultValue={s.title}
          maxLength={80}
          aria-label={tr("Titlul conversației")}
          onFocus={(e) => e.currentTarget.select()}
          onClick={(e) => e.stopPropagation()}
          onKeyDown={(e) => {
            e.stopPropagation()
            if (e.key === 'Enter') void rename(e.currentTarget.value)
            if (e.key === 'Escape') setRenaming(false)
          }}
          onBlur={(e) => void rename(e.currentTarget.value)}
        />
      ) : (
        <span className="title" onDoubleClick={() => setRenaming(true)}>
          {s.temporary && <MessageSquareDashed size={11} className="temp-mark" aria-label={tr("Temporar")} />}
          {s.pinned && <Pin size={11} className="pin-mark" aria-label={tr("Fixată")} />}
          {s.title}
        </span>
      )}
      <span className="when">{timeAgo(s.updatedAt)}</span>
      {!s.temporary && (
        <button
          className="row-act"
          title={s.pinned ? tr("Elimină fixarea") : tr("Fixează sus")}
          onClick={(e) => {
            e.stopPropagation()
            togglePin(s)
          }}
        >
          {s.pinned ? <PinOff size={13} /> : <Pin size={13} />}
        </button>
      )}
      <button
        className="del"
        title={s.temporary ? tr("Șterge conversația temporară (nu se salvează nimic din ea)") : tr("Scoate din Jolty (sesiunea rămâne în Claude Code / Codex)")}
        onClick={(e) => {
          e.stopPropagation()
          onRemove(s.id)
        }}
      >
        <Trash2 size={13} />
      </button>
    </div>
  )
}
