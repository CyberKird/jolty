import { create } from 'zustand'
import { tick, type Clock } from '@shared/eta'
import type {
  ChatEvent,
  ChatItem,
  JoltyApi,
  PermissionRequest,
  PlanStep,
  Profile,
  ProviderBalance,
  RateLimitSnapshot,
  UpdateStatus,
  SessionMeta
} from '@shared/types'
import { dateLocale, tr } from '@shared/i18n'

export const api = (window as unknown as { jolty: JoltyApi }).jolty

export type Page = 'chat' | 'import' | 'accounts' | 'local' | 'usage' | 'system' | 'settings'

export interface Draft {
  toolId: string
  name: string
  path?: string
  content: string
  done: boolean
  at: number
}

export interface PullState {
  status: string
  completed?: number
  total?: number
  done?: boolean
  error?: string
}

interface Toast {
  id: number
  text: string
  error?: boolean
}

interface State {
  page: Page
  profiles: Profile[]
  sessions: SessionMeta[]
  activeId?: string
  transcripts: Record<string, ChatItem[]>
  status: Record<string, 'idle' | 'running' | 'error'>
  permissions: Record<string, PermissionRequest[]>
  drafts: Record<string, Record<string, Draft>>
  plans: Record<string, PlanStep[]>
  /** when the current turn started, and when its task list started and last ticked a step off */
  clocks: Record<string, Clock>
  browserLive: { frame?: string; url?: string; title?: string; note?: string }
  /** text the next message replies to, per conversation */
  quotes: Record<string, string>
  setQuote(sessionId: string, text: string | undefined): void
  limits: Record<string, RateLimitSnapshot>
  /** tokens and cost per profile over the last 24 h, kept live from usage events */
  spend: Record<string, { tokens: number; costUsd: number }>
  balances: Record<string, ProviderBalance>
  contexts: Record<string, { used: number; window?: number }>
  update?: UpdateStatus
  pulls: Record<string, PullState>
  toasts: Toast[]
  liveOpen: boolean
  sidebarOpen: boolean

  setPage(p: Page): void
  toast(text: string, error?: boolean): void
  loadProfiles(): Promise<void>
  loadSessions(): Promise<void>
  loadUsage(): Promise<void>
  openSession(id: string | undefined): Promise<void>
  activateSession(meta: SessionMeta): void
  onEvent(e: ChatEvent): void
  setLiveOpen(v: boolean): void
  setSidebarOpen(v: boolean): void
}

let toastId = 0

function upsert(list: ChatItem[], item: ChatItem): ChatItem[] {
  const i = list.findIndex((x) => x.id === item.id)
  if (i < 0) {
    const dup = item.kind === 'assistant' || item.kind === 'reasoning' ?
      list.find(x => x.kind === item.kind && 'text' in x && x.text === item.text) : null
    if (dup) return list
    return [...list, item]
  }
  const next = list.slice()
  next[i] = item
  return next
}

