import { api, useStore, type Page } from './store'

// Jolty on the PC and Jolty on a paired phone are one app: the conversation (or page) open in one is the one that opens in the other.
// The last change wins. A window that applies a change from the other side does not send it back.

const me = Math.random().toString(36).slice(2, 10)
let last = ''
let timer: ReturnType<typeof setTimeout> | undefined

const key = (activeId: string | undefined, page: string | undefined): string => `${activeId ?? ''}|${page ?? ''}`

function show(s: { activeId?: string; page?: string }): void {
  if (!s.page && !s.activeId) return
  const now = useStore.getState()
  if (key(s.activeId, s.page) === key(now.activeId, now.page)) return
  // set first: the store's own change that follows is then not sent back
  last = key(s.activeId, s.page)
  if (s.page && s.page !== 'chat') now.setPage(s.page as Page)
  else if (s.activeId && now.sessions.some((x) => x.id === s.activeId)) void now.openSession(s.activeId).catch(() => undefined)
}

/** Reads what the PC shows and goes there (a phone that just connected or came back). */
async function adopt(): Promise<void> {
  try {
    show(await api.ui.state())
  } catch {
    // an older PC without the channel: the phone just keeps its own view
  }
}

let started = false

export function setupUiSync(): void {
  if (started) return
  started = true
  useStore.subscribe((s) => {
    const now = key(s.activeId, s.page)
    if (now === last) return
    last = now
    clearTimeout(timer)
    // a quick run of changes (opening a page, then a conversation) goes out as the last one
    timer = setTimeout(() => {
      const c = useStore.getState()
      void api.ui.state({ activeId: c.activeId ?? null, page: c.page }, me).catch(() => undefined)
    }, 200)
  })
  window.addEventListener('jolty:ui', (ev) => {
    const e = (ev as CustomEvent<{ activeId?: string; page?: string; from: string }>).detail
    if (e.from !== me) show(e)
  })
  if (document.documentElement.classList.contains('remote')) {
    void adopt()
    window.addEventListener('jolty:resync', () => void adopt())
  }
}
