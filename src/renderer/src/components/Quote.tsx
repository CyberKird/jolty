// Replying to a message like in a chat app: select text for a small "Citează" popup (as on
// Android), or use the reply button on a message. The quote waits above the composer and goes out
// as Markdown quote lines in front of the next message.
import { Copy, FileText, Quote as QuoteIcon, Reply, X } from 'lucide-react'
import { useEffect, useState } from 'react'
import { clipQuote as clip } from '@shared/quote'
import { copyText, fragmentMarkdown, isFormatted } from '../copy'
import { useStore } from '../store'
import { tr } from '@shared/i18n'

export const quoteActive = (text: string): void => {
  const id = useStore.getState().activeId
  if (!id) return
  useStore.getState().setQuote(id, clip(text))
  requestAnimationFrame(() => document.querySelector<HTMLTextAreaElement>('.composer textarea')?.focus())
}

/** The popup over selected text in the conversation. */
export function SelectionPopup({ root }: { root: React.RefObject<HTMLElement | null> }) {
  const [at, setAt] = useState<{ x: number; y: number; text: string; md?: string }>()
  useEffect(() => {
    const el = root.current
    if (!el) return
    const read = (): void => {
      const sel = window.getSelection()
      const text = sel?.toString().trim()
      if (!sel || !text || sel.rangeCount === 0 || !el.contains(sel.anchorNode)) return setAt(undefined)
      const r = sel.getRangeAt(0).getBoundingClientRect()
      const frag = sel.getRangeAt(0).cloneContents()
      setAt({ x: r.left + r.width / 2, y: r.top, text, md: isFormatted(frag) ? fragmentMarkdown(frag) : undefined })
    }
    const up = (): void => void setTimeout(read, 0)
    const change = (): void => {
      if (!window.getSelection()?.toString().trim()) setAt(undefined)
    }
    el.addEventListener('mouseup', up)
    el.addEventListener('keyup', up)
    el.addEventListener('scroll', change)
    document.addEventListener('selectionchange', change)
    return () => {
      el.removeEventListener('mouseup', up)
      el.removeEventListener('keyup', up)
      el.removeEventListener('scroll', change)
      document.removeEventListener('selectionchange', change)
    }
  }, [root])
  if (!at) return null
  const done = (): void => {
    window.getSelection()?.removeAllRanges()
    setAt(undefined)
  }
  return (
    // mousedown is held back so clicking the popup does not clear the selection first
    <div className="sel-popup" role="toolbar" aria-label={tr("Text selectat")} style={{ left: at.x, top: at.y }} onMouseDown={(e) => e.preventDefault()}>
      <button
        onClick={() => {
          quoteActive(at.text)
          done()
        }}
      >
        <QuoteIcon size={12} /> {tr("Citează")}
      </button>
      <button
        onClick={(e) => {
          copyText(at.text, e.currentTarget)
          done()
        }}
      >
        <Copy size={12} /> {tr("Copiază")}
      </button>
      {at.md && (
        <button
          onClick={() => {
            copyText(at.md || '', null, tr("Markdown copiat"))
            done()
          }}
        >
          <FileText size={12} /> {tr("Copiază ca Markdown")}
        </button>
      )}
    </div>
  )
}

/** The quote waiting above the composer. */
export function QuoteBar({ sessionId }: { sessionId?: string }) {
  const quote = useStore((s) => (sessionId ? s.quotes[sessionId] : undefined))
  const setQuote = useStore((s) => s.setQuote)
  if (!sessionId || !quote) return null
  return (
    <div className="quote-bar">
      <Reply size={13} aria-hidden />
      <span className="quote-text" title={quote}>
        {quote}
      </span>
      <button onClick={() => setQuote(sessionId, undefined)} aria-label={tr("Renunță la citat")} title={tr("Renunță la citat")}>
        <X size={12} />
      </button>
    </div>
  )
}
