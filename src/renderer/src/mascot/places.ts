import type { ChatItem } from '@shared/types'
import { useStore } from '../store'
import { toolKind } from '../components/Messages'

/** Where Jolty belongs right now, read from the store and the page. */
export type Pose =
  | 'idle' | 'walk' | 'run' | 'jump' | 'fall' | 'land' | 'sit' | 'wave' | 'point' | 'cheer' | 'trip' | 'held' | 'sleep' | 'dash'
  // what he does while the model works, after what it is doing (see activity)
  | 'type' | 'read' | 'think' | 'search' | 'zap' | 'scout'

/** poses that are work: he goes to them at once, even if he was dropped somewhere a moment ago */
export const WORK = new Set<Pose>(['type', 'read', 'think', 'search', 'zap', 'scout', 'point'])

/**
 * The model's current step as something Jolty does: code being written means the laptop, a file read means
 * reading on it, a search a magnifying glass, a command a charge of electricity, the web a look into the
 * distance, and thinking a hand on the chin.
 */
export function activity(items: ChatItem[] | undefined, writing: boolean): { pose: Pose; eyes: Eyes } {
  if (writing) return { pose: 'type', eyes: 'focus' }
  for (let i = (items?.length ?? 0) - 1; i >= 0; i--) {
    const it = items![i]
    if (it.kind === 'user') break
    if (it.kind === 'tool' && it.status === 'running') {
      const k = toolKind(it.name)
      if (k === 'write' || k === 'edit') return { pose: 'type', eyes: 'focus' }
      if (k === 'read') return { pose: 'read', eyes: 'focus' }
      if (k === 'search') return { pose: 'search', eyes: 'focus' }
      if (k === 'run') return { pose: 'zap', eyes: 'focus' }
      if (k === 'web' || it.name.startsWith('mcp__')) return { pose: 'scout', eyes: 'open' }
      return { pose: 'think', eyes: 'focus' }
    }
    if (it.kind === 'reasoning') return { pose: 'think', eyes: 'focus' }
    if (it.kind === 'assistant' && it.text) return { pose: 'type', eyes: 'focus' }
  }
  return { pose: 'think', eyes: 'focus' }
}
export type Eyes = 'open' | 'happy' | 'focus' | 'worried' | 'dizzy' | 'sleepy'

export interface Goal {
  el: Element | null
  at: 'left' | 'right'
  pose: Pose
  eyes: Eyes
  bubble?: string
}

export const FLOORS = '.composer, .permission, .msg-user, .card, .chat-header'

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v))

/** on screen, and inside the visible part of its scroller (messages scroll under the header) */
export function visible(el: Element): DOMRect | null {
  if (!el.isConnected) return null
  const r = el.getBoundingClientRect()
  if (r.width < 70 || r.bottom < 0 || r.top > innerHeight) return null
  const box = el.closest('.messages')?.getBoundingClientRect()
  if (box && (r.top < box.top + 4 || r.top > box.bottom - 8)) return null
  return r
}

export function goal(): Goal {
  const s = useStore.getState()
  const composer = s.page === 'chat' ? document.querySelector('.composer') : null
  const id = s.activeId
  if (s.page === 'chat' && id) {
    const cards = document.querySelectorAll('.permission')
    const card = cards[cards.length - 1]
    if (s.permissions[id]?.length && card && visible(card)) return { el: card, at: 'left', pose: 'point', eyes: 'worried', bubble: '!' }
    if (s.status[id] === 'running') {
      const writing = Object.values(s.drafts[id] || {}).some((d) => !d.done)
      const work = activity(s.transcripts[id], writing)
      // the context window nearly full: he works on, but worried
      const ctx = s.contexts[id]
      if (ctx?.window && ctx.used / ctx.window > 0.85) work.eyes = 'worried'
      return { el: composer, at: 'right', ...work }
    }
  }
  if (s.page !== 'chat') {
    // the other pages: on their first card, doing what the page is about
    const card = [...document.querySelectorAll('.main .card')].find((c) => visible(c)) ?? null
    return { el: card, at: 'right', pose: PAGE_POSE[s.page] ?? 'idle', eyes: 'focus' }
  }
  return { el: composer, at: 'right', pose: 'idle', eyes: 'open' }
}

/** usage and the system check are inspected, settings and schedules thought over, imports read */
const PAGE_POSE: Partial<Record<string, Pose>> = { usage: 'search', system: 'search', settings: 'think', schedules: 'think', local: 'think', import: 'read' }

export function spot(g: Goal): { el: Element | null; x: number; y: number } {
  const r = g.el && visible(g.el)
  if (!r) return { el: null, x: innerWidth - 70, y: innerHeight - 1 }
  const x = g.at === 'right' ? r.right - 46 : r.left + 46
  return { el: g.el, x: clamp(x, r.left + 24, r.right - 24), y: r.top }
}
