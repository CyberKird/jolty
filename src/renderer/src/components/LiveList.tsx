import { Check, CircleAlert, GitBranch, X } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { api, basename, liveRows, useStore } from '../store'
import { copyItem, showMenu } from './ContextMenu'
import { tr } from '@shared/i18n'

/** Time since a turn started, ticking on its own so the list does not render every second. */
function Elapsed({ since }: { since?: number }) {
  const [, tick] = useState(0)
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 1000)
    return () => clearInterval(t)
  }, [])
  if (!since) return null
  const s = Math.max(0, Math.round((Date.now() - since) / 1000))
  const m = Math.floor(s / 60)
  return <>{m >= 60 ? `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m` : `${m}:${String(s % 60).padStart(2, '0')}`}</>
}

/**
 * What is going on right now, above the conversation list: sessions waiting for the user, sessions working
 * (with their current step) and sessions that finished while the user was elsewhere. One click switches to one.
 */
export function LiveList() {
  const { sessions, status, permissions, unseen, plans, clocks, activeId, page, openSession, dismissUnseen, profiles } = useStore()
  const rows = useMemo(() => liveRows({ sessions, status, permissions, unseen }), [sessions, status, permissions, unseen])
  if (!rows.length) return null
  return (
    <section className="live-list" aria-label={tr("Live")}>
      <div className="live-head">
        <span className="label">{tr("Live")}</span>
        <span className="label">{rows.length}</span>
      </div>
      {rows.map(({ session: s, state, depth }, i) => {
        const profile = profiles.find((p) => p.id === s.profileId)
        const step = plans[s.id]?.find((x) => x.status === 'active')?.text
        const detail = state === 'waiting' ? permissions[s.id]?.[0]?.title : step || basename(s.cwd)
        return (
          <div
            key={s.id}
            className={`live-item ${state} ${page === 'chat' && activeId === s.id ? 'active' : ''}`}
            style={depth ? { paddingInlineStart: 26 } : undefined}
            role="button"
            tabIndex={0}
            title={`${s.title}\n${s.cwd}${i < 9 ? `\nAlt+${i + 1}` : ''}`}
            onClick={() => void openSession(s.id)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault()
                void openSession(s.id)
              }
            }}
            onContextMenu={(e) =>
              showMenu(e, [
                ...(s.worktree ? [copyItem(tr("Copiază numele branch-ului"), s.worktree.branch, GitBranch), { label: tr("Arată worktree-ul în Explorer"), run: () => void api.app.revealPath(s.worktree!.path) }] : []),
                ...(state === 'done' ? [{ label: tr("Ascunde din Live"), run: () => dismissUnseen(s.id) }] : [])
              ])
            }
          >
            {state === 'waiting' ? <CircleAlert size={13} className="live-icon wait" /> : state === 'done' ? <Check size={13} className="live-icon done" /> : <span className="dot running" />}
            <span className="live-text">
              <span className="live-title">
                {s.worktree && <GitBranch size={11} className="live-branch" aria-label={s.worktree.branch} />}
                <span className="ellipsis">{s.title}</span>
              </span>
              <span className="live-sub ellipsis" style={{ ['--c' as string]: profile?.color }}>
                {state === 'waiting' ? tr("Așteaptă aprobarea ta") : state === 'done' ? tr("Gata") : tr("Rulează")}
                {detail ? ` · ${detail}` : ''}
              </span>
            </span>
            {state === 'running' && (
              <span className="live-time">
                <Elapsed since={clocks[s.id]?.turn} />
              </span>
            )}
            {state === 'done' && (
              <button
                className="live-x"
                title={tr("Ascunde din Live")}
                onClick={(e) => {
                  e.stopPropagation()
                  dismissUnseen(s.id)
                }}
              >
                <X size={12} />
              </button>
            )}
          </div>
        )
      })}
    </section>
  )
}