export const useStore = create<State>((set, get) => ({
  page: 'chat',
  profiles: [],
  sessions: [],
  transcripts: {},
  status: {},
  permissions: {},
  drafts: {},
  plans: {},
  clocks: {},
  browserLive: {},
  quotes: {},
  setQuote: (sessionId, text) => set((s) => ({ quotes: { ...s.quotes, [sessionId]: text?.trim() || '' } })),
  limits: {},
  spend: {},
  balances: {},
  contexts: {},
  pulls: {},
  toasts: [],
  // on a narrow window the live panel floats over the chat, so it starts closed there
  liveOpen: window.innerWidth >= 1180,
  sidebarOpen: true,

  setPage: (page) => set({ page }),
  setLiveOpen: (liveOpen) => set({ liveOpen }),
  setSidebarOpen: (sidebarOpen) => set({ sidebarOpen }),

  toast: (text, error) => {
    const id = ++toastId
    set((s) => ({ toasts: [...s.toasts, { id, text, error }] }))
    setTimeout(() => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })), error ? 7000 : 3500)
  },

  loadProfiles: async () => {
    set({ profiles: await api.profiles.list() })
  },

  loadSessions: async () => {
    set({ sessions: await api.sessions.list() })
  },

  loadUsage: async () => {
    const list = await api.usage.summary()
    set((s) => ({
      spend: Object.fromEntries(list.map((u) => [u.profileId, { tokens: u.last24h.tokens, costUsd: u.last24h.costUsd }])),
      limits: { ...s.limits, ...Object.fromEntries(list.filter((u) => u.limits).map((u) => [u.profileId, u.limits!])) }
    }))
  },

  openSession: async (id) => {
    set({ activeId: id, page: 'chat' })
    if (id && !get().transcripts[id]) {
      const items = await api.sessions.history(id)
      set((s) => ({ transcripts: { ...s.transcripts, [id]: items } }))
    }
  },

  activateSession: (meta) => set((s) => ({
    sessions: [meta, ...s.sessions.filter((session) => session.id !== meta.id)],
    activeId: meta.id,
    page: 'chat',
    status: { ...s.status, [meta.id]: 'running' },
    transcripts: { ...s.transcripts, [meta.id]: s.transcripts[meta.id] || [] }
  })),

  onEvent: (e) => {
    switch (e.type) {
      case 'item':
        set((s) => ({ transcripts: { ...s.transcripts, [e.sessionId]: upsert(s.transcripts[e.sessionId] || [], e.item) } }))
        return
      case 'delta':
        set((s) => {
          const list = s.transcripts[e.sessionId] || []
          const i = list.findIndex((x) => x.id === e.itemId)
          const next = list.slice()
          if (i >= 0) {
            const it = next[i]
            if (it.kind === 'assistant' || it.kind === 'reasoning') next[i] = { ...it, text: it.text + e.delta }
          } else {
            next.push({ kind: e.kind, id: e.itemId, text: e.delta })
          }
          return { transcripts: { ...s.transcripts, [e.sessionId]: next } }
        })
        return
      case 'status':
        set((s) => ({
          status: { ...s.status, [e.sessionId]: e.status },
          clocks: e.status === 'running' && s.status[e.sessionId] !== 'running' ? { ...s.clocks, [e.sessionId]: { ...s.clocks[e.sessionId], turn: Date.now() } } : s.clocks
        }))
        if (e.status !== 'running') {
          // a finished turn has no pending approvals left
          set((s) => ({ permissions: { ...s.permissions, [e.sessionId]: [] } }))
          void get().loadSessions()
          const profile = get().profiles.find((p) => p.id === get().sessions.find((x) => x.id === e.sessionId)?.profileId)
          if (profile) refreshLimitsSoon(profile)
        }
        return
      case 'meta':
        set((s) => {
          const exists = s.sessions.some((x) => x.id === e.meta.id)
          return { sessions: exists ? s.sessions.map((x) => (x.id === e.meta.id ? { ...x, ...e.meta } : x)) : [e.meta, ...s.sessions] }
        })
        return
      case 'permission':
        set((s) => ({ permissions: { ...s.permissions, [e.sessionId]: [...(s.permissions[e.sessionId] || []), e.request] } }))
        return
      case 'permissionResolved':
        set((s) => ({ permissions: { ...s.permissions, [e.sessionId]: (s.permissions[e.sessionId] || []).filter((r) => r.id !== e.requestId) } }))
        return
      case 'plan':
        set((s) => ({ plans: { ...s.plans, [e.sessionId]: e.steps }, clocks: { ...s.clocks, [e.sessionId]: tick(s.clocks[e.sessionId], s.plans[e.sessionId], e.steps) } }))
        return
      case 'browserLive':
        set((s) => ({ browserLive: e.note ? { note: e.note } : { frame: e.frame ?? s.browserLive.frame, url: e.url, title: e.title } }))
        return
      case 'draft':
        set((s) => ({
          drafts: {
            ...s.drafts,
            [e.sessionId]: { ...(s.drafts[e.sessionId] || {}), [e.toolId]: { toolId: e.toolId, name: e.name, path: e.path, content: e.content, done: e.done, at: Date.now() } }
          }
        }))
        return
      case 'limits':
        set((s) => ({ limits: { ...s.limits, [e.snapshot.profileId]: e.snapshot } }))
        return
      case 'pull':
        set((s) => ({ pulls: { ...s.pulls, [e.tag]: { status: e.status, completed: e.completed, total: e.total, done: e.done, error: e.error } } }))
        return
      case 'update':
        set({ update: e.status })
        return
      case 'context':
        set((s) => ({ contexts: { ...s.contexts, [e.sessionId]: { used: e.used, window: e.window ?? s.contexts[e.sessionId]?.window } } }))
        return
      case 'usage': {
        const u = e.usage
        const tokens = u.inputTokens + u.outputTokens + u.cacheReadTokens + u.cacheWriteTokens
        set((s) => {
          const cur = s.spend[u.profileId] || { tokens: 0, costUsd: 0 }
          return { spend: { ...s.spend, [u.profileId]: { tokens: cur.tokens + tokens, costUsd: cur.costUsd + (u.costUsd || 0) } } }
        })
        return
      }
    }
  }
}))

