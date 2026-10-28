import { Loader2, MessageSquareDashed, BarChart3, CalendarClock, Cpu, Download, FolderOpen, GitBranch, KeyRound, Link, MessageSquare, Pencil, Plus, Puzzle, RefreshCw, Search, Settings, ShieldCheck, Trash2 } from 'lucide-react'
import { BugReportButton } from './BugReport'
import { useEffect, useMemo, useState } from 'react'
import { api, basename, fmtTokens, fmtUsd, levelColor, refreshLimitsSoon, resetIn, timeAgo, useStore, type Page } from '../store'
import { dragShield } from '../dragShield'
import { copyItem, pathItems, showMenu } from './ContextMenu'
import { MOVE_HINT, useProfileDrag } from '../pages/Accounts'
import { LiveList } from './LiveList'
import { tr } from '@shared/i18n'
import { needsAttention } from '@shared/skills'
import { useShallow } from 'zustand/shallow'

function money(n: number, currency = 'USD'): string {
  const v = n.toFixed(2)
  return currency === 'USD' ? `$${v}` : `${v} ${currency}`
}

/**
 * Drag handle for the sidebar's width and for the split between conversations and live usage.
 * While dragging the size goes straight to a CSS variable (no React render per move); it is remembered,
 * and a double click returns to the default.
 */
