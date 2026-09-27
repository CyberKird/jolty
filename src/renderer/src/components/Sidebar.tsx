import { BarChart3, Cpu, Download, KeyRound, Plus, Search, Settings, ShieldCheck, Trash2 } from 'lucide-react'
import { useMemo, useState } from 'react'
import { api, basename, timeAgo, useStore, type Page } from '../store'

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
      <div className="brand">
        <div className="brand-name">
          JOLT<b>Y</b>
        </div>
        <div className="brand-sub">by Joltarise</div>
      </div>
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
    </nav>
  )
}