// After a turn, ask the account for its current 5 h / 7 d limits so the sidebar stays live.
// ponytail: one probe per profile per minute at most; Codex also pushes limits by itself
const lastProbe = new Map<string, number>()

function balanceNote(p: Profile, err: unknown): string {
  if (p.hasCookie && /HTTP 40[13]/.test(errMsg(err))) return tr("Cookie expirat: pune-l din nou în Conturi")
  return `Sold indisponibil (${errMsg(err)})`
}
export function refreshLimitsSoon(p: Profile, force = false): void {
  if (p.local || (!force && Date.now() - (lastProbe.get(p.id) || 0) < 60e3)) return
  if (p.auth === 'endpoint') {
    // pay-as-you-go providers: what is left on the account instead of 5 h / 7 d windows
    if (!p.hasSecret && !p.hasCookie) return
    lastProbe.set(p.id, Date.now())
    api.usage
      .balance(p.id)
      .then((b) => b && useStore.setState((s) => ({ balances: { ...s.balances, [p.id]: b } })))
      // a failed read keeps the row and says why (an expired MiMo cookie, for example) instead of hiding it
      .catch((err) =>
        useStore.setState((s) => ({ balances: { ...s.balances, [p.id]: { ...s.balances[p.id], profileId: p.id, note: balanceNote(p, err), updatedAt: Date.now() } } }))
      )
    return
  }
  if (p.auth !== 'subscription') return
  lastProbe.set(p.id, Date.now())
  api.usage
    .refreshLimits(p.id)
    .then((snap) => snap && useStore.getState().onEvent({ type: 'limits', snapshot: snap }))
    .catch(() => undefined)
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------
export const ENGINE_LABEL = { claude: 'Claude Code', codex: 'Codex', hermes: 'Hermes' } as const

export function fmtTokens(n: number): string {
  if (n >= 1e9) return (n / 1e9).toFixed(1) + tr(' mld')
  if (n >= 1e6) return (n / 1e6).toFixed(1) + tr(' mil')
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'k'
  return String(Math.round(n))
}

export function fmtUsd(n: number): string {
  return n >= 100 ? `$${n.toFixed(0)}` : n >= 1 ? `$${n.toFixed(2)}` : `$${n.toFixed(3)}`
}

export function timeAgo(ms: number): string {
  const s = Math.round((Date.now() - ms) / 1000)
  if (s < 60) return tr('acum')
  if (s < 3600) return `${Math.floor(s / 60)} min`
  if (s < 86400) return `${Math.floor(s / 3600)} h`
  return tr("{n} z", { n: Math.floor(s / 86400) })
}

export function resetIn(ms?: number): string {
  if (!ms) return ''
  const min = Math.ceil((ms - Date.now()) / 60000)
  if (min <= 0) return tr("se resetează acum")
  if (min < 60) return tr("se resetează în {min} min", { min })
  if (min < 24 * 60) return tr("se resetează în {floor} h {v1} min", { floor: Math.floor(min / 60), v1: min % 60 })
  const hours = Math.round(min / 60)
  return tr("se resetează în {floor} z {v1} h", { floor: Math.floor(hours / 24), v1: hours % 24 })
}

export function resetAt(ms?: number): string {
  if (!ms || !Number.isFinite(ms)) return tr("ora resetării indisponibilă")
  return new Date(ms).toLocaleString(dateLocale(), { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
}

/** Status color for a usage percentage (never a series color). */
export function levelColor(pct: number): string {
  if (pct >= 90) return 'var(--critical)'
  if (pct >= 75) return 'var(--serious)'
  if (pct >= 50) return 'var(--warning)'
  return 'var(--good)'
}

export function basename(p: string): string {
  return p.split(/[\\/]/).filter(Boolean).pop() || p
}

export function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
