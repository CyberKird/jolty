import { ChevronDown, ChevronUp, X } from 'lucide-react'
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from 'react'
import type { ChatItem } from '@shared/types'
import { findMatches, offsetsOf, stepMatch } from '@shared/find'
import { tr } from '@shared/i18n'
import { usePresence } from '../usePresence'
import './find.css'

/** Every hit of `query` in the text of `root`, as ranges (a hit split by markup is not found). */
function rangesIn(root: Element, query: string): Range[] {
  const out: Range[] = []
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    for (const at of offsetsOf(n.nodeValue || '', query)) {
      const r = new Range()
      r.setStart(n, at)
      r.setEnd(n, at + query.length)
      out.push(r)
    }
  }
  return out
}

const itemEl = (scroller: HTMLElement, id: string): HTMLElement | null => scroller.querySelector(`[data-item="${CSS.escape(id)}"]`)

/** Find in the open conversation (Ctrl+F). The transcript is searched, not the page: older messages are not in it until they are needed. */
export function FindBar({ items, scroller, start, reveal }: { items: readonly ChatItem[]; scroller: RefObject<HTMLElement | null>; start: number; reveal: (index: number) => void }) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [cur, setCur] = useState(0)
  const input = useRef<HTMLInputElement>(null)
  const { shown, state } = usePresence(open)
  // set by a query or a step: the next layout scrolls to the hit once, so streaming and loading older messages do not pull the view back
  const pending = useRef(false)
  const matches = useMemo(() => (open ? findMatches(items, query) : []), [open, items, query])
  const at = matches.length ? Math.min(cur, matches.length - 1) : 0

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey || e.key.toLowerCase() !== 'f') return
      e.preventDefault()
      setOpen(true)
      requestAnimationFrame(() => {
        input.current?.focus()
        input.current?.select()
      })
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const go = (dir: 1 | -1): void => {
    if (!matches.length) return
    pending.current = true
    setCur(stepMatch(at, matches.length, dir))
  }
  const close = (): void => {
    setOpen(false)
    document.querySelector<HTMLTextAreaElement>('.composer textarea')?.focus()
  }

  // the highlights follow the messages that are on screen; the hit being read has its own colour
  useLayoutEffect(() => {
    const root = scroller.current
    if (!root || !open || !query) return
    const m = matches[at]
    const el = m && m.item >= start ? itemEl(root, items[m.item].id) : null
    const mine = m && el ? rangesIn(el, query) : []
    CSS.highlights.set('find-all', new Highlight(...rangesIn(root, query)))
    CSS.highlights.set('find-current', new Highlight(...(m && mine.length ? [mine[Math.min(m.nth, mine.length - 1)]] : [])))
    return () => {
      CSS.highlights.delete('find-all')
      CSS.highlights.delete('find-current')
    }
  }, [open, query, matches, at, start, items, scroller])

  // bring the hit into view: a message above the window is loaded first, and the layout settles after the first scroll
  useLayoutEffect(() => {
    const root = scroller.current
    const m = matches[at]
    if (!pending.current || !root) return
    if (!m) {
      pending.current = false
      return
    }
    if (m.item < start) return reveal(m.item)
    pending.current = false
    const show = (): void => {
      const first = [...(CSS.highlights.get('find-current') ?? [])][0]
      const target = first instanceof Range ? first.startContainer.parentElement : itemEl(root, items[m.item].id)
      // the chat follows the bottom unless the reader scrolled: this makes the jump count as the reader's
      root.dispatchEvent(new WheelEvent('wheel'))
      target?.scrollIntoView({ block: 'center' })
    }
    show()
    requestAnimationFrame(show)
  }, [matches, at, start, items, scroller, reveal])

  if (!shown) return null
  return (
    <div className="find-anchor">
      <div className="find-bar" data-state={state} role="search">
        <input
          ref={input}
          className="find-input"
          value={query}
          placeholder={tr("Caută în conversație")}
          aria-label={tr("Caută în conversație")}
          onChange={(e) => {
            pending.current = true
            setQuery(e.target.value)
            setCur(0)
          }}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              e.preventDefault()
              e.stopPropagation()
              close()
            } else if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
              e.preventDefault()
              go(e.shiftKey ? -1 : 1)
            }
          }}
        />
        <span className={`find-count ${query && !matches.length ? 'none' : ''}`} aria-live="polite">
          {matches.length ? `${at + 1} / ${matches.length}` : query ? tr("Nicio potrivire") : ''}
        </span>
        <button className="btn ghost small icon" onClick={() => go(-1)} disabled={!matches.length} title={tr("Anterioară (Shift+Enter)")} aria-label={tr("Anterioară (Shift+Enter)")}>
          <ChevronUp size={15} />
        </button>
        <button className="btn ghost small icon" onClick={() => go(1)} disabled={!matches.length} title={tr("Următoarea (Enter)")} aria-label={tr("Următoarea (Enter)")}>
          <ChevronDown size={15} />
        </button>
        <button className="btn ghost small icon" onClick={close} title={tr("Închide (Esc)")} aria-label={tr("Închide (Esc)")}>
          <X size={15} />
        </button>
      </div>
    </div>
  )
}
