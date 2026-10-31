import { ArrowDownToLine, PanelLeftClose, PanelLeftOpen, RefreshCw } from 'lucide-react'
import { lazy, Suspense, useEffect, useState } from 'react'
import { ChatView, NewChat } from './components/Chat'
import wordmark from './assets/joltarise-wordmark-volt.svg'
import { ContextMenu } from './components/ContextMenu'
import { LivePanel } from './components/LivePanel'
import { WhatsNewHost } from './components/WhatsNew'
import { ShortcutsHost } from './components/Shortcuts'
import { Welcome } from './components/Welcome'
import { PowerBar } from './components/PowerBar'
import { Sidebar } from './components/Sidebar'
import { api, liveRows, useStore } from './store'
import { batchDeltas } from './event-batch'
import { lowPower, setLowPowerMode } from './lowpower'
import { applyTheme } from './theme'
import { getLang, isRtl, tr } from '@shared/i18n'
import { useShallow } from 'zustand/shallow'

// secondary pages load when first opened: the chat is on screen sooner
const AccountsPage = lazy(() => import('./pages/Accounts').then((m) => ({ default: m.AccountsPage })))
const ImportPage = lazy(() => import('./pages/Import').then((m) => ({ default: m.ImportPage })))
const LocalPage = lazy(() => import('./pages/Local').then((m) => ({ default: m.LocalPage })))
const SettingsPage = lazy(() => import('./pages/Settings').then((m) => ({ default: m.SettingsPage })))
const SystemPage = lazy(() => import('./pages/System').then((m) => ({ default: m.SystemPage })))
const UsagePage = lazy(() => import('./pages/Usage').then((m) => ({ default: m.UsagePage })))
const SkillsPage = lazy(() => import('./pages/Skills').then((m) => ({ default: m.SkillsPage })))
// the mascot (and three.js with it) is not needed for the first frame: it starts once the window is idle
const Mascot = lazy(() => import('./mascot/Mascot').then((m) => ({ default: m.Mascot })))
const SchedulesPage = lazy(() => import('./pages/Schedules').then((m) => ({ default: m.SchedulesPage })))

/** The Joltarise bolt, drawn from the brand symbol's polygon. */
export function Bolt({ size = 16 }: { size?: number }) {
  return (
    <svg className="bolt" width={(size * 205) / 740} height={size} viewBox="0 0 205 740" aria-hidden>
      <polygon points="52,0 170,0 118,300 205,284 56,740 84,408 0,426" />
    </svg>
  )
}

/** "Restart to update" in the title bar once a new version is downloaded, like the Claude app. */
function UpdatePill() {
  const update = useStore((s) => s.update)
  if (update?.state === 'downloading')
    return (
      <span className="update-pill quiet" title={tr("Descarc Jolty {v0} în fundal", { v0: update.version || '' })}>
        <ArrowDownToLine size={12} /> {tr("Actualizare")} {update.percent ?? 0}%
      </span>
    )
  if (update?.state === 'available')
    return (
      <button className="update-pill" onClick={() => void api.updates.install()} title={tr("Descarcă Jolty {version}, îl instalează și îl pornește din nou. Conversațiile rămân.", { version: update.version || '' })}>
        <ArrowDownToLine size={12} /> {tr("Jolty {version} e disponibil · Actualizează", { version: update.version || '' })}
      </button>
    )
  if (update?.state !== 'ready') return null
  return (
    <button className="update-pill" onClick={() => void api.updates.install()} title={tr("Închide Jolty, instalează noua versiune și îl pornește din nou. Conversațiile rămân.")}>
      <RefreshCw size={12} /> {tr("Jolty {version} e gata · Repornește", { version: update.version })}
    </button>
  )
}

/** Dark title bar: brand, sidebar toggle, and room for the native Windows caption buttons. */
function TitleBar() {
  const { sidebarOpen, setSidebarOpen } = useStore(useShallow(({ sidebarOpen, setSidebarOpen }) => ({ sidebarOpen, setSidebarOpen })))
  return (
    <header className="titlebar">
      <button className="titlebar-btn" onClick={() => setSidebarOpen(!sidebarOpen)} title={sidebarOpen ? tr("Ascunde bara laterală (Ctrl+B)") : tr("Arată bara laterală (Ctrl+B)")} aria-label={sidebarOpen ? tr("Ascunde bara laterală") : tr("Arată bara laterală")}>
        {sidebarOpen ? <PanelLeftClose size={15} strokeWidth={1.6} /> : <PanelLeftOpen size={15} strokeWidth={1.6} />}
      </button>
      <div className="titlebar-brand">
        <Bolt size={17} />
        <span className="brand-name">
         JOLT<b>Y</b>
        </span>
        <span className="titlebar-by">by</span>
        <img className="titlebar-wordmark" src={wordmark} alt="Joltarise" draggable={false} />
      </div>
      <div className="titlebar-spacer" />
      <UpdatePill />
    </header>
  )
}

