import { ArrowDownToLine, PanelLeftClose, PanelLeftOpen, RefreshCw } from 'lucide-react'
import { lazy, Suspense, useEffect } from 'react'
import wordmark from './assets/joltarise-wordmark-volt.svg'
import { ChatView, NewChat } from './components/Chat'
import { ContextMenu } from './components/ContextMenu'
import { LivePanel } from './components/LivePanel'
import { Sidebar } from './components/Sidebar'
import { api, useStore } from './store'
import { getLang, isRtl, tr } from '@shared/i18n'

// secondary pages load when first opened: the chat is on screen sooner
const AccountsPage = lazy(() => import('./pages/Accounts').then((m) => ({ default: m.AccountsPage })))
const ImportPage = lazy(() => import('./pages/Import').then((m) => ({ default: m.ImportPage })))
const LocalPage = lazy(() => import('./pages/Local').then((m) => ({ default: m.LocalPage })))
const SettingsPage = lazy(() => import('./pages/Settings').then((m) => ({ default: m.SettingsPage })))
const SystemPage = lazy(() => import('./pages/System').then((m) => ({ default: m.SystemPage })))
const UsagePage = lazy(() => import('./pages/Usage').then((m) => ({ default: m.UsagePage })))

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
  if (update?.state !== 'ready') return null
  return (
    <button className="update-pill" onClick={() => void api.updates.install()} title={tr("Închide Jolty, instalează noua versiune și îl pornește din nou. Conversațiile rămân.")}>
      <RefreshCw size={12} /> {tr("Jolty {version} e gata · Repornește", { version: update.version })}
    </button>
  )
}

/** Dark title bar: brand, sidebar toggle, and room for the native Windows caption buttons. */
function TitleBar() {
  const { sidebarOpen, setSidebarOpen } = useStore()
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
  const { page, sessions, activeId, toasts, sidebarOpen, loadProfiles, loadSessions, loadUsage, onEvent } = useStore()

  useEffect(() => {
    void loadProfiles()
    void loadSessions()
    const off = api.sessions.onEvent(onEvent)
    // limits and 24 h spend for the sidebar meter; events keep them live afterwards
    void loadUsage()
    void api.app.settings().then((s) => document.documentElement.classList.toggle('reduce-motion', Boolean(s.reduceMotion)))
    document.documentElement.lang = getLang()
    document.documentElement.dir = isRtl() ? 'rtl' : 'ltr'
    void api.updates.status().then((status) => onEvent({ type: 'update', status }))
    return off
  }, [loadProfiles, loadSessions, loadUsage, onEvent])

  // Ctrl+N new conversation, Ctrl+K search conversations, Ctrl+B sidebar, Ctrl+L live panel
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey) return
      const k = e.key.toLowerCase()
      const s = useStore.getState()
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
        {isChat && (session ? <ChatView key={session.id} session={session} /> : <NewChat />)}
        <Suspense fallback={null}>
          {page === 'import' && <ImportPage />}
          {page === 'accounts' && <AccountsPage />}
          {page === 'local' && <LocalPage />}
          {page === 'usage' && <UsagePage />}
          {page === 'system' && <SystemPage />}
          {page === 'settings' && <SettingsPage />}
        </Suspense>
      </main>
      {isChat ? <LivePanel session={session} /> : <div />}
      <ContextMenu />
      <div className="toast-stack" role="status" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`toast ${t.error ? 'error' : ''}`}>
            {t.text}
          </div>
        ))}
      </div>
    </div>
  )
}
