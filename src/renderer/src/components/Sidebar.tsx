import { BarChart3, Cpu, Download, FolderOpen, KeyRound, Link, MessageSquare, Plus, RefreshCw, Search, Settings, ShieldCheck, Trash2 } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { api, basename, fmtTokens, fmtUsd, levelColor, refreshLimitsSoon, resetIn, timeAgo, useStore, type Page } from '../store'
import { copyItem, pathItems, showMenu } from './ContextMenu'
import { tr } from '@shared/i18n'

function money(n: number, currency = 'USD'): string {
  const v = n.toFixed(2)
  return currency === 'USD' ? `$${v}` : `${v} ${currency}`
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
  return (
    <section className="meter" aria-label={tr("Consum live")}>
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
            <button key={p.id} className="meter-row" onClick={() => setPage('usage')} title={tr("Deschide Consum")}>
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