function Resizer({ axis, label, storeKey, cssVar, host, size, min, max, preview }: {
  axis: 'x' | 'y'
  label: string
  storeKey: string
  cssVar: string
  host: () => HTMLElement | null
  size: () => number
  min: number
  max: () => number
  /** Moves the layout directly while dragging (null = clear). A variable on a high element makes the browser
   *  restyle everything under it on every move; the variable is then set once, on release. */
  preview?: (v: number | null) => void
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
    root.classList.add('resizing')
    const unshield = dragShield(axis === 'x' ? 'col-resize' : 'row-resize')
    const move = (ev: PointerEvent): void => {
      // the width grows toward the chat; the usage list grows upward
      const d = axis === 'x' ? (ev.clientX - x0) * flip : y0 - ev.clientY
      v = Math.round(Math.max(min, Math.min(top, from + d)))
      if (preview) preview(v)
      else host()?.style.setProperty(cssVar, `${v}px`)
    }
    const up = (): void => {
      root.classList.remove('resizing')
      unshield()
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      window.removeEventListener('pointercancel', up)
      if (preview) {
        host()?.style.setProperty(cssVar, `${v}px`)
        preview(null)
      }
      save(v)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    window.addEventListener('pointercancel', up)
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

/** Gemini reports no limits and no real token counts: the row shows only what was recorded locally (a rough estimate per turn). */
function geminiFigures(x?: { tokens: number; turns: number }): string {
  const n = x?.turns || 0
  return `${n} ${n === 1 ? tr("mesaj") : tr("mesaje")}${x?.tokens ? ` · ~${fmtTokens(x.tokens)}` : ''}`
}

function isMiMoProfile(p: { auth: string; baseUrl?: string }): boolean {
  return p.auth === 'endpoint' && /^https:\/\/(?:api|token-plan-cn)\.xiaomimimo\.com(?:[:/]|$)/i.test(p.baseUrl || '')
}

/** Always-visible meter: each account's 5 h / 7 d limits and its last 24 h, updated as turns finish. */
function UsageMeter() {
  const { profiles, limits, spend, spend7d, balances, status, sessions, setPage, loadUsage, loadSessions, toast } = useStore()
  const running = Object.values(status).some((s) => s === 'running')
  const [refreshing, setRefreshing] = useState(false)
  useEffect(() => {
    const probe = (): void => {
      if (!document.hidden) for (const p of profiles) void refreshLimitsSoon(p)
    }
    probe()
    // live without the refresh button: every minute while visible, and at once when the window comes back (refreshLimitsSoon throttles per account)
    const timer = setInterval(probe, 65e3)
    document.addEventListener('visibilitychange', probe)
    window.addEventListener('focus', probe)
    return () => {
      clearInterval(timer)
      document.removeEventListener('visibilitychange', probe)
      window.removeEventListener('focus', probe)
    }
  }, [profiles])
  // a profile with empty windows but a note (rate-limited probe) stays visible so the row does not vanish
  // OpenCode publishes no limits, so its row stays like Gemini's; Hermes is listed as soon as one of its chats works
  const working = new Set(sessions.filter((x) => status[x.id] === 'running').map((x) => x.profileId))
  const rows = profiles.filter((p) => isMiMoProfile(p) || p.engine === 'gemini' || p.engine === 'opencode' || limits[p.id]?.windows.length || limits[p.id]?.note || spend[p.id]?.tokens || balances[p.id] || working.has(p.id))
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
          const isGemini = p.engine === 'gemini'
          const isOpencode = p.engine === 'opencode'
          const balance = balances[p.id]
          return (
            <button key={p.id} className="meter-row" onClick={() => setPage('usage')} title={`${tr("Deschide Consum")}\n${MOVE_HINT}`} {...dragProps(p.id)}>
            <span className="meter-name">
              <span className={`dot ${working.has(p.id) ? 'running' : ''}`} style={{ width: 6, height: 6, background: p.color }} />
              <span className="ellipsis">{p.name}</span>
              {working.has(p.id) && !s?.tokens && !limits[p.id]?.windows.length && <span className="meter-24h">{tr("lucrează")}</span>}
              {!isMiMo && !isGemini && !isOpencode && s?.tokens ? (
                <span className="meter-24h" title={tr("Ultimele 24 de ore")}>
                  {fmtTokens(s.tokens)}
                  {s.costUsd ? ` · ${fmtUsd(s.costUsd)}` : ''}
                </span>
              ) : null}
            </span>
            {(isMiMo || isOpencode) && (
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
            {isGemini && (
              <>
                <span className="meter-balance" title={`${tr("Ultimele 24 de ore")}\n${tr("Tokeni estimați: Gemini nu îi raportează.")}`}>
                  <span className="meter-limit-label">24h</span>
                  <b>{geminiFigures(s)}</b>
                </span>
                <span className="meter-balance" title={`${tr("Ultimele 7 zile")}\n${tr("Tokeni estimați: Gemini nu îi raportează.")}`}>
                  <span className="meter-limit-label">7d</span>
                  <b>{geminiFigures(spend7d[p.id])}</b>
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
            {isGemini && !limits[p.id]?.windows.length && !limits[p.id]?.note && <span className="faint small">{tr("Google nu publică limitele Gemini.")}</span>}
            </button>
          )
        })}
      </div>
    </section>
  )
}

/** The connected backup account under live usage, like the account in the Claude and Codex apps; opens Settings on the Account tab. */
function AccountChip() {
  const backups = useStore((s) => s.backups)
  const setBackups = useStore((s) => s.setBackups)
  const setPage = useStore((s) => s.setPage)
  useEffect(() => {
    void api.backup.list().then(setBackups).catch(() => undefined)
  }, [setBackups])
  if (!backups) return null
  const connected = backups.filter((b) => b.status.connected)
  const first = connected[0]?.status
  const name = first ? first.name || first.label || '' : ''
  return (
    <button
      className="account-chip"
      title={tr("Deschide Cont")}
      onClick={() => {
        try {
          localStorage.setItem('jolty.settingsTab', 'account')
        } catch {
          // the tab is only a convenience
        }
        setPage('settings')
      }}
    >
      <span className={`account-avatar ${first ? '' : 'off'}`}>{first ? (name[0] || 'J').toUpperCase() : '+'}</span>
      <span className="account-text">
        <span className="ellipsis">{first ? name : tr("Conectează un cont pentru backup")}</span>
        {first && <span className="faint small ellipsis">{connected.length > 1 ? tr("{provider} și încă {n}", { provider: connected[0].info.name, n: connected.length - 1 }) : connected[0].info.name}</span>}
      </span>
    </button>
  )
}

const NAV: { id: Page; label: string; icon: typeof Plus }[] = [
  { id: 'import', label: tr("Importă sesiuni"), icon: Download },
  { id: 'accounts', label: tr("Conturi și chei"), icon: KeyRound },
  { id: 'local', label: tr("Modele locale"), icon: Cpu },
  { id: 'usage', label: tr("Consum"), icon: BarChart3 },
  { id: 'schedules', label: tr("Programate"), icon: CalendarClock },
  { id: 'skills', label: tr("Skilluri"), icon: Puzzle },
  { id: 'system', label: tr("Verificare sistem"), icon: ShieldCheck },
  { id: 'settings', label: tr("Setări"), icon: Settings }
]

/** A list the user reorders by dragging (or Alt+Up/Down), remembered under `storeKey`; ids not seen before go last, in their natural order. */
function useOrder(storeKey: string, natural: string[]): [string[], (from: string, to: string) => void] {
  const [saved, setSaved] = useState<string[]>(() => {
    try {
      const v: unknown = JSON.parse(localStorage.getItem(storeKey) || '[]')
      return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
    } catch {
      return []
    }
  })
  const rank = new Map(saved.map((id, i) => [id, i]))
  const ordered = [...natural].sort((a, b) => (rank.get(a) ?? Infinity) - (rank.get(b) ?? Infinity))
  const move = (from: string, to: string): void => {
    const list = [...ordered]
    const i = list.indexOf(from)
    const j = list.indexOf(to)
    if (i < 0 || j < 0 || i === j) return
    list.splice(j, 0, list.splice(i, 1)[0])
    // ids hidden by a search keep their old place after the visible ones
    const next = [...list, ...saved.filter((id) => !list.includes(id))]
    setSaved(next)
    try {
      localStorage.setItem(storeKey, JSON.stringify(next))
    } catch {
      // remembering the order is a convenience only
    }
  }
  return [ordered, move]
}

export function Sidebar() {
  const { page, setPage, sessions, profiles, activeId, openSession, status, loadSessions, toast } = useStore(useShallow(({ page, setPage, sessions, profiles, activeId, openSession, status, loadSessions, toast }) => ({ page, setPage, sessions, profiles, activeId, openSession, status, loadSessions, toast })))
  const compactions = useStore((s) => s.compactions)
  const [q, setQ] = useState('')
  const [renaming, setRenaming] = useState<string>()
  const skillsAttention = useStore((s) => s.skillsAttention)
  // the badge is there before the Skills page is ever opened; that page keeps it current afterwards
  useEffect(() => {
    void api.skills
      .list()
      .then((l) => useStore.getState().setSkillsAttention(l.filter((s) => needsAttention(s, useStore.getState().hiddenSkills)).length))
      .catch(() => undefined)
  }, [])
  // temporary chats are listed too (marked); they live in memory only and are wiped when deleted or when Jolty closes
  const saved = sessions
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

  const [navIds, moveNav] = useOrder('jolty.navOrder', NAV.map((n) => n.id))
  const nav = navIds.map((id) => NAV.find((n) => n.id === id)!)
  const navDrag = useProfileDrag(navIds, moveNav)
  const [groupIds, moveGroup] = useOrder('jolty.groupOrder', groups.map(([cwd]) => cwd))
  const groupDrag = useProfileDrag(groupIds, moveGroup)
  const orderedGroups = groupIds.map((cwd) => groups.find(([c]) => c === cwd)!)
  const at = nav.findIndex((n) => n.id === page)
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
        preview={(v) => {
          const app = document.querySelector<HTMLElement>('.app')
          const side = document.querySelector<HTMLElement>('.sidebar')
          const live = document.querySelector<HTMLElement>('.live')
          if (!app || !side) return
          app.style.gridTemplateColumns = v == null ? '' : `${v}px minmax(0, 1fr) auto`
          side.style.width = v == null ? '' : `${v}px`
          // keeps the Live panel's cap (transitions.css) in step with the column
          if (live && window.innerWidth > 1180) live.style.maxWidth = v == null ? '' : `max(300px, calc(100vw - ${v}px - 480px))`
        }}
      />
      <button className="btn primary new-chat" onClick={() => void openSession(undefined)}>
        <Plus size={14} strokeWidth={2.5} /> {tr("Conversație nouă")}
      </button>
      <div className="nav">
        {/* one highlight that slides to the page in use */}
        <span className={`nav-glow ${at < 0 ? 'off' : ''}`} style={{ '--i': Math.max(at, 0) } as React.CSSProperties} aria-hidden />
        {nav.map((n) => (
          <button key={n.id} className={`nav-item ${page === n.id ? 'active' : ''}`} onClick={() => setPage(n.id)} title={MOVE_HINT} {...navDrag(n.id)}>
            <n.icon size={15} strokeWidth={1.6} /> {n.label}
            {n.id === 'skills' && skillsAttention ? (
              <span className="count nav-alert" title={tr("{n} skilluri cer atenție", { n: skillsAttention })}>
                {skillsAttention}
              </span>
            ) : null}
          </button>
        ))}
      </div>
      <LiveList />
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
        {orderedGroups.map(([cwd, list]) => (
          <div className="session-group" key={cwd}>
            <div className="session-group-title" title={`${cwd}\n${MOVE_HINT}`} tabIndex={0} onContextMenu={(e) => showMenu(e, pathItems(cwd))} {...groupDrag(cwd)}>
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
                      ...(s.worktree ? [copyItem(tr("Copiază numele branch-ului"), s.worktree.branch, GitBranch)] : []),
                      'sep',
                      { label: tr("Scoate din Jolty"), icon: Trash2, run: () => void removeSession(s.id) }
                    ])
                  }
                  role="button"
                  tabIndex={0}
                >
                  <span className={`dot ${status[s.id] === 'running' ? 'running' : ''}`} style={{ background: profile?.color }} />
                  {compactions[s.id]?.active && <Loader2 size={11} className="spin compact-dot" aria-label={tr("Compactez conversația...")} />}
                  {s.worktree && <GitBranch size={11} className="live-branch" aria-label={s.worktree.branch} />}
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
                    <span className="title" onDoubleClick={() => setRenaming(s.id)}>
                      {s.temporary && <MessageSquareDashed size={11} className="temp-mark" aria-label={tr("Temporar")} />}
                      {s.title}
                    </span>
                  )}
                  <span className="when">{timeAgo(s.updatedAt)}</span>
                  <button
                    className="del"
                    title={s.temporary ? tr("Șterge conversația temporară (nu se salvează nimic din ea)") : tr("Scoate din Jolty (sesiunea rămâne în Claude Code / Codex)")}
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
      <div className="account-row">
        <AccountChip />
        <BugReportButton />
      </div>
    </nav>
  )
}
