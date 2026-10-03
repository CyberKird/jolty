import { BarChart3, Cpu, Download, KeyRound, Plus, RefreshCw, Search, Settings, ShieldCheck, Trash2 } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { api, basename, fmtTokens, fmtUsd, levelColor, refreshLimitsSoon, resetIn, timeAgo, useStore, type Page } from '../store'

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
    <section className="meter" aria-label="Consum live">
      <div className="meter-head">
        <span className={`dot ${running ? 'running' : ''}`} style={{ background: running ? 'var(--volt)' : 'var(--grey-2)' }} />
        <span className="label">Consum live</span>
        <button
          className="meter-refresh"
          title="Actualizează limitele acum"
          onClick={() => {
            for (const p of profiles) refreshLimitsSoon(p, true)
            void loadUsage()
          }}
        >
          <RefreshCw size={12} />
        </button>
      </div>
      <div className="meter-list">
        {rows.length === 0 && <div className="faint small meter-empty">Nimic folosit în ultimele 24 h.</div>}
        {rows.map((p) => {
          const s = spend[p.id]
          return (
            <button key={p.id} className="meter-row" onClick={() => setPage('usage')} title="Deschide Consum">
            <span className="meter-name">
              <span className="dot" style={{ width: 6, height: 6, background: p.color }} />
              <span className="ellipsis">{p.name}</span>
              {s?.tokens ? (
                <span className="meter-24h" title="Ultimele 24 de ore">
                  {fmtTokens(s.tokens)}
                  {s.costUsd ? ` · ${fmtUsd(s.costUsd)}` : ''}
                </span>
              ) : null}
            </span>
            {balances[p.id] && (
              <span className="meter-balance" title={`Actualizat ${timeAgo(balances[p.id].updatedAt)}`}>
                {balances[p.id].amount !== undefined ? (
                  <>
                    <span className="meter-limit-label">Rămas</span>
                    <b className={balances[p.id].amount! <= 1 ? 'low' : ''}>{money(balances[p.id].amount!, balances[p.id].currency)}</b>
                  </>
                ) : null}
                {balances[p.id].note && <span className="faint">{balances[p.id].note}</span>}
              </span>
            )}
            {limits[p.id]?.windows.slice(0, 2).map((w) => (
              <span className="meter-limit" key={w.label} title={`${w.label}: ${Math.round(w.usedPercent)}% folosit, ${resetIn(w.resetsAt)}`}>
                <span className="meter-limit-label">{w.label}</span>
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
  { id: 'import', label: 'Importă sesiuni', icon: Download },
  { id: 'accounts', label: 'Conturi și chei', icon: KeyRound },
  { id: 'local', label: 'Modele locale', icon: Cpu },
  { id: 'usage', label: 'Consum', icon: BarChart3 },
  { id: 'system', label: 'Verificare sistem', icon: ShieldCheck },
  { id: 'settings', label: 'Setări', icon: Settings }
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

  return (
    <nav className="sidebar" aria-label="Navigare">
      <button className="btn primary new-chat" onClick={() => void openSession(undefined)}>
        <Plus size={14} strokeWidth={2.5} /> Conversație nouă
      </button>
      <div className="nav">
        {NAV.map((n) => (
          <button key={n.id} className={`nav-item ${page === n.id ? 'active' : ''}`} onClick={() => setPage(n.id)}>
            <n.icon size={15} strokeWidth={1.6} /> {n.label}
          </button>
        ))}
      </div>
      <div className="side-head">
        <span className="label">Conversații</span>
        <span className="label">{sessions.length}</span>
      </div>
      <div className="search">
        <Search size={13} />
        <input placeholder="Caută" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Caută conversații" />
      </div>
      <div className="session-list">
        {groups.length === 0 && <div className="faint small" style={{ padding: '6px 12px' }}>Nicio conversație încă.</div>}
        {groups.map(([cwd, list]) => (
          <div className="session-group" key={cwd}>
            <div className="session-group-title" title={cwd}>
              {basename(cwd)}
            </div>
            {list.map((s) => {
              const profile = profiles.find((p) => p.id === s.profileId)
              return (
                <div key={s.id} className={`session-item ${page === 'chat' && activeId === s.id ? 'active' : ''}`} onClick={() => void openSession(s.id)} role="button" tabIndex={0}>
                  <span className={`dot ${status[s.id] === 'running' ? 'running' : ''}`} style={{ background: profile?.color }} />
                  <span className="title">{s.title}</span>
                  <span className="when">{timeAgo(s.updatedAt)}</span>
                  <button
                    className="del"
                    title="Scoate din Jolty (sesiunea rămâne în Claude Code / Codex)"
                    onClick={async (e) => {
                      e.stopPropagation()
                      await api.sessions.remove(s.id)
                      if (activeId === s.id) await openSession(undefined)
                      await loadSessions()
                      toast('Conversația a fost scoasă din Jolty')
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