export function App() {
  const [idle, setIdle] = useState(false)
  const newUser = useStore((s) => s.profilesLoaded && s.profiles.length === 0)
  const { page, sessions, activeId, toasts, sidebarOpen, liveOpen, setLiveOpen, loadProfiles, loadSessions, loadUsage, onEvent } = useStore(useShallow(({ page, sessions, activeId, toasts, sidebarOpen, liveOpen, setLiveOpen, loadProfiles, loadSessions, loadUsage, onEvent }) => ({ page, sessions, activeId, toasts, sidebarOpen, liveOpen, setLiveOpen, loadProfiles, loadSessions, loadUsage, onEvent })))

  useEffect(() => {
    const ric = window.requestIdleCallback ?? ((cb: () => void) => window.setTimeout(cb, 300))
    const id = ric(() => setIdle(true), { timeout: 1500 })
    return () => (window.cancelIdleCallback ? window.cancelIdleCallback(id) : clearTimeout(id))
  }, [])

  // Below 1180 px (with the sidebar shown) the live panel is a drawer over the chat. Making the window
  // that narrow closes it, so it never lands on top of the conversation; widening it again brings it back.
  useEffect(() => {
    const narrow = window.matchMedia('(max-width: 1180px)')
    let closedBySize = false
    const onChange = (): void => {
      const s = useStore.getState()
      if (narrow.matches && s.sidebarOpen && s.liveOpen) {
        closedBySize = true
        s.setLiveOpen(false)
      } else if (!narrow.matches && closedBySize) {
        closedBySize = false
        s.setLiveOpen(true)
      }
    }
    narrow.addEventListener('change', onChange)
    return () => narrow.removeEventListener('change', onChange)
  }, [])

  useEffect(() => {
    void loadProfiles()
    void loadSessions()
    const off = api.sessions.onEvent(batchDeltas(onEvent, () => (lowPower() ? 120 : 40)))
    // limits and 24 h spend for the sidebar meter; events keep them live afterwards
    void loadUsage()
    void api.app.settings().then((s) => {
      document.documentElement.classList.toggle('reduce-motion', Boolean(s.reduceMotion))
      setLowPowerMode(s.lowPower)
      applyTheme(s.theme, s.glassClear)
    })
    document.documentElement.lang = getLang()
    document.documentElement.dir = isRtl() ? 'rtl' : 'ltr'
    void api.updates.status().then((status) => onEvent({ type: 'update', status }))
    void api.power.state().then((p) => onEvent({ type: 'power', ...p }))
    return off
  }, [loadProfiles, loadSessions, loadUsage, onEvent])

  // Ctrl+N new conversation, Ctrl+K search conversations, Ctrl+B sidebar, Ctrl+L live panel
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const s = useStore.getState()
      // Alt+1..9: the Nth conversation of the Live list
      if (e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey && /^[1-9]$/.test(e.key)) {
        const row = liveRows(s)[Number(e.key) - 1]
        if (row) {
          e.preventDefault()
          void s.openSession(row.session.id)
        }
        return
      }
      if (!(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey) return
      const k = e.key.toLowerCase()
      if (k === 'n') void s.openSession(undefined)
      else if (k === 'k') {
        if (!s.sidebarOpen) s.setSidebarOpen(true)
        requestAnimationFrame(() => document.querySelector<HTMLInputElement>('.search input')?.focus())
      } else if (k === 'b') s.setSidebarOpen(!s.sidebarOpen)
      else if (k === 'l') s.setLiveOpen(!s.liveOpen)
      else return
      e.preventDefault()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const session = sessions.find((s) => s.id === activeId)
  const isChat = page === 'chat'
  return (
    <div className={`app ${sidebarOpen ? '' : 'no-sidebar'}`}>
      <TitleBar />
      <Sidebar />
      <main className="main">
        {isChat && (session ? <ChatView key={session.id} session={session} /> : newUser ? <Welcome /> : <NewChat />)}
        <Suspense fallback={null}>
          {page === 'import' && <ImportPage />}
          {page === 'accounts' && <AccountsPage />}
          {page === 'local' && <LocalPage />}
          {page === 'usage' && <UsagePage />}
          {page === 'schedules' && <SchedulesPage />}
          {page === 'skills' && <SkillsPage />}
          {page === 'system' && <SystemPage />}
          {page === 'settings' && <SettingsPage />}
        </Suspense>
      </main>
      {isChat ? <LivePanel session={session} /> : <div />}
      {/* shown only while the live panel is a drawer (CSS): dims the chat, a click closes the drawer */}
      {isChat && <div className="live-scrim" data-state={liveOpen ? 'open' : 'closed'} onClick={() => setLiveOpen(false)} aria-hidden />}
      <ContextMenu />
      <PowerBar />
      {idle && (
        <Suspense fallback={null}>
          <Mascot />
        </Suspense>
      )}
      <WhatsNewHost />
      <ShortcutsHost />
      <div className="toast-stack" role="status" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`toast ${t.error ? 'error' : ''}`} data-state={t.closing ? 'closed' : 'open'}>
            {t.text}
            {t.action && (
              <button
                className="toast-action"
                onClick={() => {
                  t.action!.run()
                  useStore.getState().dismissToast(t.id)
                }}
              >
                {t.action.label}
              </button>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}
