import { create } from 'zustand'
import { flushSync } from 'react-dom'
import type { Clock } from '@shared/eta'
import { TaskBoard } from '@shared/tasks'
import type {
  ChatEvent,
  ChatItem,
  JoltyApi,
  PermissionRequest,
  PlanStep,
  PowerState,
  Profile,
  ProviderBalance,
  RateLimitSnapshot,
  UpdateStatus,
  SessionMeta
} from '@shared/types'
import { dateLocale, tr } from '@shared/i18n'
import { DEFAULT_PLAN } from '@shared/power'
import { preloadPage } from './pageLoaders'
import { exitMs } from './usePresence'
import { lastIndexWhere } from '@shared/last-index'
import type { BackupEntry } from '@shared/backup'

export const api = (window as unknown as { jolty: JoltyApi }).jolty

export type Page = 'chat' | 'import' | 'accounts' | 'local' | 'usage' | 'schedules' | 'skills' | 'system' | 'settings'

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
  /** playing its exit */
  closing?: boolean
}

interface State {
  page: Page
  profiles: Profile[]
  /** false until the first list came back: an empty list before that does not mean a new user */
  profilesLoaded: boolean
  sessions: SessionMeta[]
  activeId?: string
  transcripts: Record<string, ChatItem[]>
  status: Record<string, 'idle' | 'running' | 'error'>
  permissions: Record<string, PermissionRequest[]>
  /** conversations that finished while the user was elsewhere, until opened or dismissed */
  unseen: Record<string, true>
  dismissUnseen(id: string): void
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
  spend7d: Record<string, { tokens: number; costUsd: number }>
  balances: Record<string, ProviderBalance>
  contexts: Record<string, { used: number; window?: number }>
  update?: UpdateStatus
  pulls: Record<string, PullState>
  toasts: Toast[]
  liveOpen: boolean
  sidebarOpen: boolean
  /** "turn the PC off when the work is done" */
  power: PowerState
  /** skills that need attention, for the badge on the sidebar; undefined until the list was read */
  skillsAttention?: number
  setSkillsAttention(n: number | undefined): void
  /** ids of too-big skills whose alert the user hid (kept in localStorage) */
  hiddenSkills: string[]
  hideSkill(id: string, hide: boolean): void
  /** the backup storages and their accounts, for the sidebar and the Account tab */
  backups?: BackupEntry[]
  setBackups(b: BackupEntry[]): void

  setPage(p: Page): void
  toast(text: string, error?: boolean): void
  loadProfiles(): Promise<void>
  /** puts `from` where `to` is (after it when moving down) and saves the order */
  moveProfile(from: string, to: string): Promise<void>
  loadSessions(): Promise<void>
  loadUsage(): Promise<void>
  openSession(id: string | undefined): Promise<void>
  activateSession(meta: SessionMeta): void
  onEvent(e: ChatEvent): void
  setLiveOpen(v: boolean): void
  setSidebarOpen(v: boolean): void
}

let toastId = 0

export { liveRows } from '@shared/live'
export type { LiveRow, LiveState } from '@shared/live'

function upsert(list: ChatItem[], item: ChatItem): ChatItem[] {
  const i = lastIndexWhere(list, (x) => x.id === item.id)
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

/** Page and conversation switches cross-fade the main column (View Transitions); instant with Reduce motion. */
function swapPage(update: () => void): void {
  const doc = document as Document & { startViewTransition?: (cb: () => void) => { finished: Promise<void> } }
  const root = document.documentElement
  if (!doc.startViewTransition || root.classList.contains('reduce-motion')) return update()
  root.classList.add('vt-page')
  void doc
    .startViewTransition(() => flushSync(update))
    .finished.catch(() => undefined)
    .finally(() => root.classList.remove('vt-page'))
}

const HIDDEN_SKILLS = 'jolty:hiddenSkillAlerts'
function readHiddenSkills(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(HIDDEN_SKILLS) || '[]')
    return Array.isArray(v) ? v.filter((x) => typeof x === 'string') : []
  } catch {
    return []
  }
}

