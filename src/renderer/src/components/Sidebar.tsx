import { BarChart3, CalendarClock, Cpu, Download, FolderOpen, KeyRound, Link, MessageSquare, Pencil, Plus, RefreshCw, Search, Settings, ShieldCheck, Trash2 } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { api, basename, fmtTokens, fmtUsd, levelColor, refreshLimitsSoon, resetIn, timeAgo, useStore, type Page } from '../store'
import { copyItem, pathItems, showMenu } from './ContextMenu'
import { MOVE_HINT, useProfileDrag } from '../pages/Accounts'
import { tr } from '@shared/i18n'

function money(n: number, currency = 'USD'): string {
  const v = n.toFixed(2)
  return currency === 'USD' ? `$${v}` : `${v} ${currency}`
}

/**
 * Drag handle for the sidebar's width and for the split between conversations and live usage.
 * While dragging the size goes straight to a CSS variable (no React render per move); it is remembered,
 * and a double click returns to the default.
 */
function Resizer({ axis, label, storeKey, cssVar, host, size, min, max }: {
  axis: 'x' | 'y'
  label: string
  storeKey: string
  cssVar: string
  host: () => HTMLElement | null
  size: () => number
  min: number
  max: () => number
}) {
  useEffect(() => {
    try {
      const v = Number(localStorage.getItem(storeKey))
      if (v) host()?.style.setProperty(cssVar, `${v}px`)
    } catch {
      // remembering the size is a convenience only
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  const save = (v: number | null): void => {
    try {
      if (v) localStorage.setItem(storeKey, String(v))
      else localStorage.removeItem(storeKey)
    } catch {
      // remembering the size is a convenience only
    }
  }
  const start = (e: React.PointerEvent): void => {
    if (e.button !== 0) return
    e.preventDefault()
    const from = size()
    const top = max()
    const x0 = e.clientX
    const y0 = e.clientY
    const flip = document.documentElement.dir === 'rtl' ? -1 : 1
    let v = from
    const root = document.documentElement
    root.classList.add('resizing', `resizing-${axis}`)
    const move = (ev: PointerEvent): void => {
      // the width grows toward the chat; the usage list grows upward
      const d = axis === 'x' ? (ev.clientX - x0) * flip : y0 - ev.clientY
      v = Math.round(Math.max(min, Math.min(top, from + d)))
      host()?.style.setProperty(cssVar, `${v}px`)
    }
    const up = (): void => {
      root.classList.remove('resizing', `resizing-${axis}`)
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      save(v)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }
  return (
    <div
      className={`resizer resizer-${axis}`}
      role="separator"
      aria-orientation={axis === 'x' ? 'vertical' : 'horizontal'}
      aria-label={label}
      title={tr("Trage ca să schimbi mărimea; dublu clic revine la mărimea inițială")}
      onPointerDown={start}
      onDoubleClick={() => {
        host()?.style.removeProperty(cssVar)
        save(null)
      }}
    />
  )
}

function isMiMoProfile(p: { auth: string; baseUrl?: string }): boolean {
  return p.auth === 'endpoint' && /^https:\/\/(?:api|token-plan-cn)\.xiaomimimo\.com(?:[:/]|$)/i.test(p.baseUrl || '')
}

/** Always-visible meter: each account's 5 h / 7 d limits and its last 24 h, updated as turns finish. */
function UsageMeter() {
  const { profiles, limits, spend, spend7d, balances, status, setPage, loadUsage, loadSessions, toast } = useStore()
  const running = Object.values(status).some((s) => s === 'running')
  const [refreshing, setRefreshing] = useState(false)
  useEffect(() => {
    for (const p of profiles) refreshLimitsSoon(p)
  }, [profiles])
  // a profile with empty windows but a note (rate-limited probe) stays visible so the row does not vanish
  const rows = profiles.filter((p) => isMiMoProfile(p) || limits[p.id]?.windows.length || limits[p.id]?.note || spend[p.id]?.tokens || balances[p.id])
  const dragProps = useProfileDrag(rows.map((p) => p.id))
  return (
    <section className="meter" aria-label={tr("Consum live")}>
      <Resizer
        axis="y"
        label={tr("Înălțimea consumului live")}
        storeKey="jolty.meterHeight"
        cssVar="--meter-h"
        host={() => document.querySelector('.sidebar')}
        size={() => document.querySelector('.meter')?.getBoundingClientRect().height || 0}
        min={64}
        // the conversation list keeps at least about two rows
        max={() => (document.querySelector('.meter')?.getBoundingClientRect().height || 0) + (document.querySelector('.session-list')?.getBoundingClientRect().height || 0) - 64}
      />
      <div className="meter-head">
        <span className={`dot ${running ? 'running' : ''}`} style={{ background: running ? 'var(--volt)' : 'var(--grey-2)' }} />
        <span className="label">{tr("Consum live")}</span>
        <button
          className={`meter-refresh ${refreshing ? 'spinning' : ''}`}
          title={`${tr("Importă sesiuni")} · ${tr("Consum live")}`}
          aria-busy={refreshing}
          disabled={refreshing}
          onClick={() => {
            setRefreshing(true)
            // Recheck usage and discover new local conversations, then refresh account limits.
            void (async () => {
              const summary = await Promise.allSettled([loadUsage(), api.sessions.importAll(), new Promise((r) => setTimeout(r, 700))])
              if (summary[0].status === 'rejected') toast(String(summary[0].reason), true)
              if (summary[1].status === 'fulfilled') {
                await loadSessions().catch((err) => toast(String(err), true))
                if (summary[1].value.failed.length) toast(tr("Nu am putut citi: {join} (verifică login-ul în Conturi și chei)", { join: summary[1].value.failed.join(', ') }), true)
              } else toast(String(summary[1].reason), true)
              await Promise.allSettled(profiles.map((p) => refreshLimitsSoon(p, true)))
              setRefreshing(false)
            })()
          }}
        >
          <RefreshCw size={12} />
        </button>
      </div>
      <div className="meter-list">
        {rows.length === 0 && <div className="faint small meter-empty">{tr("Nimic folosit în ultimele 24 h.")}</div>}
        {rows.map((p) => {
          const s = spend[p.id]
          const isMiMo = isMiMoProfile(p)
          const balance = balances[p.id]
          return (
            <button key={p.id} className="meter-row" onClick={() => setPage('usage')} title={`${tr("Deschide Consum")}\n${MOVE_HINT}`} {...dragProps(p.id)}>
            <span className="meter-name">
              <span className="dot" style={{ width: 6, height: 6, background: p.color }} />
              <span className="ellipsis">{p.name}</span>
              {!isMiMo && s?.tokens ? (
                <span className="meter-24h" title={tr("Ultimele 24 de ore")}>
                  {fmtTokens(s.tokens)}
                  {s.costUsd ? ` · ${fmtUsd(s.costUsd)}` : ''}
                </span>
              ) : null}
            </span>
            {isMiMo && (
              <>
                <span className="meter-balance" title={tr("Ultimele 24 de ore")}>
                  <span className="meter-limit-label">24h</span>
                  <b>{fmtTokens(s?.tokens || 0)}</b>
                </span>
                <span className="meter-balance" title={tr("Ultimele 7 zile")}>
                  <span className="meter-limit-label">7d</span>
                  <b>{fmtTokens(spend7d[p.id]?.tokens || 0)}</b>
                </span>
              </>
            )}
            {balance && (!isMiMo || balance.amount !== undefined) && (
              <span className="meter-balance" title={tr("Actualizat {timeAgo}", { timeAgo: timeAgo(balance.updatedAt) })}>
                {balance.amount !== undefined ? (
                  <>
                    <span className="meter-limit-label">{tr("Rămas")}</span>
                    <b className={balance.amount <= 1 ? 'low' : ''}>{money(balance.amount, balance.currency)}</b>
                  </>
                ) : null}
                {balance.note && <span className="faint">{balance.note}</span>}
              </span>
            )}
            {limits[p.id]?.windows.slice(0, 2).map((w) => (
              <span className="meter-limit" key={w.label} title={tr("{label}: {pct}% folosit, {reset}", { label: tr(w.label), pct: Math.round(w.usedPercent), reset: resetIn(w.resetsAt) })}>
                <span className="meter-limit-label">{tr(w.label)}</span>
                <span className="track">
                  <span className="fill" style={{ width: `${Math.min(100, w.usedPercent)}%`, background: levelColor(w.usedPercent) }} />
                </span>
                <span className="meter-pct">{Math.round(w.usedPercent)}%</span>
              </span>
            ))}
            {!limits[p.id]?.windows.length && limits[p.id]?.note && <span className="faint small">{limits[p.id]!.note}</span>}
            </button>
          )
        })}
      </div>
    </section>
  )
}

const NAV: { id: Page; label: string; icon: typeof Plus }[] = [
  { id: 'import', label: tr("Importă sesiuni"), icon: Download },
  { id: 'accounts', label: tr("Conturi și chei"), icon: KeyRound },
  { id: 'local', label: tr("Modele locale"), icon: Cpu },
  { id: 'usage', label: tr("Consum"), icon: BarChart3 },
  { id: 'schedules', label: tr("Programate"), icon: CalendarClock },
  { id: 'system', label: tr("Verificare sistem"), icon: ShieldCheck },
  { id: 'settings', label: tr("Setări"), icon: Settings }
]

export function Sidebar() {
  const { page, setPage, sessions, profiles, activeId, openSession, status, loadSessions, toast } = useStore()
  const [q, setQ] = useState('')
  const [renaming, setRenaming] = useState<string>()
  const saved = useMemo(() => sessions.filter((s) => !s.temporary), [sessions])
  const groups = useMemo(() => {
    const filtered = saved.filter((s) => !q || s.title.toLowerCase().includes(q.toLowerCase()) || s.cwd.toLowerCase().includes(q.toLowerCase()))
    const map = new Map<string, typeof filtered>()
    for (const s of filtered) map.set(s.cwd, [...(map.get(s.cwd) || []), s])
    return [...map.entries()]
  }, [saved, q])

  const removeSession = async (id: string): Promise<void> => {
    await api.sessions.remove(id)
    if (activeId === id) await openSession(undefined)
    await loadSessions()
    toast(tr("Conversația a fost scoasă din Jolty"))
  }

  const rename = async (id: string, title: string): Promise<void> => {
    setRenaming(undefined)
    if (!title.trim()) return
    await api.sessions.rename(id, title)
    await loadSessions()
  }

  const at = NAV.findIndex((n) => n.id === page)
  return (
    <nav className="sidebar" aria-label={tr("Navigare")}>
      <Resizer
        axis="x"
        label={tr("Lățimea barei laterale")}
        storeKey="jolty.sideWidth"
        cssVar="--side-w"
        host={() => document.querySelector('.app')}
        size={() => document.querySelector('.sidebar')?.getBoundingClientRect().width || 248}
        min={200}
        max={() => Math.min(440, window.innerWidth * 0.3)}
      />
      <button className="btn primary new-chat" onClick={() => void openSession(undefined)}>
        <Plus size={14} strokeWidth={2.5} /> {tr("Conversație nouă")}
      </button>
      <div className="nav">
        {/* one highlight that slides to the page in use */}
        <span className={`nav-glow ${at < 0 ? 'off' : ''}`} style={{ '--i': Math.max(at, 0) } as React.CSSProperties} aria-hidden />
        {NAV.map((n) => (
          <button key={n.id} className={`nav-item ${page === n.id ? 'active' : ''}`} onClick={() => setPage(n.id)}>
            <n.icon size={15} strokeWidth={1.6} /> {n.label}
          </button>
        ))}
      </div>
      <div className="side-head">
        <span className="label">{tr("Conversații")}</span>
        <span className="label">{saved.length}</span>
      </div>
      <div className="search">
        <Search size={13} />
        <input placeholder={tr("Caută conversații")} value={q} onChange={(e) => setQ(e.target.value)} aria-label={tr("Caută conversații")} />
      </div>
      <div className="session-list">
        {groups.length === 0 && <div className="faint small" style={{ padding: '6px 12px' }}>{tr("Nicio conversație încă.")}</div>}
        {groups.map(([cwd, list]) => (
          <div className="session-group" key={cwd}>
            <div className="session-group-title" title={cwd} onContextMenu={(e) => showMenu(e, pathItems(cwd))}>
              {basename(cwd)}
            </div>
            {list.map((s) => {
              const profile = profiles.find((p) => p.id === s.profileId)
              return (
                <div
                  key={s.id}
                  className={`session-item ${page === 'chat' && activeId === s.id ? 'active' : ''}`}
                  onClick={() => void openSession(s.id)}
                  onContextMenu={(e) =>
                    showMenu(e, [
                      { label: tr("Deschide conversația"), icon: MessageSquare, run: () => void openSession(s.id) },
                      { label: tr("Redenumește"), icon: Pencil, run: () => setRenaming(s.id) },
                      copyItem(tr("Copiază titlul"), s.title),
                      'sep',
                      { label: tr("Arată folderul în Explorer"), icon: FolderOpen, run: () => void api.app.revealPath(s.cwd) },
                      copyItem(tr("Copiază calea folderului"), s.cwd, Link),
                      'sep',
                      { label: tr("Scoate din Jolty"), icon: Trash2, run: () => void removeSession(s.id) }
                    ])
                  }
                  role="button"
                  tabIndex={0}
                >
                  <span className={`dot ${status[s.id] === 'running' ? 'running' : ''}`} style={{ background: profile?.color }} />
                  {renaming === s.id ? (
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
                        if (e.key === 'Enter') void rename(s.id, e.currentTarget.value)
                        if (e.key === 'Escape') setRenaming(undefined)
                      }}
                      onBlur={(e) => void rename(s.id, e.currentTarget.value)}
                    />
                  ) : (
                    <span className="title" onDoubleClick={() => setRenaming(s.id)}>{s.title}</span>
                  )}
                  <span className="when">{timeAgo(s.updatedAt)}</span>
                  <button
                    className="del"
                    title={tr("Scoate din Jolty (sesiunea rămâne în Claude Code / Codex)")}
                    onClick={(e) => {
                      e.stopPropagation()
                      void removeSession(s.id)
                    }}
                  >
                    <Trash2 size={13} />
                  </button>
                </div>
              )
            })}
          </div>
        ))}
      </div>
      <UsageMeter />
    </nav>
  )
}
