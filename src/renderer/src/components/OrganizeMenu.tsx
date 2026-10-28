import { Archive, MoreHorizontal, Undo2 } from 'lucide-react'
import { useEffect } from 'react'
import { finishedToArchive } from '@shared/organize'
import { kbd, tr } from '@shared/i18n'
import { api, useStore } from '../store'
import { archive, reopenClosed } from '../organize'
import { showMenu } from './ContextMenu'

/** The "..." in the list header: reopen removed conversations, archive finished scheduled and parallel runs. Ctrl+Shift+T reopens the last one too. */
export function OrganizeMenu() {
  useEffect(() => {
    const key = (e: KeyboardEvent): void => {
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && !e.altKey && e.code === 'KeyT') {
        e.preventDefault()
        reopenClosed()
      }
    }
    window.addEventListener('keydown', key)
    return () => window.removeEventListener('keydown', key)
  }, [])

  const open = async (at: { clientX: number; clientY: number }): Promise<void> => {
    const { sessions, status, permissions } = useStore.getState()
    const closed = await api.sessions.closed().catch(() => [])
    const done = finishedToArchive(sessions, status, permissions)
    showMenu({ ...at, preventDefault: () => undefined }, [
      { label: closed[0] ? tr("Redeschide: {title}", { title: closed[0].title.slice(0, 40) }) : tr("Redeschide ultima conversație închisă"), icon: Undo2, hint: kbd('Ctrl+Shift+T'), disabled: !closed[0], run: () => reopenClosed(closed[0]?.id) },
      ...closed.slice(1, 6).map((c) => ({ label: c.title.slice(0, 48), icon: Undo2, run: () => reopenClosed(c.id) })),
      'sep',
      { label: done.length ? tr("Arhivează cele terminate ({n})", { n: done.length }) : tr("Arhivează cele terminate"), icon: Archive, disabled: !done.length, run: () => archive(done.map((s) => s.id)) }
    ])
  }

  return (
    <button
      className="head-act"
      title={`${tr("Redeschide ultima conversație închisă")} · ${tr("Arhivează cele terminate")}`}
      aria-label={tr("Mai multe pentru conversații")}
      onClick={(e) => {
        const r = e.currentTarget.getBoundingClientRect()
        void open({ clientX: r.left, clientY: r.bottom + 4 })
      }}
    >
      <MoreHorizontal size={15} />
    </button>
  )
}