export const useStore = create<State>((set, get) => ({
  page: 'chat',
  profiles: [],
  profilesLoaded: false,
  sessions: [],
  transcripts: {},
  status: {},
  permissions: {},
  unseen: {},
  dismissUnseen: (id) => set((s) => (s.unseen[id] ? { unseen: Object.fromEntries(Object.entries(s.unseen).filter(([k]) => k !== id)) as Record<string, true> } : s)),
  drafts: {},
  plans: {},
  clocks: {},
  browserLive: {},
  quotes: {},
  setQuote: (sessionId, text) => set((s) => ({ quotes: { ...s.quotes, [sessionId]: text?.trim() || '' } })),
  limits: {},
  spend: {},
  spend7d: {},
  balances: {},
  contexts: {},
  pulls: {},
  toasts: [],
  // on a narrow window the live panel floats over the chat, so it starts closed there
  power: { armed: false, plan: DEFAULT_PLAN },
  liveOpen: window.innerWidth >= 1180,
  sidebarOpen: true,

  setPage: (page) => {
    if (get().page !== page) void preloadPage(page).then(() => swapPage(() => set({ page })))
  },
  setLiveOpen: (liveOpen) => set({ liveOpen }),
  setSidebarOpen: (sidebarOpen) => set({ sidebarOpen }),
  setSkillsAttention: (skillsAttention) => set({ skillsAttention }),
  setBackups: (backups) => set({ backups }),
  hiddenSkills: readHiddenSkills(),
  hideSkill: (id, hide) =>
    set((s) => {
      const hiddenSkills = hide ? [...new Set([...s.hiddenSkills, id])] : s.hiddenSkills.filter((x) => x !== id)
      try {
        localStorage.setItem(HIDDEN_SKILLS, JSON.stringify(hiddenSkills))
      } catch {
        // the choice lasts until the window closes
      }
      return { hiddenSkills }
    }),

  toast: (text, error) => {
    const id = ++toastId
    set((s) => ({ toasts: [...s.toasts, { id, text, error }] }))
    // it leaves with its exit motion, then goes
    setTimeout(() => {
      set((s) => ({ toasts: s.toasts.map((t) => (t.id === id ? { ...t, closing: true } : t)) }))
      setTimeout(() => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })), exitMs() + 20)
    }, error ? 7000 : 3500)
  },

  loadProfiles: async () => {
    set({ profiles: await api.profiles.list(), profilesLoaded: true })
  },

  moveProfile: async (from, to) => {
    const list = [...get().profiles]
    const i = list.findIndex((p) => p.id === from)
    const j = list.findIndex((p) => p.id === to)
    if (i < 0 || j < 0 || i === j) return
    list.splice(j, 0, list.splice(i, 1)[0])
    set({ profiles: list })
    try {
      await api.profiles.reorder(list.map((p) => p.id))
    } catch (err) {
      get().toast(String(err), true)
      await get().loadProfiles()
    }
  },

  loadSessions: async () => {
    set({ sessions: await api.sessions.list() })
  },

  loadUsage: async () => {
    const list = await api.usage.summary()
    set((s) => ({
      spend: Object.fromEntries(list.map((u) => [u.profileId, { tokens: u.last24h.tokens, costUsd: u.last24h.costUsd }])),
      spend7d: Object.fromEntries(list.map((u) => [u.profileId, { tokens: u.last7d.tokens, costUsd: u.last7d.costUsd }])),
      limits: { ...s.limits, ...Object.fromEntries(list.filter((u) => u.limits && (!s.limits[u.profileId] || u.limits.updatedAt >= s.limits[u.profileId].updatedAt)).map((u) => [u.profileId, u.limits!])) }
    }))
  },

  openSession: async (id) => {
    // a temporary chat ends when the user leaves it: nothing of it stays, here or on disk
    const left = get().sessions.find((x) => x.id === get().activeId && x.temporary && x.id !== id)
    // the history comes first (briefly), so the conversation fades in with its messages instead of filling in afterwards
    const history = id && !get().transcripts[id] ? api.sessions.history(id) : undefined
    if (history) await Promise.race([history.then(() => undefined, () => undefined), new Promise((r) => setTimeout(r, 150))])
    if (get().activeId !== id || get().page !== 'chat') swapPage(() => set({ activeId: id, page: 'chat' }))
    if (id) get().dismissUnseen(id)
    if (left) {
      set((s) => {
        const { [left.id]: _gone, ...transcripts } = s.transcripts
        return { transcripts, sessions: s.sessions.filter((x) => x.id !== left.id) }
      })
      void api.sessions.remove(left.id).catch(() => undefined)
    }
    if (id && !get().transcripts[id]) {
      const items = await (history ?? api.sessions.history(id))
      // the task list of a conversation opened again (after a restart) comes from what it saved
      const steps = get().plans[id] ? undefined : new TaskBoard().replay(items).steps()
      set((s) => ({ transcripts: { ...s.transcripts, [id]: items }, plans: steps?.length ? { ...s.plans, [id]: steps } : s.plans }))
    }
  },

  activateSession: (meta) => {
    const apply = (): void =>
      set((s) => ({
        sessions: [meta, ...s.sessions.filter((session) => session.id !== meta.id)],
        activeId: meta.id,
        page: 'chat',
        status: { ...s.status, [meta.id]: 'running' },
        clocks: { ...s.clocks, [meta.id]: { turn: Date.now() } },
        transcripts: { ...s.transcripts, [meta.id]: s.transcripts[meta.id] || [] }
      }))
    if (get().activeId === meta.id && get().page === 'chat') apply()
    else swapPage(apply)
  },

  onEvent: (e) => {
    switch (e.type) {
      case 'item':
        set((s) => ({ transcripts: { ...s.transcripts, [e.sessionId]: upsert(s.transcripts[e.sessionId] || [], e.item) } }))
        return
      case 'delta':
        set((s) => {
          const list = s.transcripts[e.sessionId] || []
          const i = lastIndexWhere(list, (x) => x.id === e.itemId)
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
      case 'status': {
        const prev = get().status[e.sessionId]
        set((s) => ({
          status: { ...s.status, [e.sessionId]: e.status },
          clocks: e.status === 'running' && s.status[e.sessionId] !== 'running' ? { ...s.clocks, [e.sessionId]: { turn: Date.now() } } : s.clocks
        }))
        if (e.status !== 'running') {
          // a finished turn has no pending approvals left
          set((s) => ({ permissions: { ...s.permissions, [e.sessionId]: [] } }))
          // finished while the user looks at something else: it stays in the Live list until opened
          if (prev === 'running' && (get().activeId !== e.sessionId || get().page !== 'chat')) set((s) => ({ unseen: { ...s.unseen, [e.sessionId]: true } }))
          void get().loadSessions()
          const profile = get().profiles.find((p) => p.id === get().sessions.find((x) => x.id === e.sessionId)?.profileId)
          if (profile) refreshLimitsSoon(profile)
        }
        return
      }
      case 'power':
        set({ power: { armed: e.armed, plan: e.plan, due: e.due, seconds: e.seconds, reason: e.reason } })
        return
      case 'meta':
        set((s) => {
          const exists = s.sessions.some((x) => x.id === e.meta.id)
          if (!exists && e.meta.temporary && s.activeId !== e.meta.id) return s
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
        set((s) => ({ plans: { ...s.plans, [e.sessionId]: e.steps } }))
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
          const week = s.spend7d[u.profileId] || { tokens: 0, costUsd: 0 }
          return {
            spend: { ...s.spend, [u.profileId]: { tokens: cur.tokens + tokens, costUsd: cur.costUsd + (u.costUsd || 0) } },
            spend7d: { ...s.spend7d, [u.profileId]: { tokens: week.tokens + tokens, costUsd: week.costUsd + (u.costUsd || 0) } }
          }
        })
        return
      }
    }
  }
}))

