import { useEffect } from 'react'
import { ChatView, NewChat } from './components/Chat'
import { LivePanel } from './components/LivePanel'
import { Sidebar } from './components/Sidebar'
import { AccountsPage } from './pages/Accounts'
import { ImportPage } from './pages/Import'
import { LocalPage } from './pages/Local'
import { SettingsPage } from './pages/Settings'
import { SystemPage } from './pages/System'
import { UsagePage } from './pages/Usage'
import { api, useStore } from './store'

export function App() {
  const { page, sessions, activeId, toasts, loadProfiles, loadSessions, onEvent } = useStore()

  useEffect(() => {
    void loadProfiles()
    void loadSessions()
    const off = api.sessions.onEvent(onEvent)
    // refresh the limits shown in the header when the app opens
    void api.usage.summary().then((list) => {
      for (const u of list) if (u.limits) onEvent({ type: 'limits', snapshot: u.limits })
    })
    return off
  }, [loadProfiles, loadSessions, onEvent])

  const session = sessions.find((s) => s.id === activeId)
  const isChat = page === 'chat'
  return (
    <div className="app">
      <Sidebar />
      <main className="main">
        {isChat && (session ? <ChatView key={session.id} session={session} /> : <NewChat />)}
        {page === 'import' && <ImportPage />}
        {page === 'accounts' && <AccountsPage />}
        {page === 'local' && <LocalPage />}
        {page === 'usage' && <UsagePage />}
        {page === 'system' && <SystemPage />}
        {page === 'settings' && <SettingsPage />}
      </main>
      {isChat ? <LivePanel session={session} /> : <div />}
      <div className="toast-stack">
        {toasts.map((t) => (
          <div key={t.id} className={`toast ${t.error ? 'error' : ''}`}>
            {t.text}
          </div>
        ))}
      </div>
    </div>
  )
}
