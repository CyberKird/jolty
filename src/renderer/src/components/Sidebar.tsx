import { BarChart3, Cpu, Download, FolderOpen, KeyRound, Link, MessageSquare, Plus, RefreshCw, Search, Settings, ShieldCheck, Trash2 } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { api, basename, fmtTokens, fmtUsd, levelColor, refreshLimitsSoon, resetIn, timeAgo, useStore, type Page } from '../store'
import { copyItem, pathItems, showMenu } from './ContextMenu'
import { tr } from '@shared/i18n'

function money(n: number, currency = 'USD'): string {
  const v = n.toFixed(2)
  return currency === 'USD' ? `$${v}` : `${v} ${currency}`
}

/** Always-visible meter: each account's 5 h / 7 d limits and its last 24 h, updated as turns finish. */
function UsageMeter() {
  const { profiles, limits, spend, balances, status, setPage, loadUsage } = useStore()
  const running = Object.values(status).some((s) => s === 'running')
  useEffect(() => {
    for (const p of profiles) refreshLimitsSoon(p)
  }, [profiles])
  // a profile with empty windows but a note (rate-limited probe) stays visible so the row does not vanish
  const rows = profiles.filter((p) => limits[p.id]?.windows.length || limits[p.id]?.note || spend[p.id]?.tokens || balances[p.id])
  return (
    <section className="meter" aria-label={tr("Consum live")}>
      <div className="meter-head">
        <span className={`dot ${running ? 'running' : ''}`} style={{ background: running ? 'var(--volt)' : 'var(--grey-2)' }} />
        <span className="label">{tr("Consum live")}</span>
        <button
          className="meter-refresh"
          title={tr("Actualizează limitele acum")}
          onClick={() => {
            for (const p of profiles) refreshLimitsSoon(p, true)
            void loadUsage()
          }}
        >
          <RefreshCw size={12} />
        </button>
      </div>
      <div className="meter-list">
        {rows.length === 0 && <div className="faint small meter-empty">{tr("Nimic folosit în ultimele 24 h.")}</div>}
        {rows.map((p) => {
          const s = spend[p.id]
          return (
            <button key={p.id} className="meter-row" onClick={() => setPage('usage')} title={tr("Deschide Consum")}>
            <span className="meter-name">
              <span className="dot" style={{ width: 6, height: 6, background: p.color }} />
              <span className="ellipsis">{p.name}</span>
              {s?.tokens ? (
                <span className="meter-24h" title={tr("Ultimele 24 de ore")}>
                  {fmtTokens(s.tokens)}
                  {s.costUsd ? ` · ${fmtUsd(s.costUsd)}` : ''}
                </span>
              ) : null}
            </span>
            {balances[p.id] && (
              <span className="meter-balance" title={tr("Actualizat {timeAgo}", { timeAgo: timeAgo(balances[p.id].updatedAt) })}>
                {balances[p.id].amount !== undefined ? (
                  <>
                    <span className="meter-limit-label">{tr("Rămas")}</span>
                    <b className={balances[p.id].amount! <= 1 ? 'low' : ''}>{money(balances[p.id].amount!, balances[p.id].currency)}</b>
                  </>
                ) : null}
                {balances[p.id].note && <span className="faint">{balances[p.id].note}</span>}
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
  { id: 'system', label: tr("Verificare sistem"), icon: ShieldCheck },
  { id: 'settings', label: tr("Setări"), icon: Settings }
]

export function Sidebar() {
  const { page, setPage, sessions, profiles, activeId, openSession, status, loadSessions, toast } = useStore()
  const [q, setQ] = useState('')
  const groups = useMemo(() => {
    const filtered = sessions.filter((s) => !q || s.title.toLowerCase().includes(q.toLowerCase()) || s.cwd.toLowerCase().includes(q.toLowerCase()))
    const map = new Map<string, typeof filtered>()
    for (const s of filtered) map.set(s.cwd, [...(map.get(s.cwd) || []), s])
    return [...map.entries()]
  }, [sessions, q])

  const removeSession = async (id: string): Promise<void> => {
    await api.sessions.remove(id)
    if (activeId === id) await openSession(undefined)
    await loadSessions()
    toast(tr("Conversația a fost scoasă din Jolty"))
  }

  return (
    <nav className="sidebar" aria-label={tr("Navigare")}>
      <button className="btn primary new-chat" onClick={() => void openSession(undefined)}>
        <Plus size={14} strokeWidth={2.5} /> {tr("Conversație nouă")}
      </button>
      <div className="nav">
        {NAV.map((n) => (
          <button key={n.id} className={`nav-item ${page === n.id ? 'active' : ''}`} onClick={() => setPage(n.id)}>
            <n.icon size={15} strokeWidth={1.6} /> {n.label}
          </button>
        ))}
      </div>
      <div className="side-head">
        <span className="label">{tr("Conversații")}</span>
        <span className="label">{sessions.length}</span>
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
                  <span className="title">{s.title}</span>
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