// After a turn, ask the account for its current 5 h / 7 d limits so the sidebar stays live.
// ponytail: one probe per profile per minute at most; Codex also pushes limits by itself
const lastProbe = new Map<string, number>()

function balanceNote(err: unknown): string {
  return `Sold indisponibil (${errMsg(err)})`
}
/** Settles when the read is done (at once when nothing is read), so a refresh button can spin until then. */
export function refreshLimitsSoon(p: Profile, force = false): Promise<void> {
  if (p.local || (!force && Date.now() - (lastProbe.get(p.id) || 0) < 60e3)) return Promise.resolve()
  if (p.auth === 'endpoint') {
    // pay-as-you-go providers: what is left on the account instead of 5 h / 7 d windows
    if (!p.hasSecret && !p.hasCookie) return Promise.resolve()
    lastProbe.set(p.id, Date.now())
    return api.usage
      .balance(p.id)
      .then((b) => void (b && useStore.setState((s) => ({ balances: { ...s.balances, [p.id]: b } }))))
      // Other providers keep an error note; MiMo shows local usage when its console cookie expires.
      .catch((err) => useStore.setState((s) => ({ balances: {
        ...s.balances,
        [p.id]: { profileId: p.id, note: balanceNote(err), updatedAt: Date.now() }
      } })))
  }
  if (p.auth !== 'subscription') return Promise.resolve()
  lastProbe.set(p.id, Date.now())
  return api.usage
    .refreshLimits(p.id)
    .then((snap) => void (snap && useStore.getState().onEvent({ type: 'limits', snapshot: snap })))
    .catch(() => undefined)
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------
export const ENGINE_LABEL = { claude: 'Claude Code', codex: 'Codex', hermes: 'Hermes', opencode: 'OpenCode' } as const

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

const COMPACT_KEY = 'jolty.compactFirst'
/** below this many tokens a compaction costs more than it saves (same number as in main) */
const COMPACT_MIN = 20000

/** Compact before moving a conversation to another account or model: on by default. */
export function compactFirst(): boolean {
  try {
    return localStorage.getItem(COMPACT_KEY) !== '0'
  } catch {
    return true
  }
}

export function setCompactFirst(on: boolean): void {
  try {
    localStorage.setItem(COMPACT_KEY, on ? '1' : '0')
  } catch {
    // a convenience only
  }
}

/**
 * A new account or model reads the whole context with a cold cache, which is the usage spike of a switch.
 * Compacting first, on the model that has the context warm, leaves it a summary to read.
 */
export async function compactBefore(sessionId: string): Promise<void> {
  const { contexts, toast } = useStore.getState()
  if (!compactFirst() || (contexts[sessionId]?.used ?? 0) < COMPACT_MIN) return
  toast(tr("Compactez conversația înainte, ca să nu o recitească tot noul cont sau model."))
  const r = await api.sessions.compactAndWait(sessionId)
  if (r && r.after < r.before) toast(tr("Compactat: de la {before}k la {after}k tokeni.", { before: Math.round(r.before / 1000), after: Math.round(r.after / 1000) }))
}

export function basename(p: string): string {
  return p.split(/[\\/]/).filter(Boolean).pop() || p
}

export function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
