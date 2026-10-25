import { useCallback, useLayoutEffect, useRef, useState, type RefObject } from 'react'
import { lowPower } from '../lowpower'

const chunk = (): number => (lowPower() ? 60 : 120)

/**
 * A conversation of thousands of messages is more than a weak PC can lay out: only the last chunk is in the page, and
 * the older ones come in, a chunk at a time, as the reader scrolls up to them. `start` is where the visible part
 * begins in `items`; new messages only add at the end, so what the reader sees does not shift.
 */
export function useWindowedItems(count: number, scroller: RefObject<HTMLElement | null>): { start: number; older: (el: HTMLElement | null) => void } {
  // the length when the conversation first had messages: the window ends there and grows upwards
  const base = useRef(0)
  const [chunks, setChunks] = useState(1)
  if (!base.current && count) base.current = count
  const start = Math.max(0, base.current - chunks * chunk())
  const keep = useRef<{ height: number; top: number } | undefined>(undefined)
  const watcher = useRef<IntersectionObserver | undefined>(undefined)
  const more = useCallback(() => {
    const el = scroller.current
    if (el) keep.current = { height: el.scrollHeight, top: el.scrollTop }
    setChunks((n) => n + 1)
  }, [scroller])
  // the messages that came in above the reader push everything down: put the scroll position back where it was
  useLayoutEffect(() => {
    const el = scroller.current
    const was = keep.current
    keep.current = undefined
    if (el && was) el.scrollTop = was.top + (el.scrollHeight - was.height)
  }, [start, scroller])
  const older = useCallback(
    (el: HTMLElement | null) => {
      watcher.current?.disconnect()
      watcher.current = undefined
      if (!el) return
      // observed again after every chunk: a short chunk can leave the marker in view, and that must load the next one
      watcher.current = new IntersectionObserver((rows) => rows.some((r) => r.isIntersecting) && more(), { rootMargin: '600px 0px 0px 0px' })
      watcher.current.observe(el)
    },
    [more, start]
  )
  return { start, older }
}
